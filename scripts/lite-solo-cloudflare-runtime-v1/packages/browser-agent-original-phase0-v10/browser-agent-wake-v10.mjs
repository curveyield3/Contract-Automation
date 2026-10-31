#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { validateStorageState } from './browser-session-state-v1.mjs';

const env = process.env;
const action = env.WAKE_ACTION || 'wake';
const mode = env.WAKE_MODE || 'resume_existing';
const wakeId = env.WAKE_ID || crypto.randomUUID();
const wakeMessage = env.WAKE_MESSAGE || '';
const requestedUrl = env.CHAT_URL || '';
const projectName = env.PROJECT_NAME || '';
const statePath = env.WAKE_RESULT_PATH || '/tmp/browser-agent-wake-result.json';
function sha(text='') {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function bool(v) { return String(v || '').toLowerCase() === 'true'; }

async function importBrowserRuntimeModule(specifier) {
  const runtimeRoot = env.BROWSER_AGENT_RUNTIME_ROOT || '';
  if (!runtimeRoot) return import(specifier);
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const resolved = runtimeRequire.resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

function unwrapRuntimeModule(mod) {
  if (!mod) return {};
  const first = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const second = first.default && typeof first.default === 'object' ? first.default : first;
  return { ...mod, ...first, ...second };
}

async function loadModules() {
  const playwrightMod = await importBrowserRuntimeModule('playwright-core');
  const playwright = unwrapRuntimeModule(playwrightMod);
  const chromium = playwright.chromium;
  if (!chromium || typeof chromium.launch !== 'function') {
    throw new Error('playwright-core chromium launcher unavailable');
  }
  return { chromium };
}

async function firstVisible(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    try { if (await loc.isVisible({ timeout: 800 })) return loc; } catch {}
  }
  return null;
}

async function snapshot(page) {
  const stop = await firstVisible(page, [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button:has-text("Stop generating")'
  ]);
  const composer = await firstVisible(page, [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]'
  ]);
  const assistant = page.locator('[data-message-author-role="assistant"]');
  const user = page.locator('[data-message-author-role="user"]');
  const aCount = await assistant.count().catch(() => 0);
  const uCount = await user.count().catch(() => 0);
  let last = '';
  if (aCount) last = await assistant.nth(aCount - 1).innerText().catch(() => '');
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const conversationUnavailable =
    /Unable to load conversation|Conversation not found|Chat not found|This conversation is unavailable/i.test(bodyText);
  const route = chatRouteInfo(currentUrl);
  const chatViewable =
    route.isChat &&
    !route.isLocal &&
    !!composer &&
    !conversationUnavailable;
  return {
    generating: !!stop,
    composerVisible: !!composer,
    conversationUnavailable,
    chatViewable,
    assistantCount: aCount,
    userCount: uCount,
    lastAssistantHash: sha(last),
    lastAssistantLength: last.length,
    url: currentUrl,
  };
}


async function waitForChatIdle(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const stop = await firstVisible(page, [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop"]',
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")'
    ]);
    if (!stop) {
      await page.waitForTimeout(750);
      const confirm = await firstVisible(page, [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop"]',
        'button[aria-label*="Stop"]',
        'button:has-text("Stop generating")'
      ]);
      if (!confirm) {
        console.log('[github-playwright-v10] chat-idle=' + JSON.stringify({ idle: true, waitedMs: Date.now() - started }));
        return true;
      }
    }
    console.log('[github-playwright-v10] chat-busy-wait=' + JSON.stringify({ waitedMs: Date.now() - started }));
    await page.waitForTimeout(3000);
  }
  throw new Error('Chat remained busy/generating beyond idle wait timeout');
}

async function ensureComposer(page) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]'
  ];

  const deadline = Date.now() + 30000;
  let composer = await firstVisible(page, selectors);
  while (!composer && Date.now() < deadline) {
    await page.waitForTimeout(1000);
    composer = await firstVisible(page, selectors);
  }
  if (composer) return composer;

  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const loginPrompt = /\bLog in\b|\bSign up\b|Continue with Google|Welcome back/i.test(bodyText);
  const humanChallenge =
    /Verify you are human|Checking your browser|Just a moment|Cloudflare|security challenge/i.test(bodyText) ||
    /Just a moment|Cloudflare/i.test(title);
  const conversationUnavailable = /Unable to load conversation|Conversation not found|Chat not found|This conversation is unavailable/i.test(bodyText);
  const textareaCount = await page.locator('textarea').count().catch(() => 0);
  const editableCount = await page.locator('[contenteditable="true"]').count().catch(() => 0);

  throw new Error(
    'ChatGPT composer not found after 30s' +
    ' (url=' + currentUrl +
    ', title=' + JSON.stringify(title) +
    ', loginPrompt=' + loginPrompt +
    ', humanChallenge=' + humanChallenge +
    ', conversationUnavailable=' + conversationUnavailable +
    ', textareaCount=' + textareaCount +
    ', editableCount=' + editableCount + ')'
  );
}

async function waitForAssistantResponse(page, before, timeoutMs) {
  const started = Date.now();
  let current = await snapshot(page);
  const changed = () =>
    current.generating ||
    current.assistantCount > before.assistantCount ||
    (current.lastAssistantHash && current.lastAssistantHash !== before.lastAssistantHash);
  if (changed()) return { responded: true, waitedMs: Date.now() - started, snapshot: current };
  while (Date.now() - started < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - started);
    await page.waitForTimeout(Math.min(5000, Math.max(250, remaining)));
    current = await snapshot(page);
    if (changed()) return { responded: true, waitedMs: Date.now() - started, snapshot: current };
  }
  return { responded: false, waitedMs: Date.now() - started, snapshot: current };
}

function randomDelayMs(minMs, maxMs) {
  const min = Math.ceil(minMs);
  const max = Math.floor(maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanActionPause(page) {
  await page.waitForTimeout(randomDelayMs(300, 1500));
}

async function humanTypingPause(page, char = '') {
  let min = 90;
  let max = 130;
  if (/\s/.test(char)) {
    min = 55;
    max = 95;
  }
  if (char === '\n') {
    min = 140;
    max = 230;
  }
  if (/[.!?,;:]/.test(char)) {
    min = 145;
    max = 230;
  }
  await page.waitForTimeout(randomDelayMs(min, max));
}

function normalizeVisibleText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

async function x11Key(args, label = 'x11-key') {
  await new Promise((resolve, reject) => {
    const child = spawn('xdotool', args, {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(label + ' failed: ' + stderr.trim())));
  });
}

async function runCapture(command, args = [], options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      : reject(new Error(command + ' failed (' + code + '): ' + stderr.trim())));
  });
}

async function x11Capture(args, label = 'x11-command') {
  try {
    return await runCapture('xdotool', args, { env: { DISPLAY: process.env.DISPLAY || ':99' } });
  } catch (error) {
    throw new Error(label + ' failed: ' + error.message);
  }
}

async function humanX11TypeText(page, text) {
  const value = String(text);
  for (const char of value) {
    if (char === '\n') {
      await x11Key(['key', '--clearmodifiers', 'shift+Return'], 'x11-line-break');
    } else {
      await x11Key(['type', '--clearmodifiers', '--delay', '0', char], 'x11-type-character');
    }
    await humanTypingPause(page, char);
  }
}

async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Normal Chrome CDP endpoint did not become ready');
}

async function saveNormalChromeEvidence(page, label, extra = {}) {
  const dir = '/tmp/browser-wake-evidence-v1';
  await fs.mkdir(dir, { recursive: true });
  const safe = String(label).replace(/[^A-Za-z0-9._-]+/g, '-');
  await page.screenshot({ path: path.join(dir, safe + '.png'), fullPage: true }).catch(() => {});
  const bodyText = await page.locator('body').innerText().catch(() => '');
  await fs.writeFile(path.join(dir, safe + '.json'), JSON.stringify({
    label,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyTail: bodyText.slice(-6000),
    ...extra
  }, null, 2) + '\n', 'utf8');
}

async function runNormalChromeExistingWake(chromium) {
  if (!env.CHATGPT_STORAGE_STATE_B64) throw new Error('CHATGPT_STORAGE_STATE_B64 is required');
  let storage;
  try {
    storage = JSON.parse(Buffer.from(env.CHATGPT_STORAGE_STATE_B64, 'base64').toString('utf8'));
    if (!validateStorageState(storage)) throw new Error('invalid storage state');
  } catch {
    throw new Error('CHATGPT_STORAGE_STATE_B64 is invalid');
  }

  const requestedRoute = chatRouteInfo(requestedUrl);
  if (!requestedRoute.isChat || requestedRoute.isLocal) {
    throw new Error('normal Chrome wake requires a durable root or Project-scoped ChatGPT conversation URL');
  }

  const profileDir = '/tmp/curveyield-normal-chrome-profile-v1';
  await fs.rm(profileDir, { recursive: true, force: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'First Run'), '', 'utf8');

  const chromeLookup = await runCapture('bash', ['-lc', 'command -v google-chrome || command -v google-chrome-stable']);
  const chromePath = chromeLookup.stdout.split(/\r?\n/).filter(Boolean)[0];
  if (!chromePath) throw new Error('System Google Chrome executable was not found');

  const port = 9222;
  console.log('[normal-chrome-v1] launching system Chrome directly; no Playwright launch, no headless flag, no enable-automation flag');
  const chromeProcess = spawn(chromePath, [
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    'about:blank'
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let chromeStderr = '';
  chromeProcess.stderr?.on('data', chunk => { chromeStderr += chunk.toString(); });

  let browser;
  try {
    await waitForCdp(port, 30000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw new Error('Expected one normal Chrome browser context');
    const context = contexts[0];
    await context.addCookies(storage.cookies || []);
    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    await x11Key(['key', '--clearmodifiers', 'alt+F10'], 'x11-maximize-window');
    await page.waitForTimeout(randomDelayMs(700, 1200));

    await x11Key(['key', '--clearmodifiers', 'ctrl+l'], 'x11-address-bar');
    await page.waitForTimeout(randomDelayMs(180, 320));
    await humanX11TypeText(page, requestedUrl);
    await x11Key(['key', '--clearmodifiers', 'Return'], 'x11-navigate');
    await page.waitForTimeout(18000);

    const webdriverBefore = await page.evaluate(() => navigator.webdriver).catch(() => 'unavailable');
    console.log('[normal-chrome-v1] navigator.webdriver=' + JSON.stringify(webdriverBefore));
    await saveNormalChromeEvidence(page, '10-normal-chrome-loaded-v1', {
      cookieCountApplied: (storage.cookies || []).length,
      storageOriginCountNotInjected: (storage.origins || []).length,
      navigatorWebdriver: webdriverBefore
    });

    if (action === 'observe') {
      await page.waitForTimeout(12000);
      await saveNormalChromeEvidence(page, '14-normal-chrome-observe-existing-v1', {
        reason: 'read-only existing-chat state check',
        navigatorWebdriver: webdriverBefore
      });
      const result = {
        ok: true,
        provider: 'normal-system-chrome-x11',
        action,
        wakeId,
        posted: false,
        navigatorWebdriver: webdriverBefore,
        chatUrl: requestedUrl,
        verification: 'read-only-visible-state'
      };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      return result;
    }

    const geometry = await x11Capture(['getdisplaygeometry'], 'x11-display-geometry');
    const [widthText, heightText] = geometry.stdout.trim().split(/\s+/);
    const width = Number.parseInt(widthText, 10);
    const height = Number.parseInt(heightText, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Could not determine X11 display geometry');

    const composerX = Math.round(width * 0.63);
    const composerY = Math.round(height - 72);
    await x11Key(['mousemove', '--sync', String(composerX), String(composerY)], 'x11-composer-move');
    await page.waitForTimeout(randomDelayMs(180, 360));
    await x11Key(['click', '1'], 'x11-composer-click');
    await page.waitForTimeout(randomDelayMs(250, 450));

    console.log('[normal-chrome-v1] wake-entry=OS-X11-skilled-typist');
    await humanX11TypeText(page, wakeMessage);
    await saveNormalChromeEvidence(page, '11-normal-chrome-before-send-v1', {
      composerClick: { x: composerX, y: composerY }
    });

    await page.waitForTimeout(randomDelayMs(350, 700));
    console.log('[normal-chrome-v1] send=OS-X11-Return');
    await x11Key(['key', '--clearmodifiers', 'Return'], 'x11-send-return');
    await page.waitForTimeout(15000);
    const bodyAfterSend = await page.locator('body').innerText().catch(() => '');
    const normalizedBody = normalizeVisibleText(bodyAfterSend);
    const marker = normalizeVisibleText(wakeMessage).slice(0, 120);
    const persisted = marker.length > 0 && normalizedBody.includes(marker);
    const cloudflareChallenge = /cloudflare_challenge|Verify you are human|Checking your browser|Just a moment/i.test(bodyAfterSend);
    const assistantActivity = /Fetching Skills|Inspected GitHub|ChatGPT said:|Stop generating/i.test(bodyAfterSend);
    await saveNormalChromeEvidence(page, '12-normal-chrome-after-send-v2', {
      persisted,
      cloudflareChallenge,
      assistantActivity,
      marker
    });

    const result = {
      ok: persisted && !cloudflareChallenge,
      provider: 'normal-system-chrome-x11',
      action,
      wakeId,
      posted: persisted,
      persisted,
      cloudflareChallenge,
      assistantActivity,
      navigatorWebdriver: webdriverBefore,
      chatUrl: requestedUrl,
      verification: 'visible-post-send-state-no-reload'
    };
    await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    if (!result.ok) {
      throw new Error('Normal Chrome wake did not persist cleanly after human reload: ' + JSON.stringify({ persisted, cloudflareChallenge }));
    }
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!chromeProcess.killed) chromeProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 800));
    if (!chromeProcess.killed) chromeProcess.kill('SIGKILL');
    if (chromeStderr.trim()) console.log('[normal-chrome-v1] chrome-stderr-tail=' + JSON.stringify(chromeStderr.slice(-1200)));
  }
}

async function humanPointerHover(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanActionPause(page);
  const box = await locator.boundingBox();
  if (!box) throw new Error('Visible hover target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await humanActionPause(page);
}

async function humanShortPointerClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanActionPause(page);
  const box = await locator.boundingBox();
  if (!box) throw new Error('Visible short-click target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  await page.waitForTimeout(randomDelayMs(120, 280));
  await page.mouse.down();
  await page.waitForTimeout(randomDelayMs(70, 160));
  await page.mouse.up();
  await humanActionPause(page);
}

async function humanPointerClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanActionPause(page);
  await locator.hover().catch(() => {});
  await humanActionPause(page);
  const box = await locator.boundingBox();
  if (!box) throw new Error('Visible control has no clickable bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 12 });
  await humanActionPause(page);
  await page.mouse.down();
  await page.waitForTimeout(randomDelayMs(300, 700));
  await page.mouse.up();
  await humanActionPause(page);
}

async function humanTypeInto(page, locator, text) {
  await humanPointerClick(page, locator);
  const current = await locator.inputValue().catch(async () => {
    return await locator.innerText().catch(() => '');
  });
  if (current) {
    await x11Key(['key', '--clearmodifiers', 'ctrl+a'], 'x11-select-all');
    await page.waitForTimeout(randomDelayMs(90, 160));
    await x11Key(['key', '--clearmodifiers', 'BackSpace'], 'x11-backspace');
    await page.waitForTimeout(randomDelayMs(120, 220));
  }
  const value = String(text);
  console.log('[github-playwright-v10] text-entry-strategy=human-x11-skilled-typist-per-character length=' + value.length);
  for (const char of value) {
    if (char === '\n') {
      await x11Key(['key', '--clearmodifiers', 'shift+Return'], 'x11-line-break');
    } else {
      await x11Key(['type', '--clearmodifiers', '--delay', '0', char], 'x11-type-character');
    }
    await humanTypingPause(page, char);
  }
  await humanActionPause(page);
}

async function findVisibleSidebarSurface(page) {
  const candidates = page.locator('nav, aside, [data-testid*="sidebar" i], [class*="sidebar" i]');
  const count = Math.min(await candidates.count().catch(() => 0), 40);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.x <= 420 && box.width <= 520 && box.height >= 280) return candidate;
  }
  return null;
}

async function humanScrollSidebarForProjects(page) {
  const projects = page.getByText('Projects', { exact: true }).first();
  if (await projects.isVisible().catch(() => false)) return projects;

  const sidebar = await findVisibleSidebarSurface(page);
  if (!sidebar) return null;

  await sidebar.hover().catch(() => {});
  await humanActionPause(page);

  // A person can arrive with the sidebar scrolled anywhere. First move toward
  // the top, then scan downward until the Projects title appears.
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, -randomDelayMs(500, 900));
    await humanActionPause(page);
    if (await projects.isVisible().catch(() => false)) return projects;
  }
  for (let i = 0; i < 14; i += 1) {
    await page.mouse.wheel(0, randomDelayMs(350, 700));
    await humanActionPause(page);
    if (await projects.isVisible().catch(() => false)) return projects;
  }
  return null;
}

async function ensureSidebarOpenForProject(page) {
  const projects = page.getByText('Projects', { exact: true }).first();
  if (await projects.isVisible().catch(() => false)) {
    console.log('[github-playwright-v10] project-flow=projects-already-visible');
    return projects;
  }

  // First treat the sidebar as already open and human-scroll it. The normal UI
  // can have Projects below the fold even when no sidebar-open action is needed.
  const existingSidebarProjects = await humanScrollSidebarForProjects(page);
  if (existingSidebarProjects) {
    console.log('[github-playwright-v10] project-flow=projects-found-by-sidebar-scroll');
    return existingSidebarProjects;
  }

  const open = await firstVisible(page, [
    'button[data-testid="open-sidebar-button"]',
    'button[aria-label="Open sidebar"]',
    'button[aria-label*="Open sidebar" i]',
    'button[aria-label*="Show sidebar" i]'
  ]);

  if (!open) {
    throw new Error('Projects section was not visible and no physical Open-sidebar control was found');
  }

  console.log('[github-playwright-v10] project-flow=open-sidebar-control-visible');
  await humanPointerClick(page, open);
  console.log('[github-playwright-v10] project-flow=open-sidebar-clicked');
  await humanActionPause(page);

  const found = await humanScrollSidebarForProjects(page);
  if (!found) {
    throw new Error('Projects section could not be found after opening and human-scrolling the visible sidebar');
  }
  console.log('[github-playwright-v10] project-flow=projects-found-after-opening-sidebar');
  return found;
}


async function findProjectsPlusAfterHover(page, projects) {
  let region = projects;
  for (let depth = 0; depth < 4; depth += 1) {
    region = region.locator('xpath=..');
    const candidates = region.locator('button, [role="button"]');
    const count = Math.min(await candidates.count().catch(() => 0), 12);
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const attrs = [
        await candidate.innerText().catch(() => ''),
        await candidate.getAttribute('aria-label').catch(() => ''),
        await candidate.getAttribute('title').catch(() => ''),
        await candidate.getAttribute('data-testid').catch(() => '')
      ].filter(Boolean).join(' ');
      const looksOverflow = /more|overflow|menu|options|ellipsis|\.\.\.|⋯/i.test(attrs);
      const looksPlus = /add|plus|create|new|M12 5v14|M5 12h14|<line[^>]+x1=["']12["'][^>]+y1=["']5/i.test(attrs);
      if (!looksOverflow && looksPlus) return candidate;
    }
  }
  return null;
}

async function findVisibleProjectCreateButton(page) {
  const buttons = page.getByRole('button', { name: /^Create project$/i });
  const count = Math.min(await buttons.count().catch(() => 0), 8);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (await button.isVisible().catch(() => false)) return button;
  }

  // Visible-text fallback for UI variants whose Create project control is not
  // exposed with button semantics. Clicking the visible label is still a normal
  // human pointer action on the rendered control.
  const labels = page.getByText(/^Create project$/i, { exact: true });
  const labelCount = Math.min(await labels.count().catch(() => 0), 8);
  for (let i = 0; i < labelCount; i += 1) {
    const label = labels.nth(i);
    if (await label.isVisible().catch(() => false)) return label;
  }
  return null;
}

async function findEnabledProjectCreateButton(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttons = page.getByRole('button', { name: /^Create project$/i });
    const count = Math.min(await buttons.count().catch(() => 0), 8);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      const visible = await button.isVisible().catch(() => false);
      const enabled = visible ? await button.isEnabled().catch(() => false) : false;
      if (visible && enabled) return button;
    }

    const labels = page.getByText(/^Create project$/i, { exact: true });
    const labelCount = Math.min(await labels.count().catch(() => 0), 8);
    for (let i = 0; i < labelCount; i += 1) {
      const label = labels.nth(i);
      if (!await label.isVisible().catch(() => false)) continue;
      const button = label.locator('xpath=ancestor-or-self::button[1]');
      const visible = await button.isVisible().catch(() => false);
      const enabled = visible ? await button.isEnabled().catch(() => false) : false;
      if (visible && enabled) return button;
    }

    await page.waitForTimeout(500);
  }
  return null;
}

async function findProjectNameEditorFromVisibleCreateSurface(page) {
  // Start from the visible Project-name editor, then find the Create-project
  // control inside that editor's own rendered ancestor surface. This prevents
  // duplicate/stale Create controls elsewhere on the page from being paired
  // with the active modal.
  const labelledEditors = page.getByLabel(/^Project name$/i);
  const labelledCount = Math.min(await labelledEditors.count().catch(() => 0), 8);
  for (let i = 0; i < labelledCount; i += 1) {
    const editor = labelledEditors.nth(i);
    if (!await editor.isVisible().catch(() => false)) continue;

    let region = editor;
    for (let depth = 0; depth < 7; depth += 1) {
      region = region.locator('xpath=..');

      const buttons = region.getByRole('button', { name: /^Create project$/i });
      const buttonCount = Math.min(await buttons.count().catch(() => 0), 8);
      for (let j = 0; j < buttonCount; j += 1) {
        const button = buttons.nth(j);
        if (await button.isVisible().catch(() => false)) {
          return { create: button, editor, surface: region };
        }
      }

      const labels = region.getByText(/^Create project$/i, { exact: true });
      const labelCount = Math.min(await labels.count().catch(() => 0), 8);
      for (let j = 0; j < labelCount; j += 1) {
        const label = labels.nth(j);
        if (!await label.isVisible().catch(() => false)) continue;
        const button = label.locator('xpath=ancestor-or-self::button[1]');
        if (await button.isVisible().catch(() => false)) {
          return { create: button, editor, surface: region };
        }
      }
    }
  }

  // Fallback for UI variants where the Project-name editor is not labelled:
  // start from each visible Create-project control and only accept an editor
  // found inside that same local ancestor surface.
  const createCandidates = page.getByRole('button', { name: /^Create project$/i });
  const createCount = Math.min(await createCandidates.count().catch(() => 0), 8);
  for (let i = 0; i < createCount; i += 1) {
    const create = createCandidates.nth(i);
    if (!await create.isVisible().catch(() => false)) continue;

    let region = create;
    for (let depth = 0; depth < 6; depth += 1) {
      region = region.locator('xpath=..');

      const textboxes = region.getByRole('textbox');
      const textboxCount = Math.min(await textboxes.count().catch(() => 0), 8);
      for (let j = 0; j < textboxCount; j += 1) {
        const editor = textboxes.nth(j);
        if (await editor.isVisible().catch(() => false)) {
          return { create, editor, surface: region };
        }
      }

      const editables = region.locator('input, textarea, [contenteditable="true"]');
      const editableCount = Math.min(await editables.count().catch(() => 0), 8);
      for (let j = 0; j < editableCount; j += 1) {
        const editor = editables.nth(j);
        if (await editor.isVisible().catch(() => false)) {
          return { create, editor, surface: region };
        }
      }
    }
  }

  return { create: null, editor: null, surface: null };
}

function escapeRegExp(text) {
  const specials = '\\^$.*+?()[]{}|';
  let escaped = '';
  for (const char of String(text)) {
    escaped += specials.includes(char) ? '\\' + char : char;
  }
  return escaped;
}

async function findProjectLandingComposer(page, name) {
  const cue = 'New chat in ' + name;
  const cuePattern = new RegExp('^' + escapeRegExp(cue) + '$', 'i');

  // Use the exact human-visible Project-specific new-chat cue shown on the
  // Project landing page. Never infer Project context from the homepage composer.
  const placeholderComposer = page.getByPlaceholder(cuePattern).first();
  if (await placeholderComposer.isVisible().catch(() => false)) return placeholderComposer;

  const visibleCue = page.getByText(cuePattern, { exact: true }).first();
  if (!await visibleCue.isVisible().catch(() => false)) return null;

  let region = visibleCue;
  for (let depth = 0; depth < 6; depth += 1) {
    region = region.locator('xpath=..');

    const textboxes = region.getByRole('textbox');
    const textboxCount = Math.min(await textboxes.count().catch(() => 0), 8);
    for (let i = 0; i < textboxCount; i += 1) {
      const candidate = textboxes.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }

    const editables = region.locator('textarea, [contenteditable="true"]');
    const editableCount = Math.min(await editables.count().catch(() => 0), 8);
    for (let i = 0; i < editableCount; i += 1) {
      const candidate = editables.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }

  return null;
}

async function findVisibleExactProjectEntry(page, projectsTitle, name) {
  const projectsBox = await projectsTitle.boundingBox().catch(() => null);
  if (!projectsBox) return null;

  const chatsTitle = page.getByText('Chats', { exact: true }).first();
  const chatsVisible = await chatsTitle.isVisible().catch(() => false);
  const chatsBox = chatsVisible ? await chatsTitle.boundingBox().catch(() => null) : null;

  const matches = page.getByText(name, { exact: true });
  const count = Math.min(await matches.count().catch(() => 0), 20);
  for (let i = 0; i < count; i += 1) {
    const candidate = matches.nth(i);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;

    const inLeftSidebar = box.x <= 460;
    const belowProjects = box.y >= projectsBox.y;
    const aboveChats = !chatsBox || box.y < chatsBox.y;
    if (inLeftSidebar && belowProjects && aboveChats) return candidate;
  }

  return null;
}

async function recoverExistingProjectExactHumanFlow(page, name) {
  const projects = await ensureSidebarOpenForProject(page);
  const existing = await findVisibleExactProjectEntry(page, projects, name);
  if (!existing) return null;

  const beforeUrl = page.url();
  await humanPointerClick(page, existing);
  await page.waitForTimeout(randomDelayMs(3000, 5000));

  let projectUrl = page.url();
  if (projectUrl === beforeUrl) {
    await page.waitForTimeout(randomDelayMs(2000, 3500));
    projectUrl = page.url();
  }
  if (projectUrl === beforeUrl) {
    throw new Error('Existing exact-name Project did not navigate to its Project URL after a short visible wait');
  }

  const composer = await ensureComposer(page);
  console.log('[github-playwright-v10] project-recovered-visible=' + JSON.stringify({ projectName: name, url: projectUrl }));
  return { projectName: name, url: projectUrl, composer, recoveredExisting: true };
}

async function findSendControlNearComposer(page, composer) {
  if (composer) {
    let region = composer;
    for (let depth = 0; depth < 5; depth += 1) {
      region = region.locator('xpath=..');
      const send = await firstVisible(region, [
        'button[data-testid="send-button"]',
        'button[data-testid="composer-submit-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send"]',
        'button[aria-label*="Send"]'
      ]);
      if (send) return send;
    }
  }

  return firstVisible(page, [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[aria-label*="Send"]'
  ]);
}

async function createProjectExactHumanFlow(page, name) {
  if (!name) throw new Error('PROJECT_NAME is required for project_wake');

  const recovered = await recoverExistingProjectExactHumanFlow(page, name);
  if (recovered) return recovered;

  const projects = await ensureSidebarOpenForProject(page);
  await humanActionPause(page);
  if (!await projects.isVisible().catch(() => false)) {
    throw new Error('Visible Projects section title was not found');
  }

  console.log('[github-playwright-v10] project-flow=projects-visible');
  await humanPointerHover(page, projects);
  console.log('[github-playwright-v10] project-flow=projects-human-hover-complete');

  const plus = await findProjectsPlusAfterHover(page, projects);
  if (!plus) throw new Error('Plus control did not appear to the right of Projects after human pointer hover');
  console.log('[github-playwright-v10] project-flow=projects-plus-visible');
  await humanPointerClick(page, plus);
  console.log('[github-playwright-v10] project-flow=projects-plus-clicked');

  // The Create project modal takes a moment to render in the normal UI.
  await page.waitForTimeout(randomDelayMs(2500, 4500));
  let controls = await findProjectNameEditorFromVisibleCreateSurface(page);
  if (!controls.create || !controls.editor) {
    const pendingCreate = page.getByRole('button', { name: /^Create project$/i }).first();
    await pendingCreate.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    controls = await findProjectNameEditorFromVisibleCreateSurface(page);
  }
  if (!controls.create) throw new Error('Create Project button was not found on the visible Create-project surface');
  if (!controls.editor) throw new Error('Project-name editor was not found on the visible Create-project surface');

  console.log('[github-playwright-v10] project-flow=create-surface-visible');
  await humanTypeInto(page, controls.editor, name);
  console.log('[github-playwright-v10] project-flow=project-name-human-typed');
  const observedProjectName = await controls.editor.inputValue().catch(async () => {
    return await controls.editor.innerText().catch(() => '');
  });
  if (String(observedProjectName).trim() !== String(name).trim()) {
    throw new Error('Project-name editor did not contain the exact requested Project name before Create');
  }
  console.log('[github-playwright-v10] project-flow=project-name-verified');

  // Keep the Create target bound to the same visible Create-project surface
  // that supplied the Project-name editor. Do not re-search the whole page after
  // typing, because current ChatGPT UI variants can expose duplicate/stale
  // "Create project" controls outside the active surface.
  await page.waitForTimeout(randomDelayMs(1200, 2500));
  let surfaceCreate = controls.create;
  const surfaceCreateButton = controls.create.locator('xpath=ancestor-or-self::button[1]');
  if (await surfaceCreateButton.isVisible().catch(() => false)) {
    surfaceCreate = surfaceCreateButton;
  }
  const enableDeadline = Date.now() + 8000;
  let surfaceCreateEnabled = false;
  while (Date.now() < enableDeadline) {
    const visible = await surfaceCreate.isVisible().catch(() => false);
    surfaceCreateEnabled = visible ? await surfaceCreate.isEnabled().catch(() => false) : false;
    if (visible && surfaceCreateEnabled) break;
    await page.waitForTimeout(500);
  }
  if (!surfaceCreateEnabled) {
    throw new Error('Same-surface Create project control did not become visibly enabled after typing the Project name');
  }

  const beforeCreateUrl = page.url();
  console.log('[github-playwright-v10] project-flow=create-button-same-surface-enabled');
  const finalCreateBox = await surfaceCreate.boundingBox();
  if (!finalCreateBox) throw new Error('Final Create-project control has no clickable bounding box');
  const finalCreateX = finalCreateBox.x + finalCreateBox.width / 2;
  const finalCreateY = finalCreateBox.y + finalCreateBox.height / 2;
  const finalHit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    const button = element?.closest?.('button');
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      text: (element.textContent || '').trim().slice(0, 200),
      role: element.getAttribute('role') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      pointerEvents: style.pointerEvents,
      closestButtonText: (button?.textContent || '').trim().slice(0, 200),
      closestButtonDisabled: button ? Boolean(button.disabled) : null,
      closestButtonAriaDisabled: button?.getAttribute('aria-disabled') || ''
    };
  }, { x: finalCreateX, y: finalCreateY });
  console.log('[github-playwright-v10] project-flow=create-button-hit-target=' + JSON.stringify({
    x: finalCreateX,
    y: finalCreateY,
    hit: finalHit
  }));

  const createEvidenceDir = '/tmp/browser-project-create-evidence-v1';
  await fs.mkdir(createEvidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(createEvidenceDir, 'click-target-evidence-v1.json'),
    JSON.stringify({
      projectName: name,
      pageUrl: page.url(),
      clickCenter: { x: finalCreateX, y: finalCreateY },
      createButtonBox: finalCreateBox,
      hitTarget: finalHit
    }, null, 2) + '\n'
  );
  await page.screenshot({
    path: path.join(createEvidenceDir, '01-before-create-v1.png'),
    fullPage: true
  });
  await surfaceCreate.screenshot({
    path: path.join(createEvidenceDir, '02-create-button-target-v1.png')
  });
  console.log('[github-playwright-v10] project-flow=before-create-screenshots-saved');

  await page.mouse.move(finalCreateX, finalCreateY, { steps: 12 });
  await humanActionPause(page);

  // Final Create activation must mimic the exact human recovery sequence:
  // single click -> 0.2-0.5s -> double click -> 0.2-0.5s -> long click.
  await page.mouse.click(finalCreateX, finalCreateY, { delay: randomDelayMs(70, 150) });
  console.log('[github-playwright-v10] project-flow=create-button-human-single-clicked');

  await page.waitForTimeout(randomDelayMs(200, 500));
  if (page.url() === beforeCreateUrl) {
    await page.mouse.click(finalCreateX, finalCreateY, {
      clickCount: 2,
      delay: randomDelayMs(70, 150)
    });
    console.log('[github-playwright-v10] project-flow=create-button-human-double-clicked');
  }

  await page.waitForTimeout(randomDelayMs(200, 500));
  if (page.url() === beforeCreateUrl) {
    await page.mouse.move(finalCreateX, finalCreateY, { steps: 6 });
    await page.mouse.down();
    await page.waitForTimeout(randomDelayMs(550, 900));
    await page.mouse.up();
    console.log('[github-playwright-v10] project-flow=create-button-human-long-clicked');
  }

  await humanActionPause(page);

  await page.screenshot({
    path: path.join(createEvidenceDir, '03-immediately-after-create-sequence-v1.png'),
    fullPage: true
  });
  console.log('[github-playwright-v10] project-flow=immediate-after-create-screenshot-saved');

  await page.waitForTimeout(10000);
  await page.screenshot({
    path: path.join(createEvidenceDir, '04-ten-seconds-after-create-sequence-v1.png'),
    fullPage: true
  });
  console.log('[github-playwright-v10] project-flow=ten-seconds-after-create-screenshot-saved');

  await page.waitForTimeout(1000);
  const postClickCreate = page.getByRole('button', { name: /^Create project$/i }).first();
  const postClickCreateVisible = await postClickCreate.isVisible().catch(() => false);
  const postClickCreateEnabled = postClickCreateVisible ? await postClickCreate.isEnabled().catch(() => false) : false;
  const postClickEditorVisible = await controls.editor.isVisible().catch(() => false);
  const postClickEditorValue = postClickEditorVisible
    ? await controls.editor.inputValue().catch(async () => await controls.editor.innerText().catch(() => ''))
    : '';
  const createControlText = (await surfaceCreate.innerText().catch(() => '')).trim();
  const createControlAria = (await surfaceCreate.getAttribute('aria-label').catch(() => '')) || '';
  const createControlTitle = (await surfaceCreate.getAttribute('title').catch(() => '')) || '';
  const createControlBox = await surfaceCreate.boundingBox().catch(() => null);
  const createSurfaceText = controls.surface
    ? (await controls.surface.innerText().catch(() => '')).trim().slice(0, 1500)
    : '';
  const alertTexts = [];
  const alerts = page.locator('[role="alert"], [aria-live="assertive"]');
  const alertCount = Math.min(await alerts.count().catch(() => 0), 8);
  for (let i = 0; i < alertCount; i += 1) {
    const alert = alerts.nth(i);
    if (!await alert.isVisible().catch(() => false)) continue;
    const text = (await alert.innerText().catch(() => '')).trim();
    if (text) alertTexts.push(text.slice(0, 500));
  }
  console.log('[github-playwright-v10] project-flow=post-create-click-state=' + JSON.stringify({
    url: page.url(),
    createVisible: postClickCreateVisible,
    createEnabled: postClickCreateEnabled,
    editorVisible: postClickEditorVisible,
    editorValue: postClickEditorValue,
    createControlText,
    createControlAria,
    createControlTitle,
    createControlBox,
    createSurfaceText,
    alerts: alertTexts
  }));

  // Successful Project creation automatically navigates the browser to the new
  // Project URL. A short human-scale wait is sufficient; capture that URL directly.
  await page.waitForTimeout(randomDelayMs(3000, 5000));
  let projectUrl = page.url();
  if (projectUrl === beforeCreateUrl) {
    await page.waitForTimeout(randomDelayMs(2000, 3500));
    projectUrl = page.url();
  }
  if (projectUrl === beforeCreateUrl) {
    throw new Error('Create project did not navigate to a new Project URL after a short visible wait');
  }

  const composer = await ensureComposer(page);
  console.log('[github-playwright-v10] project-created-visible=' + JSON.stringify({ projectName: name, url: projectUrl }));
  return { projectName: name, url: projectUrl, composer };
}

async function fillComposer(page, message, composerOverride = null) {
  const composer = composerOverride || await ensureComposer(page);
  if (!await composer.isVisible().catch(() => false)) {
    throw new Error('Visible composer target is not available for human typing');
  }
  await humanTypeInto(page, composer, message);
  return composer;
}

async function saveWakeEvidence(page, label, extra = {}) {
  const dir = '/tmp/browser-wake-evidence-v1';
  await fs.mkdir(dir, { recursive: true });
  const safe = String(label).replace(/[^A-Za-z0-9._-]+/g, '-');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const diagnostics = {
    label,
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyTail: bodyText.slice(-6000),
    ...extra
  };
  await fs.writeFile(path.join(dir, safe + '.json'), JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');
  await page.screenshot({ path: path.join(dir, safe + '.png'), fullPage: true }).catch(() => {});
  console.log('[github-playwright-v10] wake-evidence-saved=' + JSON.stringify({ label, dir }));
}

async function post(page, message, composerOverride = null) {
  if (!message) throw new Error('Wake message is empty');

  const normalizedMessage = normalizeVisibleText(message);
  const marker = normalizedMessage.slice(0, Math.min(180, normalizedMessage.length));
  const requestedIdleWait = Number.parseInt(env.IDLE_WAIT_MS || '600000', 10);
  const idleWaitMs = Number.isFinite(requestedIdleWait) ? Math.max(30000, requestedIdleWait) : 600000;

  // Human-only interaction: wait until the visible chat is idle, type through keyboard
  // events, and click the visible Send control with pointer movement.
  await waitForChatIdle(page, idleWaitMs);
  const composer = await fillComposer(page, message, composerOverride);

  const send = await findSendControlNearComposer(page, composer);
  if (!send) throw new Error('No visible Send button for normal human-style click');

  const composerText = await composer.inputValue().catch(async () => {
    return await composer.innerText().catch(() => '');
  });
  const normalizedComposer = normalizeVisibleText(composerText);
  const minimumExpectedLength = Math.floor(normalizedMessage.length * 0.95);
  const markerPresent = marker.length > 0 && normalizedComposer.includes(marker);
  const lengthPlausible = normalizedComposer.length >= minimumExpectedLength;
  console.log('[github-playwright-v10] composer-pre-send-verification=' + JSON.stringify({
    normalizedComposerLength: normalizedComposer.length,
    normalizedMessageLength: normalizedMessage.length,
    markerLength: marker.length,
    markerPresent,
    lengthPlausible
  }));
  if (!markerPresent || !lengthPlausible) {
    throw new Error('Human-typed wake was not fully and visibly present in the composer before Send');
  }

  const sendDiagnostics = {
    aria: await send.getAttribute('aria-label').catch(() => null),
    testid: await send.getAttribute('data-testid').catch(() => null),
    text: await send.innerText().catch(() => ''),
    disabled: await send.isDisabled().catch(() => false),
    box: await send.boundingBox().catch(() => null)
  };
  await saveWakeEvidence(page, '01-before-send-v1', { sendDiagnostics });

  console.log('[github-playwright-v10] send-strategy=human-short-pointer-click');
  await humanShortPointerClick(page, send);
  await page.waitForTimeout(randomDelayMs(1400, 2200));
  await saveWakeEvidence(page, '02-after-first-send-click-v1', { sendDiagnostics });

  const quickVisible = await visibleWakePresent(page, message, 2500);
  if (!quickVisible.visible) {
    const composerAfterFirstClick = await composer.inputValue().catch(async () => {
      return await composer.innerText().catch(() => '');
    });
    const normalizedAfterFirstClick = normalizeVisibleText(composerAfterFirstClick);
    const stillInComposer =
      normalizedAfterFirstClick.includes(marker) &&
      normalizedAfterFirstClick.length >= minimumExpectedLength;

    if (stillInComposer) {
      const retrySend = await findSendControlNearComposer(page, composer);
      if (!retrySend) throw new Error('Wake remained in composer after first Send click and no visible Send control was available for retry');
      console.log('[github-playwright-v10] send-retry=human-short-pointer-click reason=message-still-in-composer');
      await humanShortPointerClick(page, retrySend);
      await page.waitForTimeout(randomDelayMs(900, 1500));
      await saveWakeEvidence(page, '03-after-send-retry-v1', {
        retrySendDiagnostics: {
          aria: await retrySend.getAttribute('aria-label').catch(() => null),
          testid: await retrySend.getAttribute('data-testid').catch(() => null),
          text: await retrySend.innerText().catch(() => ''),
          disabled: await retrySend.isDisabled().catch(() => false),
          box: await retrySend.boundingBox().catch(() => null)
        }
      });
    }
  }

  return { strategy: 'human-short-pointer-click' };
}

function visibleBrowserStateText(bodyText = '', title = '') {
  return {
    loginPrompt: /\bLog in\b|\bSign up\b|Continue with Google|Welcome back/i.test(bodyText),
    humanChallenge:
      /Verify you are human|Checking your browser|Just a moment|Cloudflare|security challenge/i.test(bodyText) ||
      /Just a moment|Cloudflare/i.test(title),
    conversationUnavailable:
      /Unable to load conversation|Conversation not found|Chat not found|This conversation is unavailable/i.test(bodyText)
  };
}

async function waitForVisibleBrowserReady(page) {
  const requested = Number.parseInt(env.MANUAL_CHALLENGE_WAIT_MS || '0', 10);
  const waitMs = Number.isFinite(requested) ? Math.max(0, requested) : 0;
  const deadline = Date.now() + waitMs;

  while (true) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const visible = visibleBrowserStateText(bodyText, title);
    const composer = await firstVisible(page, [
      '#prompt-textarea',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"]'
    ]);

    console.log('[github-playwright-v10] visible-browser-ready=' + JSON.stringify({
      ready: Boolean(composer) && !visible.loginPrompt && !visible.humanChallenge && !visible.conversationUnavailable,
      ...visible,
      composerVisible: Boolean(composer),
      url: page.url()
    }));

    if (visible.humanChallenge) {
      const error = new Error('BROWSER_CHALLENGE: visible ChatGPT/Cloudflare verification detected; aborting immediately');
      error.code = 'BROWSER_CHALLENGE';
      throw error;
    }
    if (composer && !visible.loginPrompt && !visible.conversationUnavailable) return true;
    if (Date.now() >= deadline) {
      throw new Error('ChatGPT visible browser state did not become ready within the configured 5-minute wait');
    }

    if (bool(env.INTERACTIVE_VIEW_ENABLED)) {
      console.log('[github-playwright-v10] Visible browser is not ready; waiting only for ordinary UI/login readiness. Cloudflare challenge would abort immediately.');
    }
    await page.waitForTimeout(5000);
  }
}

function chatRouteInfo(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://chatgpt.com') return { isChat: false, isLocal: false, id: '', projectScoped: false };
    const rootMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    const projectMatch = url.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/([^/]+)\/?$/);
    const id = decodeURIComponent(rootMatch?.[1] || projectMatch?.[2] || '');
    return {
      isChat: Boolean(id),
      isLocal: id.startsWith('local-chatgpt:'),
      id,
      projectScoped: Boolean(projectMatch),
      projectId: projectMatch?.[1] || ''
    };
  } catch {
    return { isChat: false, isLocal: false, id: '', projectScoped: false };
  }
}

async function visibleWakePresent(page, message, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const marker = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 180);

  while (Date.now() < deadline) {
    const users = page.locator('[data-message-author-role="user"]');
    const userCount = await users.count().catch(() => 0);
    for (let i = Math.max(0, userCount - 8); i < userCount; i += 1) {
      const text = (await users.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (marker && text.includes(marker)) {
        return { visible: true, userCount, method: 'user-role' };
      }
    }
    await page.waitForTimeout(750);
  }

  return {
    visible: false,
    userCount: await page.locator('[data-message-author-role="user"]').count().catch(() => 0),
    method: 'not-visible',
    url: page.url()
  };
}

async function waitForFreshChatRoute(page, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = page.url();
    const info = chatRouteInfo(current);
    if (info.isChat) return { url: current, ...info };
    await page.waitForTimeout(500);
  }
  throw new Error('Fresh chat did not visibly navigate to a chatgpt.com/c/... route');
}

async function waitForDurableChatRoute(page, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const visible = visibleBrowserStateText(bodyText, title);
    if (visible.humanChallenge) {
      const error = new Error('BROWSER_CHALLENGE: visible ChatGPT/Cloudflare verification detected while waiting for durable chat URL; aborting immediately');
      error.code = 'BROWSER_CHALLENGE';
      throw error;
    }

    const current = page.url();
    const info = chatRouteInfo(current);
    if (info.isChat && !info.isLocal) {
      console.log('[github-playwright-v10] durable-chat-route=' + JSON.stringify({ url: current }));
      return { url: current, ...info };
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Fresh chat remained on an optimistic/local route beyond the 5-minute durable-route timeout');
}

async function humanReload(page) {
  console.log('[github-playwright-v10] verification-reload=human-x11-control-r');
  await x11Key(['key', '--clearmodifiers', 'ctrl+r'], 'x11-reload');
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

function recoverySearchMarker(message) {
  const text = String(message || '').trim();
  const bracket = text.match(/^\[[^\]]{6,180}\]/);
  return bracket ? bracket[0] : text.slice(0, 120);
}

async function recoverCreatedChatByVisibleSearch(page, message) {
  if (!message) throw new Error('recover action requires the original wake message');
  const marker = recoverySearchMarker(message);
  if (!marker) throw new Error('recover action could not derive a visible search marker');

  const filter = await firstVisible(page, [
    'button[aria-label="Filter chats and work"]',
    '[role="button"][aria-label="Filter chats and work"]',
    'button[aria-label*="Filter chats" i]',
    'button[aria-label*="Search chats" i]',
    'button[aria-label*="Search" i]'
  ]);
  if (!filter) throw new Error('Visible ChatGPT chat-search control was not found');
  await humanPointerClick(page, filter, { hoverMs: 180, downMs: 65, settleMs: 420 });

  const searchInput = await firstVisible(page, [
    '[role="dialog"] input[placeholder*="Search" i]',
    '[role="dialog"] input[aria-label*="Search" i]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="Search" i]',
    '[role="searchbox"]'
  ]);
  if (!searchInput) throw new Error('Visible ChatGPT chat-search input was not found');
  await humanTypeInto(page, searchInput, marker, { delay: 45 });

  const normalizedMarker = marker.replace(/\s+/g, ' ').trim();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const visible = visibleBrowserStateText(bodyText, title);
    if (visible.humanChallenge) {
      const error = new Error('BROWSER_CHALLENGE: visible ChatGPT/Cloudflare verification detected during read-only chat recovery; aborting immediately');
      error.code = 'BROWSER_CHALLENGE';
      throw error;
    }

    const candidates = page.locator(
      '[role="dialog"] a, [role="dialog"] button, [role="option"], a[href^="/c/"], a[href*="chatgpt.com/c/"]'
    );
    const count = Math.min(await candidates.count().catch(() => 0), 120);
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = [
        await candidate.innerText().catch(() => ''),
        await candidate.getAttribute('aria-label').catch(() => ''),
        await candidate.getAttribute('title').catch(() => '')
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!text.includes(normalizedMarker)) continue;

      await humanPointerClick(page, candidate, { hoverMs: 180, downMs: 65, settleMs: 650 });
      const route = await waitForDurableChatRoute(page, 300000);
      const wake = await visibleWakePresent(page, message, 30000);
      if (!wake.visible) {
        throw new Error('Recovered chat URL did not visibly contain the exact original wake message');
      }

      console.log('[github-playwright-v10] recovered-created-chat=' + JSON.stringify({
        chatUrl: route.url,
        verificationMethod: wake.method
      }));
      return { recovered: true, chatUrl: route.url, verificationMethod: wake.method, userCount: wake.userCount };
    }

    await page.waitForTimeout(750);
  }

  throw new Error('No visible ChatGPT search result matched the unique wake marker within 30 seconds');
}

async function postWithVisibleVerification(page, message, composerOverride = null) {
  const submitted = await post(page, message, composerOverride);

  let initialRoute = { url: page.url(), ...chatRouteInfo(page.url()) };
  if (mode === 'create_fresh') {
    initialRoute = await waitForFreshChatRoute(page, 90000);
  } else if (!initialRoute.isChat) {
    throw new Error('Existing-chat send is not on a visible chatgpt.com/c/... route');
  }

  const beforeReload = await visibleWakePresent(page, message, 90000);
  console.log('[github-playwright-v10] visible-wake-before-reload=' + JSON.stringify({
    ...beforeReload,
    chatUrl: initialRoute.url,
    localRoute: initialRoute.isLocal
  }));
  if (!beforeReload.visible) {
    await saveWakeEvidence(page, '04-send-not-rendered-v1', {
      verification: beforeReload,
      composerDiagnostics: {
        text: await page.locator('#prompt-textarea').innerText().catch(() => ''),
        visible: await page.locator('#prompt-textarea').isVisible().catch(() => false)
      }
    });
    throw new Error('Sent wake is not visibly present in the rendered conversation before reload');
  }

  // Never reload an optimistic local-chatgpt route. Wait for the normal UI
  // to transition to a durable server-backed /c/<id> route first.
  if (initialRoute.isLocal) {
    initialRoute = await waitForDurableChatRoute(page, 300000);
  }

  await humanReload(page);
  await waitForVisibleBrowserReady(page);

  const reloadedRoute = { url: page.url(), ...chatRouteInfo(page.url()) };
  if (!reloadedRoute.isChat || reloadedRoute.isLocal) {
    throw new Error('Human-style reload did not return to a durable chatgpt.com/c/... conversation');
  }

  const afterReload = await visibleWakePresent(page, message, 90000);
  console.log('[github-playwright-v10] visible-wake-after-reload=' + JSON.stringify({
    ...afterReload,
    chatUrl: reloadedRoute.url,
    localRoute: reloadedRoute.isLocal
  }));
  if (!afterReload.visible) {
    throw new Error('Wake is not visibly present after human-style reload of the conversation');
  }

  return {
    ...submitted,
    persisted: true,
    userCount: afterReload.userCount,
    verificationMethod: afterReload.method,
    chatUrl: reloadedRoute.url,
    localRoute: reloadedRoute.isLocal
  };
}

async function runWithPage(providerName, connect) {
  const { browser, context, page, close } = await connect();
  try {
    if (mode === 'resume_existing') {
      const requestedRoute = chatRouteInfo(requestedUrl);
      if (!requestedRoute.isChat || requestedRoute.isLocal) {
        throw new Error('resume_existing requires a durable root or Project-scoped ChatGPT conversation URL');
      }
      await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else if (mode === 'create_fresh') {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      throw new Error('Unsupported WAKE_MODE');
    }

    await page.waitForTimeout(1500);
    if (bool(env.REFRESH_BEFORE_WAKE)) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
    }

    await waitForVisibleBrowserReady(page);

    let project = null;
    if (action === 'project_wake') {
      if (mode !== 'create_fresh') throw new Error('project_wake requires create_fresh mode');
      project = await createProjectExactHumanFlow(page, projectName);
    }

    const before = await snapshot(page);

    if (action === 'observe') {
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 720);
        await page.waitForTimeout(randomDelayMs(220, 480));
      }
      await saveWakeEvidence(page, '05-observe-bottom-v1', {
        reason: 'read-only bottom-of-chat diagnostic'
      });
      const sessionStatePersisted = false;
      const result = { ok: true, provider: providerName, action, wakeId, sessionStatePersisted, ...before };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
      return result;
    }

    if (action === 'recover') {
      const recovered = await recoverCreatedChatByVisibleSearch(page, wakeMessage);
      const after = await snapshot(page);
      const sessionStatePersisted = false;
      const result = {
        ok: true,
        provider: providerName,
        action,
        wakeId,
        posted: false,
        recovered: true,
        sessionStatePersisted,
        before,
        after,
        chatUrl: recovered.chatUrl,
        verification: 'visible-browser-only',
        verificationMethod: recovered.verificationMethod
      };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    if (before.generating && !bool(env.FORCE_WAKE)) {
      const requestedIdleWait = Number.parseInt(env.IDLE_WAIT_MS || '600000', 10);
      const idleWaitMs = Number.isFinite(requestedIdleWait) ? Math.max(30000, requestedIdleWait) : 600000;
      console.log('[github-playwright-v10] Chat is currently generating; waiting for idle before wake send.');
      await waitForChatIdle(page, idleWaitMs);
      await waitForVisibleBrowserReady(page);
    }

    if (action === 'wake_and_wait' && mode === 'resume_existing' && !before.chatViewable) {
      const result = {
        ok: true, provider: providerName, action, wakeId,
        posted: false, responded: false, deadReason: 'CHAT_UNVIEWABLE',
        before, after: before, chatUrl: before.url
      };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
      return result;
    }

    const verifiedSend = await postWithVisibleVerification(page, wakeMessage, project?.composer || null);

    let response = null;
    let after;
    if (action === 'wake_and_wait') {
      const requestedWait = Number.parseInt(env.RESPONSE_WAIT_MS || '120000', 10);
      const responseWaitMs = Number.isFinite(requestedWait) ? Math.max(120000, requestedWait) : 120000;
      response = await waitForAssistantResponse(page, before, responseWaitMs);
      after = response.snapshot;
    } else {
      await page.waitForTimeout(1500);
      after = await snapshot(page);
    }

    if (mode === 'create_fresh') {
      after.url = verifiedSend.chatUrl;
    }

    const sessionStatePersisted = false;
    const result = {
      ok: true, provider: providerName, action, wakeId, posted: true, before, after, sessionStatePersisted,
      chatUrl: verifiedSend.chatUrl || after.url,
      verification: 'visible-browser-only',
      ...(project ? { projectName: project.projectName, projectUrl: project.url } : {}),
      ...(response ? { responded: response.responded, waitedMs: response.waitedMs } : {})
    };
    await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    await close().catch(()=>{});
  }
}

async function localProvider(chromium) {
  if (!env.CHATGPT_STORAGE_STATE_B64) {
    throw new Error('CHATGPT_STORAGE_STATE_B64 is required');
  }
  let storage;
  try {
    storage = JSON.parse(Buffer.from(env.CHATGPT_STORAGE_STATE_B64, 'base64').toString('utf8'));
    if (!validateStorageState(storage)) throw new Error('invalid storage state');
  } catch {
    throw new Error('CHATGPT_STORAGE_STATE_B64 is invalid');
  }
  console.log('[github-playwright-v10] Using immutable bootstrap-secret session state; run state will be discarded.');
  const launchOptions = {
    headless: false,
    channel: 'chrome'
  };
  console.log('[github-playwright-v10] Launching ordinary visible Chrome with default browser networking and display behavior.');
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ storageState: storage });
  const page = await context.newPage();
  return { browser, context, page, close: () => browser.close() };
}

const { chromium } = await loadModules();

if ((action === 'wake' || action === 'observe') && mode === 'resume_existing') {
  try {
    const result = await runNormalChromeExistingWake(chromium);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    await fs.writeFile(statePath, JSON.stringify({
      ok: false,
      wakeId,
      failures: [{ provider: 'normal-system-chrome-x11', error: error.message }]
    }, null, 2) + '\n');
    console.error('[normal-system-chrome-x11] ' + error.message);
    process.exit(1);
  }
}

const providers = [
  ['github-playwright', () => localProvider(chromium)],
];

const failures = [];
for (const [name, connect] of providers) {
  try {
    const result = await runWithPage(name, connect);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    failures.push({ provider: name, error: error.message });
    console.error('[' + name + '] ' + error.message);
  }
}
await fs.writeFile(statePath, JSON.stringify({ ok:false, wakeId, failures }, null, 2) + '\n');
console.error(JSON.stringify({ ok:false, wakeId, failures }));
process.exit(1);

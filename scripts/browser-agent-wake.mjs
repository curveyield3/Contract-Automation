#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { validateStorageState } from './browser-session-state-v1.mjs';
import { loadBrowserRoutine, runBrowserRoutineStage } from './browser-routine-engine-v1.mjs';
import { executeBrowserOperation } from './browser-operations-v1.mjs';

const env = process.env;
const action = env.WAKE_ACTION || 'wake';
const mode = env.WAKE_MODE || 'resume_existing';
const wakeId = env.WAKE_ID || crypto.randomUUID();
const wakeMessage = env.WAKE_MESSAGE || '';
const messagePurpose = env.WAKE_MESSAGE_PURPOSE || 'standard';
const requestedUrl = env.CHAT_URL || '';
let browserRoutineId = env.BROWSER_ROUTINE_ID || '';
let projectName = env.CHATGPT_PROJECT_NAME || '';
let projectUrl = env.CHATGPT_PROJECT_URL || '';
let requestedChatName = env.CHATGPT_CHAT_NAME || '';
const thinkingEffort = (env.CHATGPT_THINKING_EFFORT || '').trim();
const statePath = env.WAKE_RESULT_PATH || '/tmp/browser-agent-wake-result.json';
function sha(text='') {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function bool(v) { return String(v || '').toLowerCase() === 'true'; }

function durableChatUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.origin !== 'https://chatgpt.com') return false;

    const root = url.pathname.match(/^\/c\/([^/]+)\/?$/);
    const project = url.pathname.match(/^\/g\/g-p-[^/]+\/c\/([^/]+)\/?$/);
    const id = root?.[1] || project?.[1] || '';
    return Boolean(id) && !/^local[-_:]/i.test(id);
  } catch { return false; }
}

class BrowserAgentError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'BrowserAgentError';
    this.code = code;
    this.retryable = retryable;
  }
}

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

async function hydrateBrowserContextFromRegistration() {
  if (mode !== 'create_fresh') return false;
  const projectUrlRequired = /project-open-v1$/.test(browserRoutineId);
  if (browserRoutineId && projectName && requestedChatName && (!projectUrlRequired || projectUrl)) return false;
  const campaignId = String(env.CAMPAIGN_ID || '').trim();
  if (!campaignId) return false;
  const safeCampaign = campaignId.replace(/[^A-Za-z0-9._-]/g, '_');
  const registrationPath = path.resolve('process/browser-agent-wake/registrations', safeCampaign + '.json');
  try {
    const registration = JSON.parse(await fs.readFile(registrationPath, 'utf8'));
    if (registration.campaignId !== campaignId) {
      throw new Error('registration campaignId mismatch');
    }
    if (!browserRoutineId) browserRoutineId = String(registration.browserRoutine || '');
    if (!projectName) projectName = String(registration.chatgptProject?.name || '');
    if (!projectUrl) projectUrl = String(registration.chatgptProject?.url || '');
    if (!requestedChatName) {
      requestedChatName = String(
        registration.activeChat?.name ||
        (projectName && registration.activeAssignment?.reviewer
          ? projectName + ' ' + registration.activeAssignment.reviewer
          : '')
      );
    }
    console.log('[github-playwright] browser-context-source=campaign-registration ' + JSON.stringify({
      routineId: browserRoutineId || null,
      projectName: projectName || null,
      projectUrl: projectUrl || null,
      chatName: requestedChatName || null
    }));
    return Boolean(browserRoutineId || projectName || requestedChatName);
  } catch (error) {
    console.log('[github-playwright] browser-context-registration-unavailable=' + JSON.stringify({
      campaignId,
      error: error.message
    }));
    return false;
  }
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
    'main #prompt-textarea',
    'main textarea[placeholder*="Message"]',
    'main textarea',
    'main [contenteditable="true"][data-lexical-editor="true"]',
    'main [contenteditable="true"]',
    'main [contenteditable]:not([contenteditable="false"])',
    'main [role="textbox"]',
    'main .ProseMirror',
    'main [data-placeholder*="Message" i]'
  ]);
  const assistant = page.locator('[data-message-author-role="assistant"]');
  const user = page.locator('[data-message-author-role="user"]');
  let aCount = await assistant.count().catch(() => 0);
  let uCount = await user.count().catch(() => 0);
  let last = '';
  if (aCount) last = await assistant.nth(aCount - 1).innerText().catch(() => '');
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');

  // Current ChatGPT UI variants do not always expose data-message-author-role.
  // Fall back to the human-visible transcript labels used by the rendered UI.
  const assistantLabelMatches = bodyText.match(/ChatGPT said:/gi) || [];
  const userLabelMatches = bodyText.match(/You said:/gi) || [];
  if (aCount === 0 && assistantLabelMatches.length) {
    aCount = assistantLabelMatches.length;
    const parts = bodyText.split(/ChatGPT said:/i);
    last = String(parts[parts.length - 1] || '').split(/You said:/i)[0].trim();
  }
  if (uCount === 0 && userLabelMatches.length) {
    uCount = userLabelMatches.length;
  }
  const title = await page.title().catch(() => '');
  const conversationUnavailable =
    /Unable to load conversation|Conversation not found|Chat not found|This conversation is unavailable/i.test(bodyText);
  const accountLoadFailure =
    /We couldn.?t load your account|Unable to load your account/i.test(bodyText);
  const loginPrompt =
    /\bLog in\b|\bSign up\b|Continue with Google|Welcome back/i.test(bodyText) ||
    accountLoadFailure;
  const humanChallenge =
    /Verify you are human|Checking your browser|Just a moment|Cloudflare|security challenge/i.test(bodyText) ||
    /Just a moment|Cloudflare/i.test(title);
  const generating = !!stop || /Stop generating/i.test(bodyText);
  const chatViewable =
    durableChatUrl(currentUrl) &&
    (!!composer || generating) &&
    !conversationUnavailable &&
    !loginPrompt &&
    !humanChallenge;
  const mainSurface = page.locator('main, [role="main"]').first();
  const mainText = await mainSurface.innerText().catch(() => '');
  if (!last && mainText) {
    // Role attributes are no longer stable across ChatGPT UI revisions.
    // Use the rendered conversation surface as the activity fingerprint fallback.
    last = normalizeVisibleText(mainText);
  }
  const mainDiagnostics = await mainSurface.evaluate(el => ({
    tag: el.tagName,
    controls: [...el.querySelectorAll('button,[role="button"],[role="status"],h1,h2')].slice(0,25).map(node => ({
      tag: node.tagName, role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
      testId: node.getAttribute('data-testid'), text: node.getAttribute('role') === 'status' ? node.textContent.trim().slice(0,120) : null,
    })),
  })).catch(() => null);
  return {
    pageTitle: title,
    mainDiagnostics,
    loadingText: /loading|opening chat|reconnecting|synchroniz/i.test(bodyText),
    generating,
    composerVisible: !!composer,
    conversationUnavailable,
    accountLoadFailure,
    loginPrompt,
    humanChallenge,
    chatViewable,
    assistantCount: aCount,
    userCount: uCount,
    lastAssistantHash: sha(last),
    lastAssistantLength: last.length,
    url: currentUrl,
  };
}

async function ensureComposer(page) {
  const selectors = [
    'main #prompt-textarea',
    'main textarea[placeholder*="Message"]',
    'main textarea',
    'main [contenteditable="true"][data-lexical-editor="true"]',
    'main [contenteditable="true"]',
    'main [contenteditable]:not([contenteditable="false"])',
    'main [role="textbox"]',
    'main .ProseMirror',
    'main [data-placeholder*="Message" i]'
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

  const diagnostic =
    'ChatGPT composer not found after 30s' +
    ' (url=' + currentUrl +
    ', title=' + JSON.stringify(title) +
    ', loginPrompt=' + loginPrompt +
    ', humanChallenge=' + humanChallenge +
    ', conversationUnavailable=' + conversationUnavailable +
    ', textareaCount=' + textareaCount +
    ', editableCount=' + editableCount + ')';

  if (humanChallenge) {
    throw new BrowserAgentError('BROWSER_CHALLENGE', diagnostic, false);
  }
  if (loginPrompt) {
    throw new BrowserAgentError('AUTH_REQUIRED', diagnostic, false);
  }
  if (conversationUnavailable) {
    throw new BrowserAgentError('CHAT_UNAVAILABLE', diagnostic, false);
  }
  throw new BrowserAgentError('CHATGPT_UI_UNAVAILABLE', diagnostic, true);
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
      if (!confirm) return { idle: true, waitedMs: Date.now() - started };
    }
    await page.waitForTimeout(3000);
  }
  throw new BrowserAgentError('CHAT_BUSY_TIMEOUT', 'Chat remained busy/generating beyond idle wait timeout', false);
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
  // Skilled visible typist pacing: roughly 80-120 WPM in normal prose,
  // with faster spaces and natural punctuation pauses.
  let min = 90;
  let max = 130;
  if (/\s/.test(char)) {
    min = 55;
    max = 95;
  }
  if (/[.!?,;:]/.test(char)) {
    min = 145;
    max = 230;
  }
  await page.waitForTimeout(randomDelayMs(min, max));
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
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(label + ' failed: ' + stderr.trim())));
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
    throw new BrowserAgentError('X11_COMMAND_FAILED', label + ' failed: ' + error.message, true);
  }
}

async function verifyX11VisibleChatAddress(requested) {
  // Same interaction as a person copying the browser address bar.
  // This deliberately does NOT inspect ChatGPT DOM, fetch, CDP page state, or endpoints.
  await x11Key(['key','--clearmodifiers','ctrl+l'],'x11-select-visible-address-bar');
  await new Promise(resolve=>setTimeout(resolve,250));
  await x11Key(['key','--clearmodifiers','ctrl+c'],'x11-copy-visible-address-bar');
  const {stdout}=await runCapture('xclip',['-selection','clipboard','-o']);
  await x11Key(['key','--clearmodifiers','Escape'],'x11-close-visible-address-bar');
  let actual,expected;
  try {actual=new URL(stdout.trim());expected=new URL(requested);}
  catch {throw new BrowserAgentError('VISIBLE_ADDRESS_UNREADABLE','Browser address bar could not be copied through OS keyboard',true);}
  const current=actual.pathname.replace(/\/$/,'');
  const expectedPath=expected.pathname.replace(/\/$/,'');
  if(actual.origin!=='https://chatgpt.com')throw new BrowserAgentError('WRONG_VISIBLE_ORIGIN','Chrome is not displaying ChatGPT',false);
  if(/^\/(?:auth|login|signup|register)(?:\/|$)/i.test(current))
    throw new BrowserAgentError('AUTH_REQUIRED','Visible Chrome window redirected to ChatGPT login; refresh browser session secret before sending',false);
  // ChatGPT may redirect an authenticated-looking browser to the home screen
  // when its account/browser check fails. This is not a missing chat, wrong
  // project URL, RPC failure, or a reason to paste into the home composer.
  // Use only the visibly copied Chrome URL (OS clipboard), never DOM/API reads.
  if(current==='/'||current==='/home')
    throw new BrowserAgentError('CHATGPT_ACCOUNT_SESSION_CHECK_FAILED',
      'Chrome redirected from the registered conversation to ChatGPT home. Inspect the saved visual evidence for an account/browser-check failure and re-authorize the browser session before replaying the published delivery. No message was sent.',false);
  const actualId=current.match(/\/c\/([^/]+)$/)?.[1]||'';
  const requestedId=expectedPath.match(/\/c\/([^/]+)$/)?.[1]||'';
  if(!requestedId||actualId!==requestedId)
    throw new BrowserAgentError('CHAT_UNAVAILABLE_OR_NOT_READY','Visible Chrome address bar is not the intended reviewer conversation',false);
  console.log('[normal-chrome-watchdog] verified-target-chat-via-visible-address-bar=true');
  return true;
}

// Find the send/stop button in an OS desktop screenshot crop. The button is a dark
// disc with a white icon (stop square or send arrow), so dark pixels are counted at
// full resolution rather than averaged: a 40x40 px window holding 500-1350 dark
// pixels with an almost empty 8 px band around it. Text has too few dark pixels; a
// dark block or code panel fills the window or its surrounding band.
async function x11FindButton(file, originX, originY) {
  // Colour-blind: a pixel counts when it differs strongly from the crop's dominant
  // (background) colour, so a black, blue or dark-mode button all register.
  const {stdout}=await runCapture('convert',[file,'-alpha','off','-colorspace','sRGB','-depth','8','txt:-'],{maxBuffer:1<<28});
  let w=0,h=0;const px=[];const hist=new Map();
  for(const line of stdout.split('\n')){
    const m=line.match(/^(\d+),(\d+):.*?#([0-9A-Fa-f]{6})/);if(!m)continue;
    const x=+m[1],y=+m[2],v=parseInt(m[3],16),r=v>>16,g=(v>>8)&255,b=v&255;
    w=Math.max(w,x+1);h=Math.max(h,y+1);px.push([x,y,r,g,b]);
    const q=(r>>4)<<8|(g>>4)<<4|(b>>4);hist.set(q,(hist.get(q)||0)+1);
  }
  let bgq=0,bgn=-1;for(const [q,n] of hist)if(n>bgn){bgq=q;bgn=n;}
  const bg=[((bgq>>8)<<4)+8,(((bgq>>4)&15)<<4)+8,((bgq&15)<<4)+8];
  const dark=[];
  for(const [x,y,r,g,b] of px)
    if(Math.hypot(r-bg[0],g-bg[1],b-bg[2])>110)dark.push([x,y]);
  const integral=new Int32Array((w+1)*(h+1));
  for(const [x,y] of dark)integral[(y+1)*(w+1)+x+1]+=1;
  for(let y=1;y<=h;y++)for(let x=1;x<=w;x++)
    integral[y*(w+1)+x]+=integral[(y-1)*(w+1)+x]+integral[y*(w+1)+x-1]-integral[(y-1)*(w+1)+x-1];
  const box=(x0,y0,x1,y1)=>{
    x0=Math.max(0,x0);y0=Math.max(0,y0);x1=Math.min(w,x1);y1=Math.min(h,y1);
    return integral[y1*(w+1)+x1]-integral[y0*(w+1)+x1]-integral[y1*(w+1)+x0]+integral[y0*(w+1)+x0];
  };
  const S=60,band=8;let best=null;
  for(let y=0;y+S<=h;y+=2)for(let x=0;x+S<=w;x+=2){
    const count=box(x,y,x+S,y+S);
    if(count<1200||count>2700)continue;
    const around=box(x-band,y-band,x+S+band,y+S+band)-count;
    if(around>120)continue;
    if(!best||count>best.count)best={x,y,count,around};
  }
  // Coarse map of the crop for the run log (8 px cells: ' ' none, '.' some, '+' half, '#' mostly
  // dark), so a miss can be diagnosed from the log without downloading screenshots.
  const map=[];const C=16;
  for(let y=0;y<h;y+=C){
    let row='';
    for(let x=0;x<w;x+=C){const c=box(x,y,x+C,y+C);row+=c===0?' ':c<C*C/16?'.':c<C*C/2?'+':'#';}
    map.push(row.replace(/\s+$/,''));
  }
  console.log('[normal-chrome-watchdog] stop-search-map origin='+originX+','+originY+' size='+w+'x'+h+' cell='+C+'px\n'+map.map(r=>'|'+r).join('\n'));
  return best?{x:originX+best.x+S/2,y:originY+best.y+S/2,darkPixels:best.count,darkAround:best.around}:null;
}

// Inspect only a saved OS screenshot of the bottom composer row, never ChatGPT
// DOM/accessibility/network state. A live bright-blue Send disc is proof that
// the long pasted prompt remains unsent; a generic pixel change is NOT.
async function findX11VisibleBlueSend(file, screenshotWidth, screenshotHeight) {
  const originX=Math.floor(screenshotWidth*0.50);
  const originY=Math.floor(screenshotHeight*0.55);
  const roiW=Math.max(1,Math.floor(screenshotWidth*0.30));
  const roiH=screenshotHeight-originY;
  const {stdout}=await runCapture('convert',[
    file,'-crop',roiW+'x'+roiH+'+'+originX+'+'+originY,
    '+repage','-alpha','off','-colorspace','sRGB','-depth','8','txt:-'
  ],{maxBuffer:1<<26});
  let total=0,sumX=0,sumY=0;
  const whitePixels=[];
  for(const line of stdout.split('\n')){
    const m=line.match(/^(\d+),(\d+):.*?#([0-9A-Fa-f]{6})/);
    if(!m)continue;
    const c=parseInt(m[3],16),r=(c>>16)&255,g=(c>>8)&255,b=c&255;
    if(r>200&&g>200&&b>200)whitePixels.push([+m[1],+m[2]]);
    if(b>150&&b>r*1.25&&b>g*1.10&&r<180){
      total++;sumX+=+m[1];sumY+=+m[2];
    }
  }
  if(total<180)return null;
  const x=originX+Math.round(sumX/total);
  const y=originY+Math.round(sumY/total);
  // Limit OS clicking to the known Send-disc neighborhood. Never click text,
  // arbitrary images, the chat transcript, or the page navigation.
  if(x<screenshotWidth*0.57||x>screenshotWidth*0.78||
     y<screenshotHeight*0.68||y>screenshotHeight*0.98)return null;
  // The active Send arrow has a thin central white stem/chevron.
  // A generating chat displays a filled white STOP SQUARE at the same location.
  // Count the center's 12x12 white pixels; a stop square occupies >=65 of them
  // (observed on actual Chrome screenshots), whereas the send arrow does not.
  const localX=x-originX,localY=y-originY;
  const centerWhite=whitePixels.filter(([px,py])=>Math.abs(px-localX)<=5&&Math.abs(py-localY)<=5).length;
  return {x,y,pixels:total,kind:centerWhite>=65?'STOP':'SEND',centerWhite};
}

// The visible Chrome title may briefly say "Chat 4 Ready" while the SPA
// immediately re-enters a full-page spinner. The old 10-second delay could
// therefore paste during an account/project hydration reload. Read only an
// X11 desktop screenshot of the existing conversation history region: an
// established reviewer chat has visible text there; a loading spinner does
// not. Require multiple stable samples before typing. Never inspect the
// ChatGPT DOM, accessibility tree, network, or internal APIs.
async function x11VisibleHistoryFraction(screenshot, width, height) {
  const x = Math.round(width * 0.36);
  const y = Math.round(height * 0.19);
  const w = Math.round(width * 0.43);
  const h = Math.round(height * 0.59);
  const {stdout} = await runCapture('convert', [
    screenshot, '-crop', w+'x'+h+'+'+x+'+'+y, '+repage',
    '-colorspace', 'Gray', '-threshold', '70%', '-negate',
    '-format', '%[fx:mean]', 'info:'
  ]);
  const fraction = Number(stdout.trim());
  if (!Number.isFinite(fraction)) throw new BrowserAgentError(
    'CHAT_HISTORY_VISUAL_UNREADABLE','Desktop screenshot history readiness could not be measured',true);
  return fraction;
}
async function waitForX11ConversationHydrated(page, width, height) {
  const deadline = Date.now() + 120000;
  let stable = 0;
  while (Date.now() < deadline) {
    const imagePath = await captureX11VisualEvidence('x11_chat_hydration_check', '', 3000);
    const fraction = await x11VisibleHistoryFraction(imagePath,width,height);
    const ready = fraction >= 0.004;
    console.log('[normal-chrome-watchdog] real-chat-history-visible=' + ready +
      ' darkPixelFraction=' + fraction.toFixed(5) + ' stableSamples=' + stable);
    // Four spaced checks rule out the observed loaded -> spinner -> loaded
    // oscillation. A page-title change alone is NOT conversation readiness.
    stable = ready ? stable+1 : 0;
    if (stable >= 4) return true;
    await page.waitForTimeout(4000);
  }
  throw new BrowserAgentError('CHAT_CONVERSATION_HYDRATION_TIMEOUT',
    'Established reviewer chat did not remain visibly loaded for four OS screenshots; no typing or Send attempted',true);
}

async function captureX11VisualEvidence(label, cropRegion = '', minBytes = 3000) {
  const root = '/tmp/browser-wake-evidence-v1';
  await fs.mkdir(root, {recursive:true});
  const name=String(label).replace(/[^a-z0-9_-]/gi,'_').slice(0,60);
  const target=path.join(root,name+'.png');
  // Normal desktop screenshot, identical to a person viewing X11/VNC.
  // Never inspect ChatGPT DOM, network responses, or accessibility trees.
  const args = cropRegion ? ['-o','-a',cropRegion,target] : ['-o',target];
  await runCapture('scrot',args,{env:{DISPLAY:env.DISPLAY||':99'}});
  const file=await fs.stat(target);
  // A valid, low-entropy cropped PNG can compress below 3 KB. Preserve the
  // full-desktop threshold; accept cropped scrot evidence above PNG header size.
  const requiredBytes = cropRegion ? Math.min(minBytes, 64) : minBytes;
  if(file.size<requiredBytes)throw new BrowserAgentError('X11_SCREENSHOT_EMPTY','Unable to capture visible desktop before declaring delivery',true);
  console.log('[normal-chrome-watchdog] saved-desktop-visual='+name+' bytes='+file.size);
  return target;
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

// Paste like a person: put the text on the X11 clipboard, then Ctrl+V into the focused field.
// No page reads. ChatGPT keeps pasted newlines as line breaks; nothing is sent until Return.
async function humanX11PasteText(page, text) {
  const file = path.join(os.tmpdir(), 'wake-paste-' + process.pid + '.txt');
  await fs.writeFile(file, String(text));
  try {
    // xclip forks a daemon that keeps serving the selection and inherits any stdio pipes, so wait
    // for the parent's exit (not 'close') with stdio ignored, or the wake hangs until its timeout.
    await new Promise((resolve, reject) => {
      const child = spawn('xclip', ['-selection', 'clipboard', '-i', file], {
        env: { ...process.env, DISPLAY: env.DISPLAY || ':99' },
        stdio: 'ignore'
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('xclip failed (' + code + ')')));
    });
    await page.waitForTimeout(randomDelayMs(250, 450));
    await x11Key(['key', '--clearmodifiers', 'ctrl+v'], 'x11-paste');
    await page.waitForTimeout(randomDelayMs(600, 1000));
  } finally {
    await fs.rm(file, {force:true});
  }
}

async function waitForCdp(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new BrowserAgentError('NORMAL_CHROME_NOT_READY', 'Normal Chrome CDP endpoint did not become ready', true);
}

async function runNormalChromeExistingSession(chromium) {
  if (!env.CHATGPT_STORAGE_STATE_B64) {
    throw new BrowserAgentError('AUTH_REQUIRED', 'CHATGPT_STORAGE_STATE_B64 is required', false);
  }
  let storage;
  try {
    storage = JSON.parse(Buffer.from(env.CHATGPT_STORAGE_STATE_B64, 'base64').toString('utf8'));
    if (!validateStorageState(storage)) throw new Error('invalid storage state');
  } catch {
    throw new BrowserAgentError('AUTH_REQUIRED', 'CHATGPT_STORAGE_STATE_B64 is invalid', false);
  }
  if (!durableChatUrl(requestedUrl)) {
    throw new BrowserAgentError('CHAT_URL_NOT_DURABLE', 'Normal Chrome existing-session mode requires a durable root or Project-scoped ChatGPT URL', false);
  }

  const safeWake = String(wakeId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const profileDir = '/tmp/curveyield-normal-chrome-' + safeWake;
  await fs.rm(profileDir, { recursive: true, force: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'First Run'), '', 'utf8');

  const chromeLookup = await runCapture('bash', ['-lc', 'command -v google-chrome || command -v google-chrome-stable']);
  const chromePath = chromeLookup.stdout.split(/\r?\n/).filter(Boolean)[0];
  if (!chromePath) {
    throw new BrowserAgentError('NORMAL_CHROME_MISSING', 'System Google Chrome executable was not found', false);
  }

  const port = 9222;
  console.log('[normal-chrome-watchdog] launching system Chrome directly; no Playwright launch, no headless flag, no enable-automation flag');
  const chromeProcess = spawn(chromePath, [
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    '--window-position=0,0',
    '--window-size=1920,1080',
    'about:blank'
  ], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let chromeStderr = '';
  chromeProcess.stderr?.on('data', chunk => { chromeStderr += chunk.toString(); });

  let browser;
  try {
    await waitForCdp(port, 60000);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw new BrowserAgentError('NORMAL_CHROME_CONTEXT_INVALID', 'Expected one normal Chrome browser context', true);
    }
    // The old cookie-only restore dropped Playwright storageState.origins,
    // which can leave ChatGPT unauthenticated even with a valid saved session.
    // Restore the complete browser profile state BEFORE normal X11 navigation;
    // no ChatGPT DOM or network endpoint is inspected or modified.
    console.log('[normal-chrome-watchdog] stored-session-inventory='+JSON.stringify({
      cookies:Array.isArray(storage.cookies)?storage.cookies.length:0,
      origins:Array.isArray(storage.origins)?storage.origins.length:0
    }));
    const context = await browser.newContext({storageState:storage,viewport:null});
    const page = await context.newPage();

    // Xvfb does not run a window manager. Alt+F10 is ignored, leaving Chrome
    // 820px wide while the old fixed-point composer click landed at x=1210.
    // Size the real OS window explicitly; this reads X11 metadata only.
    const windowMatches=await x11Capture(['search','--onlyvisible','--class','[Cc]hrome'],'x11-chrome-window-search');
    const windowIds=windowMatches.stdout.split(/\s+/).filter(Boolean);
    const chromeWindow=windowIds.at(-1);
    if(!chromeWindow)throw new BrowserAgentError('X11_CHROME_WINDOW_MISSING','No visible Chrome desktop window',true);
    await x11Key(['windowsize','--sync',chromeWindow,'1920','1080'],'x11-chrome-full-screen-size');
    await x11Key(['windowmove','--sync',chromeWindow,'0','0'],'x11-chrome-top-left-position');
    await x11Key(['windowfocus','--sync',chromeWindow],'x11-chrome-focus');
    const geometryCheck=await x11Capture(['getwindowgeometry','--shell',chromeWindow],'x11-chrome-geometry');
    console.log('[normal-chrome-watchdog] desktop-window-geometry='+JSON.stringify(geometryCheck.stdout.split('\n').filter(x=>/^(WIDTH|HEIGHT|X|Y)=/.test(x))));
    const sizeMatch=geometryCheck.stdout.match(/(?:^|\n)WIDTH=(\d+)/);
    if(!sizeMatch||Number(sizeMatch[1])<1600)throw new BrowserAgentError('CHROME_WINDOW_NOT_MAXIMIZED','OS Chrome window too narrow for safe composer coordinates',false);
    await page.waitForTimeout(randomDelayMs(650, 1100));

    await x11Key(['key', '--clearmodifiers', 'ctrl+l'], 'x11-address-bar');
    await page.waitForTimeout(randomDelayMs(180, 320));
    await humanX11PasteText(page, requestedUrl);
    await x11Key(['key', '--clearmodifiers', 'Return'], 'x11-navigate');
    await page.waitForTimeout(12000);
    await captureX11VisualEvidence('01_after_chat_navigation');
    if (!bool(env.WAKE_DIAGNOSTIC_ONLY)) {
      // Wait until the composer area of the desktop stops changing (two equal screenshots
      // 2.5 s apart), at most 28 s more: the old fixed 40 s wait, ended early once loaded.
      const [w, h] = (await x11Capture(['getdisplaygeometry'], 'x11-display-geometry')).stdout.trim().split(/\s+/).map(Number);
      const settle = [Math.round(w * 0.30), Math.max(0, h - 260), Math.round(w * 0.65), 260].join(',');
      let previous = null, settledAfterMs = null;
      for (let waited = 0; waited < 28000; waited += 2500) {
        const shot = await fs.readFile(await captureX11VisualEvidence('composer_settle', settle, 64));
        if (previous && previous.equals(shot)) { settledAfterMs = 12000 + waited; break; }
        previous = shot;
        await page.waitForTimeout(2500);
      }
      console.log('[normal-chrome-watchdog] navigation-settled-ms=' + (settledAfterMs ?? 'max-40000'));
      // The composer region can be visually stable while the Project chat is still
      // hydrating. Allow 10 more seconds before treating navigation as ready.
      await page.waitForTimeout(10000);
      await captureX11VisualEvidence('02_after_40s_navigation');
      await verifyX11VisibleChatAddress(requestedUrl);
      if (action === 'wake') {
        // A stuck Project chat can show a blank "New chat" page with a live
        // composer. An address-bar match alone does not prove chat hydration.
        // Read only the OS-visible Chrome window title; no ChatGPT page reads.
        const windowTitle = async () => (await x11Capture(
          ['getwindowname', chromeWindow], 'x11-visible-conversation-title'
        )).stdout.trim();
        const isUnloadedTitle = title => {
          const withoutChrome = title.replace(/\s+-\s+(?:Google Chrome|Chromium).*$/i, '').trim();
          return /^(?:ChatGPT|New chat)(?:\s+-\s+ChatGPT)?$/i.test(withoutChrome);
        };
        let title = await windowTitle();
        if (!title || isUnloadedTitle(title)) {
          console.log('[normal-chrome-watchdog] target-conversation-not-yet-loaded; one visible Ctrl+R recovery');
          await x11Key(['key', '--clearmodifiers', 'ctrl+r'], 'x11-reload-stalled-chat');
          const deadline = Date.now() + 90000;
          do {
            await page.waitForTimeout(5000);
            title = await windowTitle();
          } while ((!title || isUnloadedTitle(title)) && Date.now() < deadline);
          await captureX11VisualEvidence('02b_after_single_reload');
          await verifyX11VisibleChatAddress(requestedUrl);
        }
        if (!title || isUnloadedTitle(title)) {
          throw new BrowserAgentError('TARGET_CHAT_NOT_LOADED',
            'Chrome still displays the generic New chat/ChatGPT title instead of the registered reviewer conversation; refuse to paste or send into an unhydrated page',
            false);
        }
        console.log('[normal-chrome-watchdog] visible-conversation-title-ready=true');
        // A loaded title is a transient signal; confirm on-screen history
        // hydration, not a generic empty composer / central loading spinner.
        await waitForX11ConversationHydrated(page,w,h);
        await captureX11VisualEvidence('02c_confirmed_conversation_history_ready');
      }
    }
    if (bool(env.WAKE_DIAGNOSTIC_ONLY)) {
      await page.waitForTimeout(25000);
      await captureX11VisualEvidence('02_after_40s_navigation');
      await page.waitForTimeout(30000);
      await captureX11VisualEvidence('03_after_70s_navigation');
      const diagnostic={
        ok:false, posted:false, persisted:false, wakeId,
        provider:'normal-system-chrome-x11',
        failures:[{code:'DIAGNOSTIC_ONLY_NO_SEND',provider:'normal-system-chrome-x11',retryable:false,
          error:'Captured desktop navigation screenshot; intentionally did not type or send'}],
        verification:'OS_X11_SCREENSHOT_FOR_VISUAL_INSPECTION_ONLY'
      };
      await fs.writeFile(statePath,JSON.stringify(diagnostic,null,2)+'\n','utf8');
      return diagnostic;
    }

    if (action === 'observe') {
      const webdriver = await page.evaluate(() => navigator.webdriver).catch(() => 'unavailable');
      console.log('[normal-chrome-watchdog] navigator.webdriver=' + JSON.stringify(webdriver));
      let before = await snapshot(page);
      const hydrateDeadline = Date.now() + 30000;
      let afterObserve = before;
      while (Date.now() < hydrateDeadline) {
        if (
          afterObserve.chatViewable ||
          afterObserve.generating ||
          afterObserve.loginPrompt ||
          afterObserve.humanChallenge ||
          afterObserve.conversationUnavailable
        ) break;
        await page.waitForTimeout(2000);
        afterObserve = await snapshot(page);
      }
      const result = {
        ok: true,
        provider: 'normal-system-chrome-x11',
        action,
        wakeId,
        sessionStatePersisted: false,
        navigatorWebdriver: webdriver,
        ...afterObserve
      };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      return result;
    }

    if (action !== 'wake') {
      throw new BrowserAgentError('UNSUPPORTED_ACTION', 'Normal Chrome existing-session path only supports observe or wake', false);
    }

    // Proven Phase-1 wake interaction. Do not machine-read the composer,
    // phase1-fixed-x11-submit-no-chatgpt-page-read: X11-only ChatGPT input.
    // DOM focus, bounding box, or active element. The visible ChatGPT composer
    // occupies this stable point in the fixed 1920x1080 X11 Chrome display.
    const geometry = await x11Capture(['getdisplaygeometry'], 'x11-display-geometry');
    const [widthText, heightText] = geometry.stdout.trim().split(/\s+/);
    const width = Number.parseInt(widthText, 10);
    const height = Number.parseInt(heightText, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new BrowserAgentError('X11_GEOMETRY_INVALID', 'Could not determine X11 display geometry', true);
    }

    // Interrupt first, then write. A busy chat shows the stop button beside an empty
    // composer: click it, wait for generation to halt, then click into the text box,
    // type and press Return. On an idle chat the button beside an empty composer is the
    // inactive send button, so the click does nothing. Located from an OS screenshot of
    // the lower-right half by shape (60 px solid disc, any colour), never from the page.
    let stopClick = null;
    let discRow = null;
    if (bool(env.STOP_BEFORE_SEND)) {
      const searchX = Math.round(width * 0.40);
      const searchY = Math.round(height * 0.50);
      const search = await captureX11VisualEvidence('stop_search_area', [searchX, searchY, width - searchX, height - searchY].join(','), 64);
      const disc = await x11FindButton(search, searchX, searchY);
      stopClick = { x: disc?.x ?? null, y: disc?.y ?? null, darkPixels: disc?.darkPixels ?? 0, darkAround: disc?.darkAround ?? null, onButton: Boolean(disc), clicked: false, areaChanged: null };
      if (disc) {
        const area = [disc.x - 30, disc.y - 30, 60, 60].join(',');
        const areaBefore = await captureX11VisualEvidence('stop_area_before', area, 64);
        await x11Key(['mousemove', '--sync', String(disc.x), String(disc.y)], 'x11-stop-move');
        await page.waitForTimeout(randomDelayMs(180, 360));
        await x11Key(['click', '1'], 'x11-stop-click');
        stopClick.clicked = true;
        await page.waitForTimeout(4000);
        const areaAfter = await captureX11VisualEvidence('stop_area_after', area, 64);
        stopClick.areaChanged = !(await fs.readFile(areaBefore)).equals(await fs.readFile(areaAfter));
        discRow = disc;
      }
      stopClick.status = !stopClick.onButton ? 'STOP_BUTTON_NOT_FOUND'
        : stopClick.areaChanged ? 'STOP_CLICKED_BUTTON_CHANGED' : 'STOP_CLICKED_NO_CHANGE_IDLE';
      console.log('[normal-chrome-watchdog] stop-before-write=' + JSON.stringify(stopClick));
      await captureX11VisualEvidence('01b_after_stop_click');
    }

    // Text box: on the button's row, left of it, when the button was found.
    const composerX = discRow ? Math.max(Math.round(width * 0.40), discRow.x - 300) : Math.round(width * 0.63);
    // Keep the click inside the visible input field, not on its top border.
    // The 1920x1080 saved X11 screenshot locates the composer at y=1005..1060.
    const composerY = discRow ? discRow.y : Math.round(height - 48);
    await x11Key(['mousemove', '--sync', String(composerX), String(composerY)], 'x11-composer-move');
    await page.waitForTimeout(randomDelayMs(180, 360));
    await x11Key(['click', '1'], 'x11-composer-click');
    await page.waitForTimeout(randomDelayMs(250, 450));
    await captureX11VisualEvidence('02_after_composer_click');

    // Read only OS desktop screenshots; never inspect ChatGPT DOM, network,
    // browser accessibility, composer text or focus. The cropped visible region
    // provides a conservative interaction signal without machine browser reads.
    const cropX = Math.round(width * 0.43);
    const cropY = Math.max(0, height - 220);
    const cropWidth = Math.min(width - cropX, Math.round(width * 0.55));
    const cropHeight = Math.min(height - cropY, 200);
    const crop = [cropX, cropY, cropWidth, cropHeight].join(',');
    const beforeInput = await captureX11VisualEvidence('composer_before_input', crop);

    console.log('[normal-chrome-watchdog] wake-entry=OS-X11-clipboard-paste phase1-proven-fixed-point');
    await humanX11PasteText(page, wakeMessage);
    await captureX11VisualEvidence('03_after_text_entry');
    const afterInput = await captureX11VisualEvidence('composer_after_input', crop);
    const inputChanged = !(await fs.readFile(beforeInput)).equals(await fs.readFile(afterInput));
    // If project/account hydration restarts while the paste is happening,
    // the bottom crop may change despite the prompt being lost. This is
    // precisely the failure observed in run 40160350747: history vanished
    // and only a central loading spinner remained. No Return/click is safe.
    const historyAfterPaste = await captureX11VisualEvidence('03b_history_after_text_entry');
    const historyFraction = await x11VisibleHistoryFraction(historyAfterPaste,width,height);
    if(historyFraction < 0.004) {
      throw new BrowserAgentError('CHAT_RELOADED_DURING_PASTE',
        'The established chat disappeared into a visible loading spinner while pasting; no Send attempted. Recover on a fresh runner.',true);
    }
    if (!inputChanged) {
      throw new BrowserAgentError('CHAT_COMPOSER_NOT_RESPONSIVE',
        'Visible composer region did not change after X11 typing; no Enter was sent. See desktop screenshots.',
        false);
    }

    // The Phase-6 master handoff screenshot from run 40156956246 proved the
    // previous heuristic was wrong: Return scrolled a long composer, leaving
    // the BLUE SEND DISC active, yet a pixel diff was marked "posted".
    // Keep the human Return gesture, then hover/click the visible Send disc
    // if the composer still holds a pending message.
    const preSendHistory = await captureX11VisualEvidence('03c_history_before_send');
    if((await x11VisibleHistoryFraction(preSendHistory,width,height))<0.004) {
      throw new BrowserAgentError('CHAT_RELOADED_BEFORE_SEND',
        'Loading spinner returned between text entry and Send; no send attempt was made',true);
    }
    const beforeSendDisc=await findX11VisibleBlueSend(afterInput,cropWidth,cropHeight);
    if(!beforeSendDisc||beforeSendDisc.kind!=='SEND'){
      throw new BrowserAgentError('VISIBLE_SEND_DISC_NOT_FOUND',
        'Pasted text visibly changed but the enabled Send button could not be located in the OS screenshot; never guess a click or assert delivery.',false);
    }
    await page.waitForTimeout(randomDelayMs(350,700));
    console.log('[normal-chrome-watchdog] send=OS-X11-Return');
    await x11Key(['key','--clearmodifiers','Return'],'x11-send-return');
    await page.waitForTimeout(1600);
    await captureX11VisualEvidence('04_after_return_key');
    let afterSend=await captureX11VisualEvidence('composer_after_return',crop);
    let pendingDisc=await findX11VisibleBlueSend(afterSend,cropWidth,cropHeight);
    let clickedSend=false;
    if(pendingDisc?.kind==='SEND'){
      const sx=cropX+pendingDisc.x,sy=cropY+pendingDisc.y;
      console.log('[normal-chrome-watchdog] Return left enabled Send disc visible; clicking OS-visible Send at '+sx+','+sy);
      await x11Key(['mousemove','--sync',String(sx),String(sy)],'x11-hover-visible-send');
      await page.waitForTimeout(randomDelayMs(250,500));
      await x11Key(['click','1'],'x11-click-visible-send');
      clickedSend=true;
      await page.waitForTimeout(3300);
      await captureX11VisualEvidence('05_after_visible_send_click');
      afterSend=await captureX11VisualEvidence('composer_after_visible_send_click',crop);
      pendingDisc=await findX11VisibleBlueSend(afterSend,cropWidth,cropHeight);
    }
    if(pendingDisc?.kind==='SEND'){
      // A second blind Return/click can post unintended duplicate messages.
      // Keep the screenshot and report a real failure for human inspection.
      throw new BrowserAgentError('SEND_REMAINED_IN_COMPOSER',
        'After Return and a visible Send-button click the composer still has an enabled blue Send disc. Message not verified sent; inspect OS screenshots.',false);
    }
    // Disappearance of the enabled Send control from the unchanged visible
    // composer neighborhood provides an OS-only submission transition.
    // Only a matching first-action GitHub ACK confirms durable delivery.
    const sendChanged=!(await fs.readFile(afterInput)).equals(await fs.readFile(afterSend));
    if(!sendChanged)throw new BrowserAgentError('SEND_UNVERIFIED_NO_COMPOSER_RESET',
      'Active Send disc disappeared but the composer did not visibly reset.',false);
    const status='SEND_ATTEMPTED_VISIBLE_SEND_CONTROL_RESET';
    const result={
      ok:true,provider:'normal-system-chrome-x11-phase1-visual-evidence',
      action,wakeId,posted:true,sendAttempted:true,persisted:false,
      usedVisibleSendButton:clickedSend,
      ...(stopClick?{stopClick}:{}),
      chatUrl:requestedUrl,
      verification:'X11_VISIBLE_SEND_CONTROL_RESET_ONLY',
      delivery:{status,persisted:false,verification:'X11_VISIBLE_SEND_CONTROL_RESET_ONLY'}
    };
    await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n', 'utf8');
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!chromeProcess.killed) chromeProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 800));
    if (!chromeProcess.killed) chromeProcess.kill('SIGKILL');
    if (chromeStderr.trim()) {
      console.log('[normal-chrome-watchdog] chrome-stderr-tail=' + JSON.stringify(chromeStderr.slice(-1200)));
    }
  }
}

async function humanPointerClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanActionPause(page);
  await locator.hover().catch(() => {});
  await humanActionPause(page);
  const box = await locator.boundingBox();
  if (!box) throw new BrowserAgentError('VISIBLE_CONTROL_NOT_CLICKABLE', 'Visible control has no clickable bounding box', true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await humanActionPause(page);
  await page.mouse.down();
  await page.waitForTimeout(randomDelayMs(300, 700));
  await page.mouse.up();
  await humanActionPause(page);
}

async function humanShortPointerClick(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await humanActionPause(page);
  const box = await locator.boundingBox();
  if (!box) throw new BrowserAgentError('VISIBLE_CONTROL_NOT_CLICKABLE', 'Visible short-click target has no clickable bounding box', true);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  await page.waitForTimeout(randomDelayMs(120, 280));
  await page.mouse.down();
  await page.waitForTimeout(randomDelayMs(70, 160));
  await page.mouse.up();
  await humanActionPause(page);
}

async function composerDiagnostics(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].slice(-50).map((b, i) => ({
      i,
      text: (b.innerText || '').trim().slice(0, 80),
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid'),
      disabled: !!b.disabled,
      type: b.getAttribute('type')
    }));
    const editables = [...document.querySelectorAll('textarea,[contenteditable="true"]')].slice(-20).map((e, i) => ({
      i,
      tag: e.tagName,
      id: e.id,
      role: e.getAttribute('role'),
      aria: e.getAttribute('aria-label'),
      placeholder: e.getAttribute('placeholder'),
      testid: e.getAttribute('data-testid'),
      textLength: String(e.innerText || e.value || '').length
    }));
    return { buttons, editables, url: location.href, title: document.title };
  });
}

function normalizeVisibleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function visibleMessageMarker(message, maxLength = 160) {
  return normalizeVisibleText(message).slice(0, maxLength);
}

async function wakeMarkerVisible(page, marker) {
  const normalizedMarker = normalizeVisibleText(marker);
  const users = page.locator('[data-message-author-role="user"]');
  const userCount = await users.count().catch(() => 0);
  for (let i = Math.max(0, userCount - 8); i < userCount; i += 1) {
    const user = users.nth(i);
    if (!await user.isVisible().catch(() => false)) continue;
    const text = normalizeVisibleText(await user.innerText().catch(() => ''));
    if (normalizedMarker && text.includes(normalizedMarker)) {
      return { visible: true, userCount, method: 'user-role' };
    }
  }

  return {
    visible: false,
    userCount,
    method: 'not-visible'
  };
}

async function readComposerText(composer) {
  return await composer.inputValue().catch(async () => {
    return await composer.innerText().catch(() => '');
  });
}

async function clearComposer(page, composer) {
  const currentText = await readComposerText(composer);
  if (!currentText) return;
  await x11Key(['key', '--clearmodifiers', 'ctrl+a'], 'x11-select-all');
  await page.waitForTimeout(randomDelayMs(90, 160));
  await x11Key(['key', '--clearmodifiers', 'BackSpace'], 'x11-backspace');
  await page.waitForTimeout(randomDelayMs(120, 220));
}

async function verifyComposerMessage(composer, message, label) {
  const filledText = await readComposerText(composer);
  const normalizedFilled = normalizeVisibleText(filledText);
  const normalizedMessage = normalizeVisibleText(message);
  const marker = visibleMessageMarker(message);
  const minimumExpectedLength = Math.min(marker.length, Math.floor(normalizedMessage.length * 0.9));
  const prefixMatches = marker.length > 0 && normalizedFilled.includes(marker);
  const lengthLooksPlausible = normalizedFilled.length >= minimumExpectedLength;
  console.log(`[github-playwright] ${label}=` + JSON.stringify({
    normalizedFilledLength: normalizedFilled.length,
    normalizedMessageLength: normalizedMessage.length,
    markerLength: marker.length,
    prefixMatches,
    lengthLooksPlausible
  }));
  return { prefixMatches, lengthLooksPlausible };
}

async function fillComposer(page, message) {
  const composer = await ensureComposer(page);
  await humanPointerClick(page, composer);
  await clearComposer(page, composer);

  const text = String(message);
  console.log('[github-playwright] composer-fill-strategy=human-x11-skilled-typist-per-character length=' + text.length);

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    await x11Key(['type', '--clearmodifiers', '--delay', '0', char], 'x11-type-character');
    await humanTypingPause(page, char);

    if ((i + 1) % 250 === 0 || i === text.length - 1) {
      const visible = await readComposerText(composer);
      const visibleLength = normalizeVisibleText(visible).length;
      if (!visible || visibleLength === 0) {
        throw new BrowserAgentError(
          'COMPOSER_HUMAN_TYPE_LOST',
          'Visible composer lost X11 human-typed text during per-character entry',
          true
        );
      }
      console.log('[github-playwright] human-x11-keyboard-progress=' + JSON.stringify({
        typedCharacters: i + 1,
        totalCharacters: text.length,
        visibleLength
      }));
    }
  }

  await humanActionPause(page);

  const verification = await verifyComposerMessage(composer, message, 'composer-human-x11-skilled-typist-verification');
  if (!verification.prefixMatches || !verification.lengthLooksPlausible) {
    throw new BrowserAgentError(
      'COMPOSER_FILL_MISMATCH',
      'Composer did not retain the normalized wake marker after visible X11 human typing',
      true
    );
  }
  return composer;
}

async function post(page, message) {
  if (!message) throw new Error('Wake message is empty');
  const marker = visibleMessageMarker(message);
  if (messagePurpose === 'initial_wake') {
    console.log('[github-playwright] chat-idle-wait=skipped-for-initial-wake');
  } else {
    const requestedIdleWait = Number.parseInt(env.IDLE_WAIT_MS || '600000', 10);
    const idleWaitMs = Number.isFinite(requestedIdleWait) ? Math.max(30000, requestedIdleWait) : 600000;
    await waitForChatIdle(page, idleWaitMs);
  }

  let composer = await fillComposer(page, message);
  console.log('[github-playwright] composer-diagnostics=' + JSON.stringify(await composerDiagnostics(page)));

  const send = await firstVisible(page, [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[aria-label*="Send"]'
  ]);

  if (send) {
    console.log('[github-playwright] send-strategy=human-short-pointer-click');
    await humanShortPointerClick(page, send);
    await page.waitForTimeout(randomDelayMs(1400, 2200));

    const quickVisible = await wakeMarkerVisible(page, marker);
    if (!quickVisible.visible) {
      composer = await ensureComposer(page);
      const composerAfterFirstClick = await composer.inputValue().catch(async () => {
        return await composer.innerText().catch(() => '');
      });
      const normalizedAfterFirstClick = normalizeVisibleText(composerAfterFirstClick);
      if (normalizedAfterFirstClick.includes(marker)) {
        const retrySend = await firstVisible(page, [
          'button[data-testid="send-button"]',
          'button[data-testid="composer-submit-button"]',
          'button[aria-label="Send prompt"]',
          'button[aria-label="Send"]',
          'button[aria-label*="Send"]'
        ]);
        if (!retrySend) {
          throw new BrowserAgentError('SEND_CONTROL_MISSING_ON_RETRY', 'Wake remained in composer after first Send click and no visible Send control was available for retry', true);
        }
        console.log('[github-playwright] send-retry=human-short-pointer-click reason=message-still-in-composer');
        await humanShortPointerClick(page, retrySend);
        await page.waitForTimeout(randomDelayMs(900, 1500));
      }
    }
  } else {
    composer = await ensureComposer(page);
    console.log('[github-playwright] send-strategy=human-x11-keyboard-enter');
    await x11Key(['key', '--clearmodifiers', 'Return'], 'x11-send-enter');
    await page.waitForTimeout(randomDelayMs(280, 420));
  }

  const deadline = Date.now() + 90000;
  let dom = { visible: false, userCount: 0, method: 'not-visible' };
  while (Date.now() < deadline) {
    dom = await wakeMarkerVisible(page, marker);
    if (dom.visible) {
      console.log('[github-playwright] send-visible-marker=' + JSON.stringify(dom));
      return {
        domMarkerObserved: true,
        userCount: dom.userCount,
        verificationMethod: dom.method
      };
    }
    await page.waitForTimeout(750);
  }

  throw new BrowserAgentError(
    'SEND_NOT_VISIBLE',
    'Wake message was submitted through the visible composer but did not become visibly rendered within 90 seconds',
    false
  );
}

async function persistedWakeVisible(page, message, timeoutMs = 90000) {
  const marker = visibleMessageMarker(message);
  const deadline = Date.now() + timeoutMs;
  let state = { visible: false, userCount: 0, method: 'not-visible' };
  while (Date.now() < deadline) {
    state = await wakeMarkerVisible(page, marker);
    if (state.visible) return { persisted: true, ...state };
    await page.waitForTimeout(750);
  }
  return { persisted: false, ...state };
}

async function waitForDurableChatUrl(page, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await snapshot(page).catch(() => null);
    if (state?.humanChallenge) {
      throw new BrowserAgentError(
        'BROWSER_CHALLENGE',
        'Visible ChatGPT/Cloudflare verification detected while waiting for durable chat URL; aborting workflow immediately',
        false
      );
    }
    if (durableChatUrl(page.url())) {
      console.log('[github-playwright] durable-chat-route=' + JSON.stringify({ url: page.url() }));
      return page.url();
    }
    await page.waitForTimeout(500);
  }
  throw new BrowserAgentError(
    'CHAT_URL_NOT_DURABLE',
    'Fresh chat did not transition from its optimistic/local route to a durable chat URL within 5 minutes',
    false
  );
}

async function humanReload(page) {
  console.log('[github-playwright] verification-reload=human-x11-control-r');
  await x11Key(['key', '--clearmodifiers', 'ctrl+r'], 'x11-reload');
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function postWithVisibleVerification(page, message) {
  const submittedRequest = await post(page, message);

  const beforeReload = await persistedWakeVisible(page, message, 90000);
  console.log('[github-playwright] visible-wake-before-reload=' + JSON.stringify({
    ...beforeReload,
    chatUrl: page.url()
  }));
  if (!beforeReload.persisted) {
    throw new BrowserAgentError(
      'DURABILITY_NOT_VISIBLE',
      'Wake message was not visibly rendered before persistence reload',
      false
    );
  }

  if (mode === 'create_fresh' && !durableChatUrl(page.url())) {
    await waitForDurableChatUrl(page, 300000);
  }

  if (mode === 'resume_existing' && messagePurpose === 'initial_wake') {
    const passiveState = await snapshot(page).catch(() => null);
    if (passiveState?.humanChallenge) {
      throw new BrowserAgentError(
        'POST_SEND_CHALLENGE',
        'A visible human challenge appeared after wake submission; delivery is not accepted',
        true
      );
    }
    if (beforeReload.method !== 'user-role' || beforeReload.userCount < 1) {
      throw new BrowserAgentError(
        'USER_MESSAGE_NOT_RENDERED',
        'Wake marker was not verified inside an actual rendered user message',
        true
      );
    }
    const delivery = {
      writeRequestObserved: false,
      writeAccepted: true,
      responseBodyMarkerObserved: false,
      domPersisted: true,
      verification: 'visible-user-message',
      verificationMethod: beforeReload.method,
      postSendChallenge: false,
      postSendHealth: null,
      response: null,
      responseCandidates: [],
      submittedRequest,
      persisted: true,
      userCount: beforeReload.userCount
    };
    console.log('[github-playwright] delivery-state=existing-chat-user-message-verified ' + JSON.stringify(delivery));
    return delivery;
  }

  await humanReload(page);
  await waitForVisibleBrowserReady(page, 'post-send persistence reload');

  const afterReload = await persistedWakeVisible(page, message, 90000);
  console.log('[github-playwright] visible-wake-after-reload=' + JSON.stringify({
    ...afterReload,
    chatUrl: page.url()
  }));
  if (!afterReload.persisted) {
    throw new BrowserAgentError(
      'DURABILITY_NOT_VISIBLE_AFTER_RELOAD',
      'Wake message was not visibly rendered after human-style reload',
      false
    );
  }

  const passiveState = await snapshot(page).catch(() => null);
  const delivery = {
    writeRequestObserved: false,
    writeAccepted: true,
    responseBodyMarkerObserved: false,
    domPersisted: true,
    verification: 'visible-browser-only',
    verificationMethod: afterReload.method,
    postSendChallenge: passiveState?.humanChallenge === true,
    postSendHealth: null,
    response: null,
    responseCandidates: [],
    submittedRequest,
    persisted: true,
    userCount: afterReload.userCount
  };
  console.log('[github-playwright] delivery-state=' + JSON.stringify(delivery));
  return delivery;
}


async function waitForVisibleBrowserReady(page, reason = 'visible browser readiness') {
  const requested = Number.parseInt(env.MANUAL_CHALLENGE_WAIT_MS || '0', 10);
  const waitMs = Number.isFinite(requested) ? Math.max(0, requested) : 0;
  const deadline = Date.now() + waitMs;

  while (true) {
    const state = await snapshot(page).catch(() => null);
    const ready = Boolean(
      state?.composerVisible &&
      !state?.loginPrompt &&
      !state?.humanChallenge &&
      !state?.conversationUnavailable
    );

    console.log('[github-playwright] visible-browser-ready=' + JSON.stringify({
      reason,
      ready,
      url: state?.url || page.url(),
      composerVisible: state?.composerVisible ?? false,
      loginPrompt: state?.loginPrompt ?? false,
      humanChallenge: state?.humanChallenge ?? false,
      conversationUnavailable: state?.conversationUnavailable ?? false
    }));

    if (state?.humanChallenge) {
      throw new BrowserAgentError(
        'BROWSER_CHALLENGE',
        'Visible ChatGPT/Cloudflare verification detected; aborting workflow immediately',
        false
      );
    }
    if (ready) return state;
    if (Date.now() >= deadline) {
      if (state?.loginPrompt) {
        throw new BrowserAgentError('AUTH_REQUIRED', 'Visible ChatGPT browser requires login', false);
      }
      throw new BrowserAgentError('VISIBLE_BROWSER_NOT_READY', 'Visible ChatGPT browser did not become ready within the configured 5-minute wait', true);
    }

    if (bool(env.INTERACTIVE_VIEW_ENABLED)) {
      const vnc = env.TAILSCALE_RUNNER_IP ? env.TAILSCALE_RUNNER_IP + ':5900' : 'the private runner VNC endpoint';
      console.log('[github-playwright] Visible browser is not ready at ' + vnc + '; waiting only for ordinary UI/login readiness. Cloudflare challenge aborts immediately.');
    }
    await page.waitForTimeout(5000);
  }
}

async function runWithPage(providerName, connect) {
  const { browser, context, page, close } = await connect();
  try {
    if (mode === 'resume_existing') {
      if (!durableChatUrl(requestedUrl)) {
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

    await waitForVisibleBrowserReady(page, 'initial browser session');
    await ensureComposer(page);

    let routine = null;
    let routineBefore = [];
    if (mode === 'create_fresh' && browserRoutineId) {
      await ensureComposer(page);
      routine = await loadBrowserRoutine(browserRoutineId);
      const routineVars = {
        projectName,
        projectUrl,
        chatName: requestedChatName,
        campaignId: env.CAMPAIGN_ID || '',
        phaseId: env.PHASE_ID || ''
      };
      routineBefore = await runBrowserRoutineStage({
        page,
        routine,
        stage: 'before_message',
        vars: routineVars,
      });
      const capturedShare = routineBefore.find((entry) => entry.operation === 'chatgpt.capture_project_share_link')?.result;
      const openedProject = routineBefore.find((entry) => entry.operation === 'chatgpt.open_project_url')?.result;
      const namedProject = routineBefore.find((entry) => entry.operation === 'chatgpt.open_project_by_name')?.result;
      const projectResult = capturedShare || openedProject || namedProject ||
        [...routineBefore].reverse().find((entry) => entry?.result?.projectUrl)?.result;
      projectUrl = projectResult?.projectUrl || projectUrl || '';

      if (routineBefore.some((entry) => entry.operation === 'chatgpt.capture_project_share_link')) {
        try {
          const parsed = new URL(projectUrl);
          if (parsed.origin !== 'https://chatgpt.com' || parsed.pathname === '/' || /\/c\//.test(parsed.pathname)) {
            throw new Error('invalid project URL');
          }
        } catch {
          throw new BrowserAgentError(
            'PROJECT_SHARE_URL_REQUIRED',
            'Project creation did not return a valid private ChatGPT Project share URL; the managed wake cannot be sent.',
            true,
          );
        }
      }
    }

    const before = await snapshot(page);

    if (action === 'observe') {
      // A browser/security challenge or login wall is provider/session
      // infrastructure, not an observation of the reviewer. Surface it to
      // the watchdog without misclassifying reviewer state.
      if (before.humanChallenge) {
        throw new BrowserAgentError(
          'BROWSER_CHALLENGE',
          'Observation provider is blocked by a browser/security challenge at ' + before.url,
          true,
        );
      }
      if (before.loginPrompt) {
        throw new BrowserAgentError(
          'AUTH_REQUIRED',
          'Observation provider is not authenticated at ' + before.url,
          false,
        );
      }
      const sessionStatePersisted = false;
      const result = { ok: true, provider: providerName, action, wakeId, sessionStatePersisted, ...before };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    if (before.generating && !bool(env.FORCE_WAKE)) {
      const sessionStatePersisted = false;
      const result = { ok: true, provider: providerName, action, wakeId, skipped: 'PRODUCTIVE_GENERATING', sessionStatePersisted, ...before };
      await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
      return result;
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

    let thinkingEffortResult = null;
    if (thinkingEffort && mode !== 'resume_existing') {
      await ensureComposer(page);
      thinkingEffortResult = await executeBrowserOperation({
        page,
        name: 'chatgpt.ensure_thinking_effort',
        args: { level: thinkingEffort },
      });
    } else if (thinkingEffort && mode === 'resume_existing') {
      thinkingEffortResult = {
        level: thinkingEffort,
        changed: false,
        verified: false,
        preservedExistingChatConfiguration: true
      };
      console.log('[github-playwright] thinking-effort=preserve-existing-chat-configuration');
    }

    const delivery = await postWithVisibleVerification(page, wakeMessage);

    // Once submission is verified, never fail over to another browser provider for
    // post-delivery UI bookkeeping. Doing so can create a second reviewer chat.
    let response = null;
    let after = before;
    let routineAfter = [];
    const postDeliveryWarnings = [];
    try {
      if (action === 'wake_and_wait') {
        const requestedWait = Number.parseInt(env.RESPONSE_WAIT_MS || '120000', 10);
        const responseWaitMs = Number.isFinite(requestedWait) ? Math.max(120000, requestedWait) : 120000;
        response = await waitForAssistantResponse(page, before, responseWaitMs);
        after = response.snapshot;
      } else {
        await page.waitForTimeout(1500);
        after = await snapshot(page);
      }

      if (mode === 'create_fresh' && !durableChatUrl(after.url)) {
        // A local-chatgpt temporary route is not a reopenable reviewer chat.
        await page.waitForURL(url => durableChatUrl(url.toString()), { timeout: 60000 }).catch(() => {});
        after = await snapshot(page);
      }

      if (routine) {
        routineAfter = await runBrowserRoutineStage({
          page,
          routine,
          stage: 'after_message',
          vars: { projectName, projectUrl, chatName: requestedChatName, campaignId: env.CAMPAIGN_ID || '', phaseId: env.PHASE_ID || '' },
        });
        after = await snapshot(page);
      }
    } catch (error) {
      postDeliveryWarnings.push({
        code: 'POST_DELIVERY_BOOKKEEPING_FAILED',
        error: error?.message || String(error),
      });
      after = await snapshot(page).catch(() => ({ ...before, url: page.url() }));
    }

    const renameResult = [...routineAfter].reverse().find((entry) => entry.operation === 'chatgpt.rename_current_chat')?.result || null;
    const sessionStatePersisted = false;
    const chatUrlVerified = durableChatUrl(after.url);
    const result = {
      // A posted message with no durable conversation cannot activate a reviewer.
      // Return normally so the provider loop never posts it again elsewhere.
      ok: chatUrlVerified, provider: providerName, action, wakeId, posted: true, before, after, sessionStatePersisted,
      chatUrlVerified,
      ...(!chatUrlVerified ? { failures: [{ provider: providerName, code: 'CHAT_URL_NOT_DURABLE', retryable: false,
        error: 'Message submission was observed but no durable reviewer chat URL appeared within 60 seconds; do not repeat the initial message blindly.' }] } : {}),
      chatUrl: after.url,
      browserRoutineId: browserRoutineId || null,
      projectName: projectName || null,
      projectUrl: projectUrl || null,
      requestedChatName: requestedChatName || null,
      chatRenamed: renameResult?.renamed ?? null,
      thinkingEffort: thinkingEffortResult,
      delivery,
      postDeliveryWarnings,
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
  console.log('[github-playwright] Using immutable bootstrap-secret session state; run state will be discarded.');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });
  const context = await browser.newContext({
    storageState: storage
  });
  const page = await context.newPage();
  return { browser, context, page, close: () => browser.close() };
}

await hydrateBrowserContextFromRegistration();

if (mode !== 'resume_existing') {
  const failedResult = {
    ok: false,
    wakeId,
    failures: [{
      provider: 'audit-browser-policy',
      code: 'CREATE_FRESH_RETIRED',
      retryable: false,
      error: 'Current audit automation is resume-existing only; create-fresh browser interaction is retired.'
    }]
  };
  await fs.writeFile(statePath, JSON.stringify(failedResult, null, 2) + '\n', 'utf8');
  console.error('[audit-browser-policy] create-fresh mode is retired.');
  process.exit(1);
}

if (action !== 'wake') {
  const failedResult = {
    ok: false,
    wakeId,
    failures: [{
      provider: 'audit-browser-policy',
      code: 'CHATGPT_PAGE_READS_DISABLED',
      retryable: false,
      error: 'Current audit automation does not perform ChatGPT page observation/read actions.'
    }]
  };
  await fs.writeFile(statePath, JSON.stringify(failedResult, null, 2) + '\n', 'utf8');
  console.error('[audit-browser-policy] ChatGPT page observation is disabled.');
  process.exit(1);
}

const { chromium } = await loadModules();

if (mode === 'resume_existing' && action === 'wake') {
  try {
    const result = await runNormalChromeExistingSession(chromium);
    console.log(JSON.stringify(result));
    process.exit(result.ok === true ? 0 : 1);
  } catch (error) {
    const failure = {
      provider: 'normal-system-chrome-x11',
      code: error?.code || 'PROVIDER_ERROR',
      retryable: error?.retryable === true,
      error: error?.message || String(error)
    };
    const failedResult = { ok: false, wakeId, failures: [failure] };
    await fs.writeFile(statePath, JSON.stringify(failedResult, null, 2) + '\n', 'utf8');
    console.error('[normal-system-chrome-x11] ' + failure.error);
    console.error(JSON.stringify(failedResult));
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
    failures.push({
      provider: name,
      code: error?.code || 'PROVIDER_ERROR',
      retryable: error?.retryable === true,
      error: error.message,
    });
    console.error('[' + name + '] ' + error.message);
  }
}
if (action === 'observe') {
  const challengeFailure = failures.find((entry) => entry.code === 'BROWSER_CHALLENGE');
  const authFailure = failures.find((entry) => entry.code === 'AUTH_REQUIRED');
  if (challengeFailure || authFailure) {
    const result = {
      ok: true,
      provider: null,
      action,
      wakeId,
      sessionStatePersisted: false,
      generating: false,
      composerVisible: false,
      conversationUnavailable: false,
      loginPrompt: !!authFailure && !challengeFailure,
      humanChallenge: !!challengeFailure,
      chatViewable: false,
      assistantCount: 0,
      userCount: 0,
      lastAssistantHash: '',
      lastAssistantLength: 0,
      url: requestedUrl,
      providerFailures: failures,
    };
    await fs.writeFile(statePath, JSON.stringify(result, null, 2) + '\n');
    console.warn(JSON.stringify(result));
    process.exit(0);
  }
}

const failedResult = {
  ok: false,
  wakeId,
  failures,
  browserRoutineId: browserRoutineId || null,
  projectName: projectName || null,
  projectUrl: projectUrl || null,
};
await fs.writeFile(statePath, JSON.stringify(failedResult, null, 2) + '\n');
console.error(JSON.stringify(failedResult));
process.exit(1);

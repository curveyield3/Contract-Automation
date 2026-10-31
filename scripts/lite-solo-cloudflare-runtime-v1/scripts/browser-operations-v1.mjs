const PROJECT_LINK_PATTERNS = [
  'a',
  'button',
  '[role="button"]'
];

async function firstVisible(page, selectors, timeout = 900) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout })) return locator;
    } catch {}
  }
  return null;
}

async function firstVisibleText(page, texts, { exact = true, timeout = 900 } = {}) {
  for (const text of texts) {
    for (const selector of PROJECT_LINK_PATTERNS) {
      const locator = page.locator(selector).filter({ hasText: text }).first();
      try {
        if (await locator.isVisible({ timeout })) {
          if (!exact) return locator;
          const observed = (await locator.innerText().catch(() => '')).trim();
          if (observed === text) return locator;
        }
      } catch {}
    }
  }
  return null;
}

async function waitForComposer(page, timeoutMs = 15000) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]'
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = await firstVisible(page, selectors, 500);
    if (composer) return composer;
    await page.waitForTimeout(350);
  }
  return null;
}

async function ensureChatMode(page) {
  const workSelected = await firstVisible(page, [
    '[role="tab"][aria-selected="true"]:has-text("Work")',
    'button[aria-pressed="true"]:has-text("Work")'
  ], 400);

  const chatSelected = await firstVisible(page, [
    '[role="tab"][aria-selected="true"]:has-text("Chat")',
    'button[aria-pressed="true"]:has-text("Chat")'
  ], 400);

  if (chatSelected) return { mode: 'chat', changed: false };

  const chat = await firstVisible(page, [
    '[role="tab"]:has-text("Chat")',
    'button:has-text("Chat")'
  ], 1000);

  if (workSelected || chat) {
    if (!chat) throw new Error('ChatGPT Chat mode control not found while Work mode appears active');
    await humanPointerClick(page, chat, { hoverMs: 180, downMs: 65, settleMs: 650 });
    const composer = await waitForComposer(page, 12000);
    if (!composer) throw new Error('ChatGPT Chat mode did not expose a composer after selecting Chat');
    return { mode: 'chat', changed: true };
  }

  // If neither segmented control is present, a composer means Chat mode is
  // already active in the current desktop layout.
  const composer = await waitForComposer(page, 2500);
  if (composer) return { mode: 'chat', changed: false };

  throw new Error('ChatGPT Chat mode could not be established');
}

async function ensureThinkingEffort(page, { level = 'high' } = {}) {
  const normalized = String(level || '').trim().toLowerCase();
  if (normalized !== 'high') {
    throw new Error('chatgpt.ensure_thinking_effort currently requires level=high');
  }

  const highSelectors = [
    '[role="menuitemradio"]:has-text("High")',
    '[role="option"]:has-text("High")',
    '[role="radio"]:has-text("High")',
    '[role="menuitem"]:has-text("High")',
    'button:has-text("High")',
    'label:has-text("High")'
  ];

  const visibleHighChoice = async () => firstVisible(page, highSelectors, 650);

  // The current picker exposes a Power menu row with a keyboard-controlled
  // reasoning slider. Verify both its numeric endpoint and spoken High label.
  const powerRow = () => page.locator('[data-reasoning-slider="true"][role="menuitem"][aria-label="Power"]').first();
  const sliderHigh = async () => {
    const row = powerRow();
    if (!await row.isVisible().catch(() => false)) return false;
    const slider = row.locator('[role="slider"]').first();
    const current = await slider.getAttribute('aria-valuenow').catch(() => null);
    const max = await slider.getAttribute('aria-valuemax').catch(() => null);
    if (current === null || max === null || current !== max) return false;
    const describedBy = await row.getAttribute('aria-describedby').catch(() => '');
    for (const id of String(describedBy || '').split(/\s+/).filter(Boolean)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const label = await page.locator('[id="' + id + '"]').innerText().catch(() => '');
      if (/^High(?:,|$)/i.test(label.trim())) return true;
    }
    return false;
  };
  const chooseSliderHigh = async () => {
    const row = powerRow();
    if (!await row.isVisible().catch(() => false)) return false;
    const slider = row.locator('[role="slider"]').first();
    const min = Number(await slider.getAttribute('aria-valuemin'));
    const max = Number(await slider.getAttribute('aria-valuemax'));
    let current = Number(await slider.getAttribute('aria-valuenow'));
    // Admit only the observed three-position Low/Medium/High widget.
    if (min !== 0 || max !== 2 || !Number.isInteger(current) || current < min || current > max) return false;
    for (let step = current; step < max; step += 1) {
      await row.press('ArrowRight');
      await page.waitForTimeout(200);
      const next = Number(await slider.getAttribute('aria-valuenow'));
      if (next !== current + 1) return false;
      current = next;
    }
    const verified = await sliderHigh();
    if (verified) await row.press('Escape');
    return verified;
  };

  const selectedHigh = async () => {
    if (await sliderHigh()) return true;
    const selectors = [
      '[role="menuitemradio"][aria-checked="true"]:has-text("High")',
      '[role="radio"][aria-checked="true"]:has-text("High")',
      '[role="option"][aria-selected="true"]:has-text("High")',
      '[aria-checked="true"]:has-text("High")',
      '[aria-selected="true"]:has-text("High")',
      '[aria-pressed="true"]:has-text("High")',
      '[data-state="checked"]:has-text("High")',
      '[data-state="active"]:has-text("High")'
    ];
    if (await firstVisible(page, selectors, 450)) return true;

    // After selection, current ChatGPT variants may collapse the menu and show
    // the effort as a compact "High" control beside the composer/model button.
    const openPicker = await firstVisible(page, [
      '[role="menu"]:visible',
      '[role="listbox"]:visible',
      '[data-radix-menu-content]:visible'
    ], 150);
    if (!openPicker) {
      const controls = page.locator('button, [role="button"]');
      const count = Math.min(await controls.count().catch(() => 0), 100);
      for (let i = 0; i < count; i += 1) {
        const control = controls.nth(i);
        if (!await control.isVisible().catch(() => false)) continue;
        const text = (await control.innerText().catch(() => '')).trim();
        const attrs = [
          await control.getAttribute('aria-label').catch(() => ''),
          await control.getAttribute('title').catch(() => ''),
          await control.getAttribute('data-testid').catch(() => '')
        ].filter(Boolean).join(' ');
        if (/^High$/i.test(text) || /(?:thinking|reasoning|effort)[^\n]*\bHigh\b/i.test(text + ' ' + attrs)) return true;
      }
    }
    return false;
  };

  if (await selectedHigh()) return { level: 'high', changed: false, verified: true };

  const openerSelectors = [
    'button[aria-label*="thinking" i]',
    'button[aria-label*="reasoning" i]',
    'button[aria-label*="effort" i]',
    'button[data-testid*="thinking" i]',
    'button[data-testid*="model" i]',
    'button[aria-label*="model" i]',
    'button[aria-haspopup="menu"]:has-text("GPT")',
    'button:has-text("GPT-5.6")',
    'button:has-text("GPT-5")',
    'button:has-text("Thinking")',
    'button:has-text("Think")',
    'button:has-text("Reasoning")',
    'button:has-text("Instant")',
    'button:has-text("Medium")'
  ];

  const chooseHigh = async () => {
    if (await chooseSliderHigh()) return true;
    const high = await visibleHighChoice();
    if (!high) return false;
    await humanPointerClick(page, high);
    await page.waitForTimeout(700);
    if (await selectedHigh()) return true;

    // Some menu implementations keep the picker open after the click. In that
    // case verify selection state on the option or its nearest interactive row.
    const candidates = [
      high,
      high.locator('xpath=ancestor-or-self::*[@role="menuitemradio" or @role="radio" or @role="option" or @role="menuitem"][1]'),
      high.locator('xpath=ancestor-or-self::*[@data-state][1]')
    ];
    for (const candidate of candidates) {
      for (const [name, expected] of [['aria-checked','true'],['aria-selected','true'],['aria-pressed','true'],['data-state','checked'],['data-state','active']]) {
        const value = await candidate.getAttribute(name).catch(() => null);
        if (value === expected) return true;
      }
    }
    return false;
  };

  const submenuLabels = ['Thinking', 'Think', 'Reasoning', 'Thinking time', 'Reasoning effort'];
  for (let depth = 0; depth < 3; depth += 1) {
    if (await chooseHigh()) return { level: 'high', changed: true, verified: true };

    const opener = await firstVisible(page, openerSelectors, 1200);
    if (opener) {
      await humanPointerClick(page, opener);
      await page.waitForTimeout(550);
      if (await chooseHigh()) return { level: 'high', changed: true, verified: true };
    }

    let openedSubmenu = false;
    for (const label of submenuLabels) {
      const submenu = page.getByText(label, { exact: true }).first();
      if (await submenu.isVisible().catch(() => false)) {
        await humanPointerClick(page, submenu);
        await page.waitForTimeout(500);
        openedSubmenu = true;
        if (await chooseHigh()) return { level: 'high', changed: true, verified: true };
      }
    }
    if (!opener && !openedSubmenu) break;
  }

  const diagnostic = [];
  const controls = page.locator('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"]');
  const count = Math.min(await controls.count().catch(() => 0), 120);
  for (let i = 0; i < count && diagnostic.length < 40; i += 1) {
    const control = controls.nth(i);
    if (!await control.isVisible().catch(() => false)) continue;
    const text = (await control.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 140);
    const label = (await control.getAttribute('aria-label').catch(() => '') || '').trim().slice(0, 140);
    const role = (await control.getAttribute('role').catch(() => '') || '').trim();
    if (text || label) diagnostic.push({ role, text, label });
  }
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const relevantText = bodyText.split(/\n+/).map(x => x.trim()).filter(x => /High|Think|Reason|GPT-5|Instant|Medium/i.test(x)).slice(0, 40);
  // Capture only effort-widget structure, never authentication/session data.
  const effortWidget = await page.locator('[role="slider"], input[type="range"], [aria-valuetext], [aria-label*="effort" i]')
    .evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => ({
      tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
      min: el.getAttribute('aria-valuemin') || el.getAttribute('min'),
      max: el.getAttribute('aria-valuemax') || el.getAttribute('max'),
      value: el.getAttribute('aria-valuenow') || el.getAttribute('value'),
      valueText: el.getAttribute('aria-valuetext'),
    }))).catch(() => []);
  const error = new Error(
    'ChatGPT High thinking-effort control could not be selected and verified; effortWidget=' +
    JSON.stringify(effortWidget) + '; visibleControls=' +
    JSON.stringify(diagnostic) + '; relevantText=' + JSON.stringify(relevantText)
  );
  error.code = 'THINKING_EFFORT_UI_CHANGED';
  error.retryable = true;
  throw error;
}
function randomDelayMs(minMs, maxMs) {
  const min = Math.ceil(minMs);
  const max = Math.floor(maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanActionPause(page) {
  await page.waitForTimeout(randomDelayMs(300, 1500));
}

async function humanTypingPause(page) {
  await page.waitForTimeout(randomDelayMs(200, 400));
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
  const current = await locator.inputValue().catch(() => '');
  if (current) {
    await locator.press('Control+A').catch(async () => locator.press('Meta+A').catch(() => {}));
    await humanActionPause(page);
    await locator.press('Backspace');
    await humanActionPause(page);
  }
  for (const char of String(text)) {
    await locator.pressSequentially(char);
    await humanTypingPause(page);
  }
  await humanActionPause(page);
}

async function ensureSidebarOpen(page) {
  const open = await firstVisible(page, [
    'button[data-testid="open-sidebar-button"]',
    'button[data-testid="sidebar-toggle-button"]',
    'button[aria-label="Open sidebar"]',
    'button[aria-label="Toggle sidebar"]',
    'button[aria-label*="Open sidebar"]',
    'button[aria-label*="Show sidebar"]',
    'button[aria-label*="sidebar" i]',
    '[role="button"][aria-label*="sidebar" i]',
    '[data-testid*="sidebar"][role="button"]',
    'button[title*="sidebar" i]'
  ], 500);
  if (open) {
    await humanPointerClick(page, open).catch(() => {});
    await page.waitForTimeout(700);
    return { opened: true };
  }
  return { opened: false };
}

async function findSemanticProjectAction(page) {
  const candidates = page.locator('button, a, [role="button"]');
  const count = Math.min(await candidates.count().catch(() => 0), 160);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const attrs = [
      await candidate.innerText().catch(() => ''),
      await candidate.getAttribute('aria-label').catch(() => ''),
      await candidate.getAttribute('title').catch(() => ''),
      await candidate.getAttribute('data-testid').catch(() => '')
    ].filter(Boolean).join(' ').trim();
    if (/\b(?:new|add|create)\b[^\n]{0,40}\bproject\b|\bproject\b[^\n]{0,40}\b(?:new|add|create)\b/i.test(attrs)) {
      return candidate;
    }
  }
  return null;
}

async function visibleNavigationDiagnostics(page) {
  return page.locator('button, a, [role="button"]').evaluateAll(nodes =>
    nodes.filter(el => el.getClientRects().length).slice(0, 120).map(el => ({
      tag: el.tagName,
      text: String(el.innerText || '').trim().slice(0, 90),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      testid: el.getAttribute('data-testid'),
      href: (() => {
        const raw = el.getAttribute('href') || '';
        return raw.replace(/[a-f0-9]{8}-[a-f0-9-]{12,}/gi, '<id>').slice(0, 140);
      })()
    }))
  ).catch(() => []);
}

async function exposeProjectsInSidebar(page) {
  // 2026 web sidebar redesign can hide Projects from the top-level navigation.
  // Follow the same visible controls a person uses:
  // Chat sidebar options -> Organize sidebar -> Show -> Projects.
  const recents = await firstVisible(page, [
    'button[aria-label="Recents"]',
    'button:has-text("Recents")',
    '[role="button"]:has-text("Recents")'
  ], 700);
  if (recents) {
    await humanPointerClick(page, recents).catch(() => {});
    await page.waitForTimeout(650);
  }

  let organize = await firstVisible(page, [
    'button:has-text("Organize sidebar")',
    '[role="menuitem"]:has-text("Organize sidebar")',
    '[role="button"]:has-text("Organize sidebar")',
    'button[aria-label*="Organize sidebar" i]'
  ], 500);

  let sidebarOptions = null;
  if (!organize) {
    sidebarOptions = await firstVisible(page, [
      'button[aria-label="Chat sidebar options"]',
      '[role="button"][aria-label="Chat sidebar options"]',
      'button[aria-label*="sidebar options" i]',
      '[role="button"][aria-label*="sidebar options" i]'
    ], 900);

    if (sidebarOptions) {
      await humanPointerClick(page, sidebarOptions);
      await page.waitForTimeout(550);
      organize = await firstVisible(page, [
        '[role="menuitem"]:has-text("Organize sidebar")',
        'button:has-text("Organize sidebar")',
        '[role="button"]:has-text("Organize sidebar")',
        '[aria-label*="Organize sidebar" i]'
      ], 1000);
    }
  }

  if (!organize) {
    // Some variants expose the organizer from another visible overflow control.
    const controls = page.locator('button, [role="button"]');
    const count = Math.min(await controls.count().catch(() => 0), 120);
    for (let i = 0; i < count && !organize; i += 1) {
      const control = controls.nth(i);
      if (!await control.isVisible().catch(() => false)) continue;
      const attrs = [
        await control.innerText().catch(() => ''),
        await control.getAttribute('aria-label').catch(() => ''),
        await control.getAttribute('title').catch(() => '')
      ].filter(Boolean).join(' ');
      if (/organize.*sidebar/i.test(attrs)) organize = control;
    }
  }

  if (organize) {
    await humanPointerClick(page, organize);
    await page.waitForTimeout(550);
  }

  // Current UI nests sidebar visibility controls under a visible "Show" submenu.
  // Older variants expose Projects directly, so treat Show as optional.
  const show = await firstVisible(page, [
    '[role="menuitem"]:has-text("Show")',
    '[role="button"]:has-text("Show")',
    'button:has-text("Show")',
    '[aria-label="Show"]',
    '[aria-label*="Show" i]'
  ], 700);
  if (show) {
    await humanPointerClick(page, show);
    await page.waitForTimeout(450);
  }

  const projectsOption = await firstVisible(page, [
    '[role="menuitemcheckbox"]:has-text("Projects")',
    '[role="menuitem"]:has-text("Projects")',
    '[role="checkbox"]:has-text("Projects")',
    'label:has-text("Projects")',
    'button:has-text("Projects")'
  ], 1200);

  if (projectsOption) {
    const checked = await projectsOption.getAttribute('aria-checked').catch(() => null);
    const selected = await projectsOption.getAttribute('aria-selected').catch(() => null);
    const state = await projectsOption.getAttribute('data-state').catch(() => null);
    if (checked !== 'true' && selected !== 'true' && state !== 'checked') {
      await humanPointerClick(page, projectsOption);
      await page.waitForTimeout(900);
    } else {
      await projectsOption.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  await ensureSidebarOpen(page);
  const visible = await page.getByText('Projects', { exact: true }).first().isVisible().catch(() => false);
  console.log('[browser-operations] sidebar-projects-recovery=' + JSON.stringify({
    recentsVisible: Boolean(recents),
    sidebarOptionsFound: Boolean(sidebarOptions),
    organizerFound: Boolean(organize),
    showFound: Boolean(show),
    projectsOptionFound: Boolean(projectsOption),
    projectsVisible: visible
  }));
  return visible;
}

async function findNewProjectControl(page) {
  const direct = await firstVisible(page, [
    'button[aria-label="Add new project"]',
    'button[aria-label*="New project"]',
    'a[aria-label*="New project"]',
    '[role="button"][aria-label*="New project"]',
    'button[title*="New project"]',
    'a[title*="New project"]',
    'button:has-text("New project")',
    'a:has-text("New project")',
    '[role="button"]:has-text("New project")',
    'button:has-text("Create project")'
  ], 700);
  if (direct) return direct;

  const semantic = await findSemanticProjectAction(page);
  if (semantic) return semantic;

  const text = page.getByText('New project', { exact: true }).first();
  if (await text.isVisible().catch(() => false)) return text;
  return null;
}

async function findProjectEntry(page, projectName) {
  const escaped = String(projectName).replace(/"/g, '\\"');
  const direct = await firstVisible(page, [
    `a[aria-label="${escaped}"]`,
    `button[aria-label="${escaped}"]`,
    `a[title="${escaped}"]`,
    `button[title="${escaped}"]`
  ], 500);
  if (direct) return direct;
  return firstVisibleText(page, [projectName], { exact: true, timeout: 700 });
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

async function findProjectsSectionAddControl(page) {
  const projects = page.getByText('Projects', { exact: true }).first();
  if (!await projects.isVisible().catch(() => false)) return null;

  // Caller has already hovered the visible Projects title, revealing contextual controls.

  let region = projects;
  for (let depth = 0; depth < 4; depth += 1) {
    region = region.locator('xpath=..');
    const candidates = region.locator('button, [role="button"]');
    const count = Math.min(await candidates.count().catch(() => 0), 10);

    // Strongly prefer explicit accessible names that mean "add/create project".
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const label = [
        await candidate.getAttribute('aria-label').catch(() => ''),
        await candidate.getAttribute('title').catch(() => ''),
        await candidate.getAttribute('data-testid').catch(() => ''),
      ].filter(Boolean).join(' ');
      if (/(?:add|new|create).*project|project.*(?:add|new|create)/i.test(label)) {
        console.log('[browser-operations] projects-plus-control=' + JSON.stringify({
          method: 'semantic',
          aria: await candidate.getAttribute('aria-label').catch(() => null),
          title: await candidate.getAttribute('title').catch(() => null),
          testid: await candidate.getAttribute('data-testid').catch(() => null),
        }));
        return candidate;
      }
    }

    // If the current UI exposes icon-only controls after hover, distinguish the
    // plus from the overflow menu instead of selecting an arbitrary empty button.
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;

      const text = (await candidate.innerText().catch(() => '')).trim();
      const aria = await candidate.getAttribute('aria-label').catch(() => '');
      const title = await candidate.getAttribute('title').catch(() => '');
      const testid = await candidate.getAttribute('data-testid').catch(() => '');
      const html = await candidate.evaluate(el => el.outerHTML.slice(0, 900)).catch(() => '');
      const box = await candidate.boundingBox().catch(() => null);

      const looksOverflow = /more|overflow|menu|options|ellipsis|\.\.\.|⋯/i.test([text, aria, title, testid, html].join(' '));
      const looksPlus = /add|plus|create|new|M12 5v14|M5 12h14|<line[^>]+x1=["']12["'][^>]+y1=["']5/i.test([text, aria, title, testid, html].join(' '));

      if (!looksOverflow && looksPlus && box && box.width <= 56 && box.height <= 56) {
        console.log('[browser-operations] projects-plus-control=' + JSON.stringify({
          method: 'hover-icon',
          aria: aria || null,
          title: title || null,
          testid: testid || null,
          width: Math.round(box.width),
          height: Math.round(box.height),
        }));
        return candidate;
      }
    }
  }

  const diagnostics = await projects.locator('xpath=..').locator('button, [role="button"]').evaluateAll(nodes =>
    nodes.filter(el => el.getClientRects().length).map(el => ({
      text: String(el.innerText || '').trim().slice(0, 50),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      testid: el.getAttribute('data-testid')
    })).slice(0, 12)
  ).catch(() => []);
  console.log('[browser-operations] projects-hover-controls=' + JSON.stringify(diagnostics));
  return null;
}

function retryableProjectUiError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
}

async function createProject(page, projectName) {
  // Exact normal-human sequence required by operator:
  // sidebar open -> Projects title -> hover Projects -> click revealed + ->
  // type project name letter-by-letter -> click Create Project.
  await ensureSidebarOpen(page);
  await humanActionPause(page);

  const projects = await humanScrollSidebarForProjects(page);
  if (!projects) {
    throw retryableProjectUiError(
      'PROJECTS_SECTION_MISSING',
      'Visible Projects section title could not be found after human-scrolling the open ChatGPT sidebar'
    );
  }

  await projects.hover();
  await humanActionPause(page);

  const trigger = await findProjectsSectionAddControl(page);
  if (!trigger) {
    throw retryableProjectUiError(
      'PROJECT_PLUS_MISSING',
      'Hovering the visible Projects title did not reveal a usable plus control'
    );
  }
  await humanPointerClick(page, trigger);

  let input = await firstVisible(page, [
    '[role="dialog"] input[placeholder*="Project name"]',
    '[role="dialog"] input[aria-label*="Project name"]',
    '[role="dialog"] input[name="name"]',
    '[role="dialog"] input'
  ], 2200);
  if (!input) {
    const pending = page.locator(
      '[role="dialog"] input[placeholder*="Project name"]:visible, ' +
      '[role="dialog"] input[aria-label*="Project name"]:visible, ' +
      '[role="dialog"] input[name="name"]:visible, [role="dialog"] input:visible'
    ).first();
    await pending.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await pending.isVisible().catch(() => false)) input = pending;
  }
  if (!input) {
    throw retryableProjectUiError(
      'PROJECT_NAME_INPUT_MISSING',
      'Visible project-name field was not found in the Project creation dialog'
    );
  }

  await humanTypeInto(page, input, projectName);

  const submit = await firstVisible(page, [
    '[role="dialog"] button:has-text("Create project")',
    '[role="dialog"] button:has-text("Create Project")'
  ], 2000);
  if (!submit) {
    throw retryableProjectUiError(
      'PROJECT_CREATE_SUBMIT_MISSING',
      'Visible Create Project button was not found at the bottom of the Project dialog'
    );
  }

  await humanPointerClick(page, submit);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const title = await page.title().catch(() => '');
    if (/Verify you are human|Checking your browser|Just a moment|Cloudflare|security challenge/i.test(bodyText + '\n' + title)) {
      const error = new Error('Visible ChatGPT/Cloudflare challenge detected after Create Project');
      error.code = 'BROWSER_CHALLENGE';
      error.retryable = false;
      throw error;
    }

    const entry = await findProjectEntry(page, projectName);
    if (entry) return entry;

    const heading = page.getByText(projectName, { exact: true }).first();
    if (await heading.isVisible().catch(() => false)) return null;

    await page.waitForTimeout(750);
  }

  throw retryableProjectUiError(
    'PROJECT_CREATE_VERIFICATION_MISSING',
    'Project was submitted through the visible dialog but did not become visibly identifiable within 60 seconds'
  );
}

function validProjectUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === 'https://chatgpt.com'
      && url.pathname !== '/'
      && !/^\/c\//.test(url.pathname);
  } catch {
    return false;
  }
}

async function openProjectEntry(page, projectName) {
  if (!projectName) throw new Error('chatgpt.open_project_by_name requires projectName');
  await ensureChatMode(page);
  await ensureSidebarOpen(page);
  let entry = await findProjectEntry(page, projectName);
  if (!entry) {
    await exposeProjectsInSidebar(page);
    entry = await findProjectEntry(page, projectName);
  }
  if (!entry) throw new Error('ChatGPT Project not found in sidebar: ' + projectName);
  await humanPointerClick(page, entry);
  await page.waitForTimeout(900);
  return { projectName, projectUrl: page.url(), created: false };
}

async function createProjectOnly(page, { projectName }) {
  if (!projectName) throw new Error('chatgpt.create_project requires projectName');
  await ensureChatMode(page);
  await ensureSidebarOpen(page);
  const existing = await findProjectEntry(page, projectName);
  if (existing) {
    // Recovery only: a prior Phase-1 attempt may have created the Project before
    // failing later. Re-open that exact Project rather than ever creating a duplicate.
    await humanPointerClick(page, existing);
    await page.waitForTimeout(900);
    return { projectName, projectUrl: page.url(), created: false, recoveredExisting: true };
  }
  const entry = await createProject(page, projectName);
  if (entry) {
    await humanPointerClick(page, entry);
    await page.waitForTimeout(900);
  }
  return { projectName, projectUrl: page.url(), created: true, recoveredExisting: false };
}

async function findProjectOverflowControl(page, projectName) {
  await ensureSidebarOpen(page);
  let entry = await findProjectEntry(page, projectName);
  if (!entry) {
    await exposeProjectsInSidebar(page);
    entry = await findProjectEntry(page, projectName);
  }
  if (!entry) throw new Error('ChatGPT Project not found while resolving share menu: ' + projectName);

  await entry.hover().catch(() => {});
  await page.waitForTimeout(350);

  let region = entry;
  for (let depth = 0; depth < 5; depth += 1) {
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
        await candidate.getAttribute('data-testid').catch(() => ''),
        await candidate.evaluate(el => el.outerHTML.slice(0, 700)).catch(() => '')
      ].filter(Boolean).join(' ');
      if (/more|options|overflow|ellipsis|\.\.\.|⋯/i.test(attrs)) return candidate;
    }
  }

  throw new Error('ChatGPT Project overflow (three-dot) control not found for: ' + projectName);
}

async function captureProjectShareLink(page, { projectName }) {
  if (!projectName) throw new Error('chatgpt.capture_project_share_link requires projectName');

  const overflow = await findProjectOverflowControl(page, projectName);
  await humanPointerClick(page, overflow, { hoverMs: 220, downMs: 70, settleMs: 420 });

  const shareProject = await firstVisible(page, [
    '[role="menuitem"]:has-text("Share project")',
    '[role="menuitem"]:has-text("Share Project")',
    'button:has-text("Share project")',
    '[role="button"]:has-text("Share project")'
  ], 1800);
  if (!shareProject) throw new Error('ChatGPT "Share project" menu option not found');
  await humanPointerClick(page, shareProject, { hoverMs: 180, downMs: 65, settleMs: 520 });

  const shareLink = await firstVisible(page, [
    '[role="dialog"] button:has-text("Share link")',
    '[role="dialog"] [role="button"]:has-text("Share link")',
    'button:has-text("Share link")'
  ], 2200);
  if (!shareLink) throw new Error('ChatGPT Project "Share link" button not found');

  await humanPointerClick(page, shareLink, { hoverMs: 180, downMs: 65, settleMs: 420 });
  await page.waitForTimeout(250);

  const projectUrl = await page.evaluate(async () => {
    try { return await navigator.clipboard.readText(); } catch { return ''; }
  });
  if (!validProjectUrl(projectUrl)) {
    const error = new Error('Project Share link did not place a valid ChatGPT Project URL on the clipboard');
    error.code = 'PROJECT_SHARE_URL_MISSING';
    error.retryable = true;
    throw error;
  }

  console.log('[browser-operations] project-share-url-captured=' + JSON.stringify({
    origin: new URL(projectUrl).origin,
    pathname: new URL(projectUrl).pathname
  }));
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
  return { projectName, projectUrl, shared: true };
}

async function openProjectByUrl(page, { projectName, projectUrl }) {
  if (!validProjectUrl(projectUrl)) {
    if (!projectName) {
      const error = new Error('chatgpt.open_project_url requires a persisted ChatGPT Project URL or a recoverable projectName');
      error.code = 'PROJECT_URL_REQUIRED';
      error.retryable = false;
      throw error;
    }
    const recovered = await openProjectEntry(page, projectName);
    const shared = await captureProjectShareLink(page, { projectName });
    return { ...recovered, projectUrl: shared.projectUrl, recoveredProjectUrl: true };
  }
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const title = await page.title().catch(() => '');
  if (/Verify you are human|Checking your browser|Just a moment|Cloudflare|security challenge/i.test(bodyText + '\n' + title)) {
    const error = new Error('Stored ChatGPT Project URL is behind a browser/security challenge');
    error.code = 'BROWSER_CHALLENGE';
    error.retryable = false;
    throw error;
  }
  if (/\bLog in\b|\bSign up\b|Continue with Google|Welcome back/i.test(bodyText)) {
    const error = new Error('Stored ChatGPT Project URL requires authentication');
    error.code = 'AUTH_REQUIRED';
    error.retryable = false;
    throw error;
  }

  return { projectName: projectName || '', projectUrl, created: false, openedByUrl: true };
}

async function findCurrentProjectNewChatControl(page, projectName) {
  const main = page.locator('main, [role="main"]').first();
  if (!await main.isVisible().catch(() => false)) return null;

  if (projectName) {
    const heading = main.getByText(projectName, { exact: true }).first();
    if (await heading.isVisible().catch(() => false)) {
      await heading.hover().catch(() => {});
      await page.waitForTimeout(250);
      let region = heading;
      for (let depth = 0; depth < 5; depth += 1) {
        region = region.locator('xpath=..');
        const buttons = region.locator('button, [role="button"]');
        const count = Math.min(await buttons.count().catch(() => 0), 12);
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          if (!await button.isVisible().catch(() => false)) continue;
          const attrs = [
            await button.innerText().catch(() => ''),
            await button.getAttribute('aria-label').catch(() => ''),
            await button.getAttribute('title').catch(() => ''),
            await button.getAttribute('data-testid').catch(() => '')
          ].filter(Boolean).join(' ');
          if (/(?:new|add|create|start).*chat|chat.*(?:new|add|create|start)/i.test(attrs)) return button;
        }
        for (let i = 0; i < count; i += 1) {
          const button = buttons.nth(i);
          if (!await button.isVisible().catch(() => false)) continue;
          const attrs = [
            await button.innerText().catch(() => ''),
            await button.getAttribute('aria-label').catch(() => ''),
            await button.getAttribute('title').catch(() => ''),
            await button.getAttribute('data-testid').catch(() => ''),
            await button.evaluate(el => el.outerHTML.slice(0, 700)).catch(() => '')
          ].filter(Boolean).join(' ');
          const box = await button.boundingBox().catch(() => null);
          const overflow = /more|options|overflow|ellipsis|\.\.\.|⋯/i.test(attrs);
          const plus = /add|plus|new|M12 5v14|M5 12h14/i.test(attrs);
          if (!overflow && plus && box && box.width <= 56 && box.height <= 56) return button;
        }
      }
    }
  }

  return firstVisible(page, [
    'main button[aria-label*="New chat"]',
    'main button[aria-label*="Add chat"]',
    'main button[aria-label*="Create chat"]',
    'main button:has-text("New chat")',
    'main [role="button"]:has-text("New chat")',
    '[role="main"] button[aria-label*="New chat"]',
    '[role="main"] button[aria-label*="Add chat"]'
  ], 1500);
}

async function startCurrentProjectChat(page, { projectName = '', projectUrl = '' } = {}) {
  const newChat = await findCurrentProjectNewChatControl(page, projectName);
  if (newChat) {
    await humanPointerClick(page, newChat, { hoverMs: 180, downMs: 65, settleMs: 650 });
  } else {
    // A Project landing page may itself expose a blank composer. That is safe.
    // Never treat an already-open /c/... conversation composer as a fresh reviewer chat.
    const existingComposer = await waitForComposer(page, 1200);
    const alreadyInConversation = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+/.test(page.url());
    if (!existingComposer || alreadyInConversation) {
      const controls = await page.locator('main button, main [role="button"], [role="main"] button, [role="main"] [role="button"]')
        .evaluateAll(nodes => nodes.filter(el => el.getClientRects().length).slice(0, 50).map(el => ({
          text: String(el.innerText || '').trim().slice(0, 80),
          aria: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          testid: el.getAttribute('data-testid')
        }))).catch(() => []);
      const error = new Error('ChatGPT Project new-chat (+) control not found on a safe Project landing page; url=' + page.url() + '; visibleMainControls=' + JSON.stringify(controls));
      error.code = 'PROJECT_NEW_CHAT_CONTROL_MISSING';
      error.retryable = true;
      throw error;
    }
  }

  const composer = await waitForComposer(page, 12000);
  if (!composer) {
    const error = new Error('ChatGPT Project chat composer not found after starting a fresh Project chat');
    error.code = 'PROJECT_CHAT_COMPOSER_MISSING';
    error.retryable = true;
    throw error;
  }
  return { projectName, projectUrl: projectUrl || '', ready: true };
}

async function openCurrentChatMenu(page) {
  const current = new URL(page.url());
  const path = current.pathname;
  if (!/^\/c\/[A-Za-z0-9_-]+/.test(path)) return null;

  const anchor = page.locator(`a[href="${path}"]`).first();
  if (await anchor.isVisible().catch(() => false)) {
    await anchor.hover().catch(() => {});
    const row = anchor.locator('xpath=ancestor::*[self::li or @role="listitem" or @data-testid][1]');
    const button = row.locator('button').last();
    if (await button.isVisible().catch(() => false)) return button;
  }

  return firstVisible(page, [
    'button[aria-label*="conversation options"]',
    'button[aria-label*="chat options"]',
    'button[aria-label="More"]'
  ], 900);
}

async function renameCurrentChat(page, { chatName }) {
  if (!chatName) throw new Error('chatgpt.rename_current_chat requires chatName');
  if (!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9_-]+/.test(page.url())) {
    throw new Error('Cannot rename ChatGPT chat before conversation URL exists');
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const menu = await openCurrentChatMenu(page);
    if (menu) {
      await humanPointerClick(page, menu);
      const rename = await firstVisible(page, [
        '[role="menuitem"]:has-text("Rename")',
        'button:has-text("Rename")',
        '[role="menu"] :text("Rename")'
      ], 1200);
      if (rename) {
        await humanPointerClick(page, rename);
        const input = await firstVisible(page, [
          '[role="dialog"] input',
          'input[aria-label*="Rename"]',
          'input[value]'
        ], 1200);
        if (input) {
          await humanTypeInto(page, input, chatName, { delay: 45 });
          const save = await firstVisible(page, [
            '[role="dialog"] button:has-text("Save")',
            '[role="dialog"] button:has-text("Rename")',
            '[role="dialog"] button[type="submit"]'
          ], 1000);
          if (save) await humanPointerClick(page, save);
          else await input.press('Enter');
          await page.waitForTimeout(600);
          const named = page.getByText(chatName, { exact: true }).first();
          if (await named.isVisible().catch(() => false)) {
            return { chatName, renamed: true };
          }
        }
      }
    }
    await page.waitForTimeout(650);
  }
  return { chatName, renamed: false };
}

export const browserOperations = {
  'chatgpt.ensure_chat_mode': async ({ page }) => ensureChatMode(page),
  'chatgpt.ensure_thinking_effort': async ({ page, args }) => ensureThinkingEffort(page, args),
  'chatgpt.create_project': async ({ page, args }) => createProjectOnly(page, args),
  'chatgpt.capture_project_share_link': async ({ page, args }) => captureProjectShareLink(page, args),
  'chatgpt.open_project_url': async ({ page, args }) => openProjectByUrl(page, args),
  'chatgpt.open_project_by_name': async ({ page, args }) => openProjectEntry(page, args.projectName),
  'chatgpt.start_current_project_chat': async ({ page, args }) => startCurrentProjectChat(page, args),
  'chatgpt.rename_current_chat': async ({ page, args }) => renameCurrentChat(page, args),
};

export async function executeBrowserOperation({ page, name, args = {} }) {
  const operation = browserOperations[name];
  if (!operation) throw new Error(`Unsupported browser operation: ${name}`);
  return operation({ page, args });
}

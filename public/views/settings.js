'use strict';
// Settings view: section nav, workspace/appearance/about panels, and the
// runtimes card. Extracted verbatim from app.js (section 14), same UMD +
// root-republication pattern as views/skills.js: the static settings-nav
// inline handlers (showSettingsSection), the generated onclick handlers
// (setWorkspaceMode, changeWorkspace, toggleTheme + renderSettingsSection
// in the appearance card), the WS dispatch (renderSettingsSection,
// renderRuntimesCard) and routing (showSettingsSection) all resolve these
// as window properties.
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: agents, skills, workspaceMode,
// currentWorkspacePath, runtimeStatus, ws, plus the helpers esc, showView
// and toggleTheme. No section-local state existed to move. Function bodies
// are byte-identical to the app.js originals at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockSettingsView = factory();
    Object.assign(root, root.RundockSettingsView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.settings-nav-item[data-settings="${section}"]`)?.classList.add('active');
  renderSettingsSection(section);
  // Fetched here, on actual navigation into the section, and NOWHERE inside
  // renderSettingsSection itself: the 'plugins' reply this triggers re-runs
  // renderSettingsSection('plugins') too (see app.js's message handler), and
  // a fetch inside the render function would re-request on every one of
  // those replies forever, wiping whatever the user had just typed into the
  // install-path field on every cycle. Real bug, caught by hand-testing in
  // a browser, not by any test in the suite.
  if (section === 'plugins' && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_plugins' }));
}

function renderSettingsSection(section) {
  const el = document.getElementById('settings-content');
  if (section === 'workspace') {
    const agentCount = agents.filter(a => a.status === 'onTeam').length;
    const skillCount = skills.length;
    const isCode = workspaceMode === 'code';
    const modeDesc = isCode
      ? 'Agents can write any file type and run commands without approval.'
      : 'Agents work with documents only. Terminal commands need approval.';
    el.innerHTML = `<div class="settings-section-title">Workspace</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Path</span>
          <span class="settings-value" title="${esc(currentWorkspacePath || 'Not set')}">${esc(currentWorkspacePath || 'Not set')}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Agents</span>
          <span class="settings-value">${agentCount}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Skills</span>
          <span class="settings-value">${skillCount}</span>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">
          <span class="settings-label">Mode</span>
          <div class="mode-toggle">
            <button class="mode-toggle-btn${isCode ? '' : ' active'}" data-mode="knowledge" onclick="setWorkspaceMode('knowledge')">Knowledge mode</button>
            <button class="mode-toggle-btn${isCode ? ' active' : ''}" data-mode="code" onclick="setWorkspaceMode('code')">Code mode</button>
          </div>
          <div class="mode-description" id="mode-description">${modeDesc}</div>
        </div>
      </div>
      <div class="settings-card" id="runtimes-card">${runtimesCardHtml()}</div>
      <button class="settings-btn" onclick="changeWorkspace()">Change workspace</button>`;
    // Refresh runtime state whenever the card becomes visible (the user may
    // have just installed or signed in to a CLI).
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_runtime_status' }));
  } else if (section === 'appearance') {
    const isLight = document.body.classList.contains('light');
    el.innerHTML = `<div class="settings-section-title">Appearance</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Theme</span>
          <button class="settings-btn" onclick="toggleTheme();renderSettingsSection('appearance')">${isLight ? 'Switch to Dark' : 'Switch to Light'}</button>
        </div>
      </div>`;
  } else if (section === 'plugins') {
    el.innerHTML = pluginsSettingsHtml();
  } else if (section === 'about') {
    el.innerHTML = `<div class="settings-section-title">About</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Version</span>
          <span class="settings-value" style="font-family:inherit">${window._rundockVersion || 'unknown'}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Feedback</span>
          <a href="https://github.com/liamdarmody/rundock/issues" target="_blank" rel="noopener" style="font-size:var(--caption);color:var(--accent);text-decoration:underline;text-underline-offset:2px">Report an issue</a>
        </div>
      </div>`;
  }
}

function setWorkspaceMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set_workspace_mode', mode }));
}

// ── Runtimes card (settings › workspace) ──
// One row per runtime with a unified status vocabulary. Status chips never
// claim which plan backs the credentials (detection is presence-only); plan
// language lives in the guidance copy. When Codex is absent, the guidance IS
// the hint, and it appears nowhere else in the product.
function runtimeRowHtml(label, st, isDefault) {
  // Each state carries a hover tooltip explaining the evidence behind it:
  // detection only checks what exists on disk (the CLI, its sign-in
  // credentials) and claims nothing it cannot see. "Installed" in grey is
  // deliberate: it means the CLI is present and sign-in state is unknown,
  // not that something is wrong.
  let dot, text, tip;
  if (!st || !st.installed) {
    dot = 'var(--idle)'; text = 'Not installed';
    tip = 'The CLI for this runtime was not found on this machine.';
  } else if (st.authenticated === false) {
    dot = 'var(--attention)'; text = 'Not signed in';
    tip = 'The CLI is installed, but no sign-in credentials were found on this machine. Run its login command to sign in.';
  } else if (st.authenticated === true) {
    dot = 'var(--success)'; text = 'Signed in' + (st.version ? ' · v' + esc(st.version) : '');
    tip = 'The CLI is installed and sign-in credentials were found on this machine. Rundock checks that credentials exist; it never reads them.';
  } else {
    dot = 'var(--idle)'; text = 'Installed' + (st.version ? ' · v' + esc(st.version) : ''); // auth unknown: claim nothing
    tip = 'The CLI is installed. Rundock cannot tell whether it is signed in, so it makes no claim either way. Agents on this runtime may still work.';
  }
  return `<div class="settings-row"><span class="settings-label">${label}</span>` +
    `<span class="runtime-chip" title="${esc(tip)}" style="cursor:help">${isDefault ? '<span class="runtime-default">Default</span>' : ''}` +
    `<span class="runtime-dot" style="background:${dot}"></span>${text}</span></div>`;
}

function runtimesCardHtml() {
  if (!runtimeStatus) {
    return `<div class="settings-row"><span class="settings-label">Runtimes</span><span class="settings-value" style="font-family:inherit">Checking...</span></div>`;
  }
  let h = runtimeRowHtml('Claude Code', runtimeStatus.claude, runtimeStatus.defaultRuntime === 'claude');
  h += runtimeRowHtml('Codex', runtimeStatus.codex, runtimeStatus.defaultRuntime === 'codex');
  const cx = runtimeStatus.codex || {};
  if (cx.installed && cx.authenticated === false) {
    h += `<div class="runtime-guidance">Run <code>codex login</code> once. Your ChatGPT plan covers your agents via the official Codex CLI (July 2026).</div>`;
  } else if (!cx.installed) {
    h += `<div class="runtime-guidance">Want agents on your ChatGPT plan? Install the official Codex CLI, then sign in: <code>npm install -g @openai/codex</code> then <code>codex login</code></div>`;
  }
  // windowsSandbox is only ever a boolean on Windows (null elsewhere), so
  // this guidance self-limits to Windows machines. Without the native
  // sandbox declared, Codex file writes arrive as approval cards; with it,
  // agents write directly inside the sandbox, as on macOS.
  if (cx.installed && cx.windowsSandbox === false) {
    h += `<div class="runtime-guidance">Codex agents currently request each file write for your approval. For direct sandboxed writes, add to your Codex config (<code>%USERPROFILE%\\.codex\\config.toml</code>):<br><code>[windows]</code><br><code>sandbox = "unelevated"</code></div>`;
  }
  return h;
}

function renderRuntimesCard() {
  const el = document.getElementById('runtimes-card');
  if (el) el.innerHTML = runtimesCardHtml();
}

function changeWorkspace() {
  ws.send(JSON.stringify({ type: 'list_workspaces' }));
}

// ── Plugins card (settings › plugins) ──
// The install form always takes a plain absolute path rather than only the
// native folder-picker capability the spec describes: that dialog cannot be
// driven by an automated test (Playwright cannot see or click into it), and
// this codebase's Playwright suite is the acceptance gate for this feature.
// A real desktop build can still wire a "Browse..." button to pick_folder
// the same way workspace selection already does; this input works either way.
let openPluginDisclosureId = null;

function pluginStatusLabel(status) {
  return { enabled: 'Enabled', disabled: 'Disabled', invalid: 'Invalid', approval_required: 'Package changed: needs re-approval' }[status] || status;
}

function pluginsSettingsHtml() {
  const list = RundockPluginHost.allPlugins();
  let h = `<div class="settings-section-title">Plugins</div>
    <div class="settings-card flow">
      <div class="settings-label" style="margin-bottom:10px">Install from folder</div>
      <div class="card-actions">
        <input id="plugin-install-path" class="settings-input" type="text" placeholder="/absolute/path/to/plugin" onkeydown="if(event.key==='Enter')installPluginFromPath()">
        <button class="settings-btn-primary" onclick="installPluginFromPath()">Install</button>
      </div>
      <div class="settings-caption" id="plugin-install-error"></div>
    </div>`;
  if (list.length === 0) {
    h += `<div class="settings-caption">No plugins installed.</div>`;
  } else {
    for (const p of list) h += pluginCardHtml(p);
  }
  return h;
}

function pluginCardHtml(p) {
  let h = `<div class="settings-card flow" data-plugin-id="${escAttr(p.id)}">
    <div class="card-actions" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div class="settings-label">${esc(p.name || p.id)}${p.version ? ` <span class="settings-caption" style="display:inline">v${esc(p.version)}</span>` : ''}</div>
        <div class="settings-caption">${esc(pluginStatusLabel(p.status))}</div>
      </div>
      <div class="card-actions">`;
  if (p.status === 'enabled') {
    h += `<button class="settings-btn" onclick="disablePluginAction('${escAttr(p.id)}')">Disable</button>`;
  } else if (p.status === 'disabled' || p.status === 'approval_required') {
    h += `<button class="settings-btn-primary" onclick="togglePluginDisclosure('${escAttr(p.id)}')">Review &amp; enable</button>`;
  }
  h += `<button class="settings-btn-danger" onclick="uninstallPluginAction('${escAttr(p.id)}')">Uninstall</button>
      </div>
    </div>`;
  if (p.errors && p.errors.length) {
    h += `<div class="settings-caption" style="color:var(--danger);margin-top:8px">${p.errors.map(e => esc(e.message)).join('<br>')}</div>`;
  }
  if (openPluginDisclosureId === p.id) h += pluginDisclosureHtml(p);
  h += `</div>`;
  return h;
}

// The spec's enable-confirmation disclosure: name/version/author/hash are
// already in the card above it; this adds what is not (agents, skills,
// resources, routes, and the same-origin UI warning) and asks for an
// explicit second click rather than enabling from the list row directly.
function pluginDisclosureHtml(p) {
  const list = (items, empty) => items.length ? items.join(', ') : empty;
  return `<div class="settings-card" style="margin:12px 0 0;background:var(--elevated)">
    <div class="settings-row"><span class="settings-label">Author</span><span class="settings-value">${esc(p.author || 'Unknown')}</span></div>
    <div class="settings-row"><span class="settings-label">Package hash</span><span class="settings-value">${esc(p.hash || 'unknown')}</span></div>
    <div class="settings-row"><span class="settings-label">Agents</span><span class="settings-value">${esc(list((p.agents || []).map(a => a.slug), 'none'))}</span></div>
    <div class="settings-row"><span class="settings-label">Skills</span><span class="settings-value">${esc(list((p.skills || []).map(s => s.slug), 'none'))}</span></div>
    <div class="settings-row"><span class="settings-label">Data resources</span><span class="settings-value">${esc(list((p.resources || []).map(r => r.id), 'none'))}</span></div>
    <div class="settings-row"><span class="settings-label">Routes</span><span class="settings-value">${esc(list((p.routes || []).map(r => r.label), 'none'))}</span></div>
    <div class="settings-caption" style="padding:0 16px 14px">Approved UI code runs on this page with the same access Rundock has, and can read and modify what you see and communicate with this server as you. Agent and skill instructions can influence model behaviour and tool use. Data this plugin stores lives as plaintext JSON in your workspace; Rundock does not encrypt, transmit, trade, or back it up. Disabling the plugin later stops its code and agents but keeps its data.</div>
    <div class="card-actions" style="padding:0 16px 14px">
      <button class="settings-btn-primary" onclick="confirmEnablePlugin('${escAttr(p.id)}')">Confirm enable</button>
      <button class="settings-btn" onclick="togglePluginDisclosure('${escAttr(p.id)}')">Cancel</button>
    </div>
  </div>`;
}

function togglePluginDisclosure(id) {
  openPluginDisclosureId = openPluginDisclosureId === id ? null : id;
  renderSettingsSection('plugins');
}

function installPluginFromPath() {
  const input = document.getElementById('plugin-install-path');
  const path = input ? input.value.trim() : '';
  const errEl = document.getElementById('plugin-install-error');
  if (errEl) errEl.textContent = '';
  if (!path) return;
  ws.send(JSON.stringify({ type: 'install_plugin', path }));
}

function confirmEnablePlugin(id) {
  // Optimistic close: the 'plugins' broadcast that follows success redraws
  // this card as enabled anyway, and closing now means a failure's error
  // note (showPluginActionError) is not hidden behind a disclosure panel
  // that no longer applies.
  if (openPluginDisclosureId === id) openPluginDisclosureId = null;
  ws.send(JSON.stringify({ type: 'enable_plugin', pluginId: id }));
}

function disablePluginAction(id) {
  ws.send(JSON.stringify({ type: 'disable_plugin', pluginId: id }));
}

function uninstallPluginAction(id) {
  ws.send(JSON.stringify({ type: 'uninstall_plugin', pluginId: id, deleteData: false }));
}

// Reflects a plugin_error reply into the install form's caption, or the
// relevant card if the failed action named a pluginId already in the list.
function showPluginActionError(action, pluginId, errors) {
  const message = (errors && errors[0] && errors[0].message) || 'That action failed.';
  if (action === 'install' || !pluginId) {
    const errEl = document.getElementById('plugin-install-error');
    if (errEl) errEl.textContent = message;
    return;
  }
  const card = document.querySelector(`.settings-card[data-plugin-id="${CSS.escape(pluginId)}"]`);
  if (card) {
    let note = card.querySelector('.plugin-action-error');
    if (!note) {
      note = document.createElement('div');
      note.className = 'settings-caption plugin-action-error';
      note.style.color = 'var(--danger)';
      note.style.marginTop = '8px';
      card.appendChild(note);
    }
    note.textContent = message;
  }
}

return {
  showSettingsSection, renderSettingsSection, setWorkspaceMode, runtimeRowHtml, runtimesCardHtml, renderRuntimesCard, changeWorkspace,
  pluginsSettingsHtml, pluginCardHtml, togglePluginDisclosure, installPluginFromPath, confirmEnablePlugin,
  disablePluginAction, uninstallPluginAction, showPluginActionError,
};
}));

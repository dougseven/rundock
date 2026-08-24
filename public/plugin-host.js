'use strict';
// Client plugin host: loads approved plugin UI scripts, validates their
// registration, mounts/unmounts their routes and the chat-side-panel slot,
// and tears everything down on workspace switch. Same UMD pattern as
// conversation-state.js: a classic script in the browser, requireable
// directly under Node for the parts that touch no DOM (registration
// validation, generation tokening, subscription bookkeeping, host-context
// construction). The DOM-touching functions (loadPlugin, mount/unmount,
// nav button and panel creation) are exported the same way; they are simply
// never CALLED when this file is only required for its pure surface, so
// requiring it raises no ReferenceError for `document`.
//
// app.js owns the WebSocket, the workspace-generation trigger, and calling
// into this module from switchNav/showView; this module owns everything
// about what a plugin script is allowed to do once loaded.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockPluginHost = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const SUPPORTED_SUBSCRIPTION_EVENTS = new Set(['agent-switch', 'plugin-data-changed', 'workspace-closing', 'theme-changed']);
  const LOAD_TIMEOUT_MS = 8000;

  // ---- module state: reset in full by resetForWorkspace() ----
  let generation = 0;
  let deps = { send: null, escapeHtml: (s) => String(s) };
  let pluginsById = new Map();          // sanitized server entries, by plugin id
  let registrations = new Map();        // pluginId -> { routes: {viewName: {mount,unmount}}, slots: {...} }
  let mounted = new Map();              // mountKey -> { pluginId, unmount }
  let subscriptions = new Map();        // eventName -> Set<listener>
  let pendingRequests = new Map();      // requestId -> { resolve, reject }
  let pluginErrors = new Map();         // pluginId -> string, set on load/registration failure
  // pluginId -> { generation, finish } for every script currently loading.
  // Plugins load concurrently (loadAllEnabledPlugins fires every enabled
  // plugin's <script> in the same tick), so this cannot be one shared slot:
  // by the time any script starts executing, a single "current load"
  // variable would already have been overwritten by the last one queued.
  let pendingLoads = new Map();
  let requestCounter = 0;

  function configure(nextDeps) { deps = Object.assign({}, deps, nextDeps); }

  function currentGeneration() { return generation; }

  function nextRequestId() { requestCounter += 1; return `preq-${generation}-${requestCounter}`; }

  // ---------------------------------------------------------------------
  // Registration (called by a loaded plugin script via
  // RundockPluginHost.register(pluginId, definition), a global exposed only
  // in the browser factory branch below).
  // ---------------------------------------------------------------------

  function declaredViewNames(entry, kind) {
    if (kind === 'routes') return new Set((entry.routes || []).map(r => r.view));
    return new Set((entry.slots || []).map(s => s.view));
  }

  // Identity check: which <script> element is synchronously executing right
  // now, and from which workspace generation it was loaded. document.
  // currentScript reflects the actual running script even when several
  // plugins are loading concurrently (each one's execution is still atomic
  // on the single JS thread), and is only populated during a script's own
  // synchronous top-level run, which is exactly what "the only allowed
  // load-time side effect" requires anyway. The generation tag is what
  // rejects a script from a WORKSPACE THAT HAS SINCE BEEN LEFT that is still
  // in flight (its network fetch was already aborted by removing the tag,
  // but a request that had already reached the browser can still complete
  // and execute) if the new workspace happens to enable a plugin with the
  // same id: entry-lookup alone would not catch that, since the new
  // workspace's plugin list can legitimately contain that same id.
  function currentlyExecutingPluginId() {
    const script = typeof document !== 'undefined' ? document.currentScript : null;
    if (!script || !script.dataset) return undefined;
    if (String(script.dataset.rundockGeneration) !== String(generation)) return undefined;
    return script.dataset.rundockPlugin;
  }

  function validateRegistration(pluginId, definition, entry) {
    if (currentlyExecutingPluginId() !== pluginId) {
      return `registration id "${pluginId}" does not match the script currently loading.`;
    }
    if (registrations.has(pluginId)) {
      return `plugin "${pluginId}" registered twice.`;
    }
    if (!definition || typeof definition !== 'object') {
      return `plugin "${pluginId}" registration must be an object.`;
    }
    const routes = definition.routes || {};
    const slots = definition.slots || {};
    const declaredRoutes = declaredViewNames(entry, 'routes');
    const declaredSlots = declaredViewNames(entry, 'slots');

    for (const view of declaredRoutes) {
      if (!routes[view]) return `plugin "${pluginId}" omits a mount for its declared route view "${view}".`;
    }
    for (const view of Object.keys(routes)) {
      if (!declaredRoutes.has(view)) return `plugin "${pluginId}" registers an undeclared route view "${view}".`;
    }
    for (const view of declaredSlots) {
      if (!slots[view]) return `plugin "${pluginId}" omits a mount for its declared slot view "${view}".`;
    }
    for (const view of Object.keys(slots)) {
      if (!declaredSlots.has(view)) return `plugin "${pluginId}" registers an undeclared slot view "${view}".`;
    }
    for (const [view, def] of Object.entries(Object.assign({}, routes, slots))) {
      if (typeof def.mount !== 'function') return `plugin "${pluginId}" view "${view}" has no mount function.`;
      if (typeof def.unmount !== 'function') return `plugin "${pluginId}" view "${view}" has no unmount function.`;
    }
    return null;
  }

  // Exposed as RundockPluginHost.register in the browser (see the global
  // shim near the bottom). Returns true on acceptance; on rejection, records
  // the error against the plugin and resolves its pending load as failed.
  function register(pluginId, definition) {
    const entry = pluginsById.get(pluginId);
    const error = !entry
      ? `plugin "${pluginId}" is not in the current plugin list.`
      : validateRegistration(pluginId, definition, entry);
    const pending = pendingLoads.get(pluginId);
    if (error) {
      pluginErrors.set(pluginId, error);
      if (pending) { pendingLoads.delete(pluginId); pending.finish(false, error); }
      return false;
    }
    registrations.set(pluginId, definition);
    if (pending) { pendingLoads.delete(pluginId); pending.finish(true, null); }
    return true;
  }

  // ---------------------------------------------------------------------
  // Subscriptions and the mount context.
  // ---------------------------------------------------------------------

  function subscribe(eventName, listener) {
    if (!SUPPORTED_SUBSCRIPTION_EVENTS.has(eventName) || typeof listener !== 'function') return () => {};
    if (!subscriptions.has(eventName)) subscriptions.set(eventName, new Set());
    const set = subscriptions.get(eventName);
    set.add(listener);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      set.delete(listener);
    };
  }

  function emit(eventName, payload) {
    const set = subscriptions.get(eventName);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try { listener(payload); } catch (e) { console.error(`[Plugins] a "${eventName}" subscriber threw:`, e); }
    }
  }

  function buildContext(pluginId) {
    return Object.freeze({
      pluginId,
      getResource(resourceId) { return sendRequest({ type: 'plugin_data_get', pluginId, resourceId }); },
      replaceResource(resourceId, baseEtag, document_) {
        return sendRequest({ type: 'plugin_data_replace', pluginId, resourceId, baseEtag, document: document_ });
      },
      startConversation(agentSlug, initialMessage) {
        if (deps.startConversation) deps.startConversation(pluginId, agentSlug, initialMessage);
      },
      subscribe,
      navigate(routeId) { if (deps.navigate) deps.navigate(`plugin:${pluginId}:${routeId}`); },
      escapeHtml: (value) => deps.escapeHtml(value),
    });
  }

  function sendRequest(message) {
    const requestId = nextRequestId();
    const requestGeneration = generation;
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject, generation: requestGeneration });
      if (!deps.send) { pendingRequests.delete(requestId); reject(new Error('not connected')); return; }
      deps.send(Object.assign({ requestId }, message));
    });
  }

  // Routes a server reply carrying a requestId to its pending Promise. Late
  // replies from a superseded generation are dropped rather than resolved.
  function handleDataResponse(msg) {
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;
    pendingRequests.delete(msg.requestId);
    if (pending.generation !== generation) return;
    if (msg.type === 'plugin_data_error') { pending.reject(new Error(msg.message)); return; }
    if (msg.type === 'plugin_data_conflict') { pending.reject(Object.assign(new Error('conflict'), { conflict: true, etag: msg.etag, document: msg.document })); return; }
    pending.resolve({ etag: msg.etag, document: msg.document });
  }

  function handleDataChanged(msg) {
    emit('plugin-data-changed', { pluginId: msg.pluginId, resourceId: msg.resourceId, etag: msg.etag, document: msg.document });
  }

  function notifyAgentSwitch(payload) {
    emit('agent-switch', payload);
  }

  function notifyThemeChanged(theme) {
    emit('theme-changed', { theme });
  }

  // ---------------------------------------------------------------------
  // Plugin list / discovery
  // ---------------------------------------------------------------------

  function setPluginList(list) {
    pluginsById = new Map((list || []).map(p => [p.id, p]));
  }

  function enabledPlugins() {
    return Array.from(pluginsById.values()).filter(p => p.status === 'enabled');
  }

  function pluginForRuntimeAgent(agent) {
    if (!agent || !agent.rundockPlugin) return null;
    return pluginsById.get(agent.rundockPlugin) || null;
  }

  // ---------------------------------------------------------------------
  // DOM: script/style loading, nav buttons, panels, mount/unmount.
  // Never referenced at require time, only when actually called.
  // ---------------------------------------------------------------------

  function loadStyles(pluginId, urls) {
    const els = (urls || []).map(url => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.dataset.rundockPlugin = pluginId;
      document.head.appendChild(link);
      return link;
    });
    return els;
  }

  function removeStyles(els) {
    for (const el of els) { try { el.remove(); } catch (e) { /* already gone */ } }
  }

  // Loads one enabled plugin's entry script and waits for its register()
  // call. Isolated: a failure here never throws past this function, it only
  // records pluginErrors and resolves the returned promise with success:false.
  function loadPlugin(entry) {
    const loadGeneration = generation;
    return new Promise((resolve) => {
      if (!entry.entryUrl) { pluginErrors.set(entry.id, 'no entry script declared.'); resolve({ success: false }); return; }

      let settled = false;
      const styleEls = loadStyles(entry.id, entry.styleUrls);
      const finish = (success, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingLoads.delete(entry.id);
        if (loadGeneration !== generation) { resolve({ success: false, stale: true }); return; }
        if (!success) {
          pluginErrors.set(entry.id, error || 'failed to load.');
          removeStyles(styleEls);
        }
        resolve({ success });
      };

      const timer = setTimeout(() => finish(false, 'timed out loading its UI script.'), LOAD_TIMEOUT_MS);
      pendingLoads.set(entry.id, { generation: loadGeneration, finish });

      const script = document.createElement('script');
      script.src = entry.entryUrl;
      script.dataset.rundockPlugin = entry.id;
      script.dataset.rundockGeneration = String(loadGeneration);
      script.onerror = () => finish(false, 'its UI script raised an error while loading.');
      document.head.appendChild(script);
    });
  }

  function loadAllEnabledPlugins() {
    return Promise.all(enabledPlugins().map(entry => loadPlugin(entry)));
  }

  function pluginNavContainer() { return document.querySelector('.nav-main'); }
  function mainViewContainer() { return document.querySelector('main.main'); }

  function routeNavKey(pluginId, routeId) { return `plugin:${pluginId}:${routeId}`; }
  function routePanelId(pluginId, routeId) { return `view-plugin-${pluginId}-${routeId}`; }

  // Shell-owned navigation buttons for every declared route of every
  // successfully registered plugin. Called once after loadAllEnabledPlugins
  // settles, so a failed plugin's routes never get a nav entry.
  function renderPluginNav(onSwitchNav) {
    const container = pluginNavContainer();
    if (!container) return;
    for (const entry of enabledPlugins()) {
      if (!registrations.has(entry.id) || pluginErrors.has(entry.id)) continue;
      for (const route of entry.routes) {
        const key = routeNavKey(entry.id, route.id);
        if (document.querySelector(`[data-nav="${cssEscape(key)}"]`)) continue;
        const btn = document.createElement('button');
        btn.className = 'nav-item';
        btn.dataset.nav = key;
        btn.dataset.rundockPlugin = entry.id;
        btn.setAttribute('data-tooltip', route.label);
        btn.textContent = (route.label || '?').trim().charAt(0).toUpperCase();
        btn.addEventListener('click', () => onSwitchNav(key));
        container.appendChild(btn);
      }
    }
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // The one stable panel per declared plugin route, created on first
  // navigation to it and reused after. showPluginRoute hides every other
  // view AND every other plugin panel before revealing this one.
  function ensureRoutePanel(pluginId, routeId) {
    const id = routePanelId(pluginId, routeId);
    let panel = document.getElementById(id);
    if (!panel) {
      const container = mainViewContainer();
      if (!container) return null;
      panel = document.createElement('div');
      panel.id = id;
      panel.className = 'hidden view-panel plugin-view-panel';
      panel.dataset.rundockPlugin = pluginId;
      container.appendChild(panel);
    }
    return panel;
  }

  // Hides every built-in view AND every plugin panel. app.js's own showView
  // calls this first so a plugin panel never survives a switch to a
  // built-in view; mountRoute calls it too before revealing its own panel.
  function hideAllPluginPanels() {
    document.querySelectorAll('.plugin-view-panel').forEach(el => {
      el.classList.add('hidden');
      el.style.display = 'none';
    });
  }

  function mountRoute(navKey) {
    const m = /^plugin:([^:]+):(.+)$/.exec(navKey);
    if (!m) return false;
    const [, pluginId, routeId] = m;
    const def = registrations.get(pluginId);
    const entry = pluginsById.get(pluginId);
    if (!def || !entry) return false;
    const route = (entry.routes || []).find(r => r.id === routeId);
    if (!route || !def.routes || !def.routes[route.view]) return false;

    hideAllPluginPanels();
    const panel = ensureRoutePanel(pluginId, routeId);
    if (!panel) return false;
    panel.classList.remove('hidden');
    panel.style.display = 'flex';

    const mountKey = `route:${navKey}`;
    if (!mounted.has(mountKey)) {
      const context = buildContext(pluginId);
      try {
        def.routes[route.view].mount(panel, context);
      } catch (e) {
        console.error(`[Plugins] "${pluginId}" route "${routeId}" mount threw:`, e);
      }
      mounted.set(mountKey, { pluginId, unmount: () => def.routes[route.view].unmount() });
    }
    return true;
  }

  function unmountRoute(navKey) {
    const mountKey = `route:${navKey}`;
    const entry = mounted.get(mountKey);
    if (!entry) return;
    mounted.delete(mountKey);
    try { entry.unmount(); } catch (e) { console.error(`[Plugins] "${entry.pluginId}" unmount threw:`, e); }
    const m = /^route:plugin:([^:]+):(.+)$/.exec(mountKey);
    if (m) { const panel = document.getElementById(routePanelId(m[1], m[2])); if (panel) panel.remove(); }
  }

  // ---------------------------------------------------------------------
  // chat-side-panel: mounts only while the active/originating agent of the
  // current conversation belongs to a registered plugin declaring that slot.
  // ---------------------------------------------------------------------

  function chatSidePanelContainer() {
    let el = document.getElementById('plugin-chat-side-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'plugin-chat-side-panel';
      el.className = 'plugin-chat-side-panel hidden';
      const chatView = document.getElementById('view-chat');
      if (chatView) chatView.appendChild(el);
    }
    return el;
  }

  function updateChatSidePanel(agent) {
    const container = chatSidePanelContainer();
    const owningPlugin = pluginForRuntimeAgent(agent);
    const eligible = owningPlugin && registrations.has(owningPlugin.id)
      && (owningPlugin.slots || []).some(s => s.target === 'chat-side-panel');
    const mountKey = 'slot:chat-side-panel';
    const current = mounted.get(mountKey);

    if (current && (!eligible || current.pluginId !== owningPlugin.id)) {
      mounted.delete(mountKey);
      try { current.unmount(); } catch (e) { console.error('[Plugins] chat-side-panel unmount threw:', e); }
      container.innerHTML = '';
      container.classList.add('hidden');
    }
    if (eligible && !mounted.has(mountKey)) {
      const def = registrations.get(owningPlugin.id);
      const slot = (owningPlugin.slots || []).find(s => s.target === 'chat-side-panel');
      const view = slot && def.slots && def.slots[slot.view];
      if (view) {
        container.classList.remove('hidden');
        const context = buildContext(owningPlugin.id);
        try { view.mount(container, context); } catch (e) { console.error(`[Plugins] "${owningPlugin.id}" chat-side-panel mount threw:`, e); }
        mounted.set(mountKey, { pluginId: owningPlugin.id, unmount: () => view.unmount() });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Workspace teardown.
  // ---------------------------------------------------------------------

  function removeAllPluginDom() {
    document.querySelectorAll('[data-rundock-plugin]').forEach(el => el.remove());
    const panel = document.getElementById('plugin-chat-side-panel');
    if (panel) panel.remove();
  }

  // Increments the generation FIRST (spec step order), so any in-flight
  // load or request that checks its captured generation against the new
  // one sees a mismatch and drops itself. Called by app.js before it
  // requests the new workspace's plugin list.
  function resetForWorkspace() {
    emit('workspace-closing', {});
    for (const [, entry] of mounted) {
      try { entry.unmount(); } catch (e) { console.error(`[Plugins] "${entry.pluginId}" unmount threw during teardown:`, e); }
    }
    mounted.clear();
    removeAllPluginDom();
    subscriptions.clear();
    for (const [, pending] of pendingRequests) { try { pending.reject(new Error('workspace changed')); } catch (e) { /* already settled */ } }
    pendingRequests.clear();
    registrations.clear();
    pluginErrors.clear();
    pluginsById = new Map();
    pendingLoads.clear();
    generation += 1;
    return generation;
  }

  const api = {
    configure, currentGeneration, resetForWorkspace,
    register, subscribe, emit,
    setPluginList, enabledPlugins, pluginForRuntimeAgent,
    loadPlugin, loadAllEnabledPlugins, renderPluginNav,
    mountRoute, unmountRoute, hideAllPluginPanels,
    updateChatSidePanel,
    handleDataResponse, handleDataChanged, notifyAgentSwitch, notifyThemeChanged,
    buildContext,
    // exposed for tests: internal maps are never mutated directly by callers
    _debug: { pluginsById: () => pluginsById, registrations: () => registrations, mounted: () => mounted, pluginErrors: () => pluginErrors, subscriptions: () => subscriptions, pendingRequests: () => pendingRequests },
  };

  // A plugin's own UI script calls RundockPluginHost.register(id, def) at
  // load time. In the browser that resolves through the outer wrapper's
  // `root.RundockPluginHost = factory()` below, which is this whole `api`
  // object: no separate global-exposure step is needed here.
  return api;
}));

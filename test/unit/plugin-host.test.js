'use strict';
// public/plugin-host.js: the client plugin host. Covers the parts the spec
// explicitly calls out as testable: registration validation, generation
// handling for late script/protocol responses, subscribe/unsubscribe and
// teardown isolation, and the mount context shape. DOM-touching paths
// (script tag creation, register() identity via document.currentScript) use
// jsdom, matching the existing convention (see test/unit/boundary-card.test.js).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let dom, host;

before(() => {
  dom = new JSDOM('<html><head></head><body><nav><div class="nav-main"></div></nav><main class="main"></main></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
});
after(() => { if (dom) dom.window.close(); });

beforeEach(() => {
  host = require('../../public/plugin-host.js');
  // Each require() returns the SAME module-singleton object (Node's require
  // cache), so state must be reset explicitly between tests rather than by
  // re-requiring; resetForWorkspace() is that reset.
  host.resetForWorkspace();
  setCurrentScript(null);
});

function setCurrentScript(datasetOrNull) {
  Object.defineProperty(document, 'currentScript', {
    value: datasetOrNull ? { dataset: datasetOrNull } : null,
    configurable: true,
  });
}

function samplePlugin(overrides = {}) {
  return Object.assign({
    id: 'plugin-a', name: 'Plugin A', version: '1.0.0', status: 'enabled',
    errors: [], warnings: [],
    entryUrl: '/plugins/plugin-a/ui/index.js?h=sha256:abc',
    styleUrls: [],
    routes: [{ id: 'home', path: '/plugin-a', label: 'Plugin A', icon: null, view: 'home' }],
    slots: [],
    agents: [],
  }, overrides);
}

describe('subscribe / emit', () => {
  test('a subscriber receives emitted payloads and can unsubscribe', () => {
    const seen = [];
    const unsubscribe = host.subscribe('agent-switch', (p) => seen.push(p));
    host.emit('agent-switch', { agentId: 'a' });
    unsubscribe();
    host.emit('agent-switch', { agentId: 'b' });
    assert.deepStrictEqual(seen, [{ agentId: 'a' }]);
  });

  test('one throwing listener does not stop the others', () => {
    const seen = [];
    host.subscribe('theme-changed', () => { throw new Error('boom'); });
    host.subscribe('theme-changed', (p) => seen.push(p));
    assert.doesNotThrow(() => host.emit('theme-changed', { theme: 'dark' }));
    assert.deepStrictEqual(seen, [{ theme: 'dark' }]);
  });

  test('an unsupported event name or non-function listener is a harmless no-op', () => {
    const unsub1 = host.subscribe('not-a-real-event', () => {});
    const unsub2 = host.subscribe('agent-switch', 'not-a-function');
    assert.strictEqual(typeof unsub1, 'function');
    assert.strictEqual(typeof unsub2, 'function');
    assert.doesNotThrow(() => { unsub1(); unsub2(); });
  });

  test('calling unsubscribe twice is safe', () => {
    const unsubscribe = host.subscribe('workspace-closing', () => {});
    unsubscribe();
    assert.doesNotThrow(() => unsubscribe());
  });
});

describe('resetForWorkspace', () => {
  test('emits workspace-closing BEFORE calling mounted unmounts', () => {
    const order = [];
    host.subscribe('workspace-closing', () => order.push('closing'));
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    host.register('plugin-a', { routes: { home: { mount: () => order.push('mount'), unmount: () => order.push('unmount') } } });
    host.mountRoute('plugin:plugin-a:home');
    host.resetForWorkspace();
    assert.deepStrictEqual(order, ['mount', 'closing', 'unmount']);
  });

  test('one mounted view throwing on unmount does not stop the others from being torn down', () => {
    const torn = [];
    host.setPluginList([samplePlugin({ id: 'plugin-a', routes: [
      { id: 'a', path: '/a', label: 'A', icon: null, view: 'a' },
      { id: 'b', path: '/b', label: 'B', icon: null, view: 'b' },
    ] })]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    host.register('plugin-a', {
      routes: {
        a: { mount: () => {}, unmount: () => { throw new Error('boom'); } },
        b: { mount: () => {}, unmount: () => torn.push('b') },
      },
    });
    host.mountRoute('plugin:plugin-a:a');
    host.mountRoute('plugin:plugin-a:b');
    assert.doesNotThrow(() => host.resetForWorkspace());
    assert.deepStrictEqual(torn, ['b']);
  });

  test('increments the generation and clears the plugin list/registrations/subscriptions', () => {
    const before_ = host.currentGeneration();
    host.setPluginList([samplePlugin()]);
    host.subscribe('theme-changed', () => {});
    const after_ = host.resetForWorkspace();
    assert.strictEqual(after_, before_ + 1);
    assert.deepStrictEqual(host.enabledPlugins(), []);
  });

  test('rejects every pending plugin_data_get/replace request', async () => {
    let sent = null;
    host.configure({ send: (m) => { sent = m; } });
    const pending = host.buildContext('plugin-a').getResource('state');
    host.resetForWorkspace();
    await assert.rejects(pending, /workspace changed/);
  });
});

describe('generation handling for late responses', () => {
  test('a plugin_data reply carrying a stale requestId resolves nothing and does not throw', () => {
    let sent = null;
    host.configure({ send: (m) => { sent = m; } });
    host.buildContext('plugin-a').getResource('state').catch(() => {});
    const staleRequestId = sent.requestId;
    host.resetForWorkspace();
    // The generation bump already rejected and removed this request; a late
    // server reply for it must be a no-op, not a crash.
    assert.doesNotThrow(() => host.handleDataResponse({ type: 'plugin_data', requestId: staleRequestId, document: {} }));
  });

  test('register() from a script tagged with a superseded generation is rejected', () => {
    host.setPluginList([samplePlugin()]);
    const staleGeneration = host.currentGeneration();
    host.resetForWorkspace(); // generation moves on
    host.setPluginList([samplePlugin()]); // the NEW workspace happens to reuse the same plugin id
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(staleGeneration) });
    const accepted = host.register('plugin-a', { routes: { home: { mount: () => {}, unmount: () => {} } } });
    assert.strictEqual(accepted, false);
  });
});

describe('register() validation', () => {
  test('accepts a registration that exactly matches the declared routes and slots', () => {
    host.setPluginList([samplePlugin({ slots: [{ target: 'chat-side-panel', view: 'controls' }] })]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    const accepted = host.register('plugin-a', {
      routes: { home: { mount: () => {}, unmount: () => {} } },
      slots: { controls: { mount: () => {}, unmount: () => {} } },
    });
    assert.strictEqual(accepted, true);
  });

  test('rejects when the registering id does not match the executing script', () => {
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'someone-else', rundockGeneration: String(host.currentGeneration()) });
    const accepted = host.register('plugin-a', { routes: { home: { mount: () => {}, unmount: () => {} } } });
    assert.strictEqual(accepted, false);
    assert.match(host._debug.pluginErrors().get('plugin-a'), /does not match/);
  });

  test('rejects a plugin registering twice', () => {
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    const def = { routes: { home: { mount: () => {}, unmount: () => {} } } };
    assert.strictEqual(host.register('plugin-a', def), true);
    assert.strictEqual(host.register('plugin-a', def), false);
  });

  test('rejects when a declared route view has no mount', () => {
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    assert.strictEqual(host.register('plugin-a', { routes: {} }), false);
  });

  test('rejects an undeclared route view', () => {
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    const accepted = host.register('plugin-a', {
      routes: { home: { mount: () => {}, unmount: () => {} }, extra: { mount: () => {}, unmount: () => {} } },
    });
    assert.strictEqual(accepted, false);
  });

  test('rejects a mount or unmount member that is not a function', () => {
    host.setPluginList([samplePlugin()]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    assert.strictEqual(host.register('plugin-a', { routes: { home: { mount: 'nope', unmount: () => {} } } }), false);
  });

  test('rejects a plugin id not present in the current plugin list', () => {
    host.setPluginList([]);
    setCurrentScript({ rundockPlugin: 'plugin-a', rundockGeneration: String(host.currentGeneration()) });
    assert.strictEqual(host.register('plugin-a', { routes: {} }), false);
  });
});

describe('setPluginList / pluginForRuntimeAgent', () => {
  test('enabledPlugins returns only status: enabled entries', () => {
    host.setPluginList([samplePlugin({ id: 'a', status: 'enabled' }), samplePlugin({ id: 'b', status: 'disabled' })]);
    assert.deepStrictEqual(host.enabledPlugins().map(p => p.id), ['a']);
  });

  test('pluginForRuntimeAgent resolves an agent\'s owning plugin by rundockPlugin', () => {
    host.setPluginList([samplePlugin({ id: 'investment-dashboard' })]);
    const owner = host.pluginForRuntimeAgent({ rundockPlugin: 'investment-dashboard' });
    assert.strictEqual(owner.id, 'investment-dashboard');
    assert.strictEqual(host.pluginForRuntimeAgent({ rundockPlugin: null }), null);
    assert.strictEqual(host.pluginForRuntimeAgent(null), null);
  });
});

describe('buildContext', () => {
  test('is frozen, carries the pluginId, and getResource round-trips through send/handleDataResponse', async () => {
    let sent = null;
    host.configure({ send: (m) => { sent = m; } });
    const ctx = host.buildContext('plugin-a');
    assert.strictEqual(ctx.pluginId, 'plugin-a');
    assert.ok(Object.isFrozen(ctx));

    const promise = ctx.getResource('state');
    assert.strictEqual(sent.type, 'plugin_data_get');
    assert.strictEqual(sent.pluginId, 'plugin-a');
    assert.strictEqual(sent.resourceId, 'state');

    host.handleDataResponse({ type: 'plugin_data', requestId: sent.requestId, etag: 'sha256:x', document: { a: 1 } });
    const result = await promise;
    assert.deepStrictEqual(result, { etag: 'sha256:x', document: { a: 1 } });
  });

  test('replaceResource rejects on a plugin_data_conflict reply', async () => {
    let sent = null;
    host.configure({ send: (m) => { sent = m; } });
    const promise = host.buildContext('plugin-a').replaceResource('state', 'sha256:old', { a: 1 });
    assert.strictEqual(sent.type, 'plugin_data_replace');
    host.handleDataResponse({ type: 'plugin_data_conflict', requestId: sent.requestId, etag: 'sha256:new', document: { a: 2 } });
    await assert.rejects(promise, (err) => err.conflict === true && err.etag === 'sha256:new');
  });
});

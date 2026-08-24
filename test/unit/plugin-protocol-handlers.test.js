'use strict';
// lib/protocol/handlers/plugins.js: the WS surface over lib/plugins/
// lifecycle.js and storage.js. Calls the real handlers with the server's
// real wsHandlerContext, the same seam test/unit/plugin-ownership-guards.test.js
// uses, so these exercise the actual sanitization and broadcast code.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const plugins = require('../../lib/protocol/handlers/plugins.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const { makeWorkspace, makeTempDir, standardTeam, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  srv.invalidateAgentCache();
  return dir;
}

function makeSource(overrides, extraFiles) {
  const dir = makeTempDir('plugin-src-');
  writePluginPackage(dir, minimalManifest(overrides), extraFiles);
  return dir;
}

describe('handleGetPlugins', () => {
  test('an empty workspace with no plugins installed returns an empty list', () => {
    useWorkspace({ agents: standardTeam() });
    const ws = captureWs();
    plugins.handleGetPlugins(srv.wsHandlerContext, ws, {});
    assert.deepStrictEqual(ws.sent, [{ type: 'plugins', plugins: [] }]);
  });

  test('a disabled plugin has no entryUrl/styleUrls but its routes/slots/agents metadata is present', () => {
    const dir = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({
      id: 'plugin-a', name: 'Plugin A',
      ui: { entry: 'ui/index.js', styles: ['ui/app.css'] },
      routes: [{ id: 'home', path: '/plugin-a', label: 'Plugin A', view: 'home' }],
      slots: [{ target: 'chat-side-panel', view: 'controls' }],
      agents: [{ slug: 'lead', source: 'agents/lead.md', reportsTo: '$orchestrator' }],
    }, {
      'ui/index.js': '// entry', 'ui/app.css': '/* styles */',
      'agents/lead.md': '---\nname: lead\n---\n\nHi.',
    }));
    const ws = captureWs();
    plugins.handleGetPlugins(srv.wsHandlerContext, ws, {});
    const [entry] = ws.sent[0].plugins;
    assert.strictEqual(entry.status, 'disabled');
    assert.strictEqual(entry.entryUrl, null);
    assert.deepStrictEqual(entry.styleUrls, []);
    assert.deepStrictEqual(entry.routes, [{ id: 'home', path: '/plugin-a', label: 'Plugin A', icon: null, view: 'home' }]);
    assert.deepStrictEqual(entry.slots, [{ target: 'chat-side-panel', view: 'controls' }]);
    assert.deepStrictEqual(entry.agents, [{ slug: 'lead', reportsTo: '$orchestrator' }]);

    // Sanitized: no local filesystem path (this workspace's own absolute
    // temp directory) appears anywhere in what the client receives.
    assert.ok(!JSON.stringify(ws.sent).includes(dir));
  });

  test('the package hash is exposed even before approval, for the enable-confirmation disclosure', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({
      id: 'plugin-a', author: 'Test Author',
      skills: [{ slug: 'review', source: 'skills/review/SKILL.md' }],
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json', maximumBytes: 1024 }],
    }, {
      'skills/review/SKILL.md': '---\nname: Review\n---\n\nHow to review.',
      'templates/state.json': '{"schemaVersion":1,"revision":0,"updatedAt":"x"}',
    }));
    const ws = captureWs();
    plugins.handleGetPlugins(srv.wsHandlerContext, ws, {});
    const [entry] = ws.sent[0].plugins;
    assert.strictEqual(entry.status, 'disabled');
    assert.match(entry.hash, /^sha256:/);
    assert.strictEqual(entry.author, 'Test Author');
    assert.deepStrictEqual(entry.skills, [{ slug: 'review' }]);
    assert.deepStrictEqual(entry.resources, [{ id: 'state', maximumBytes: 1024 }]);
  });

  test('an enabled plugin gets a hash-bearing entryUrl and styleUrls', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({
      id: 'plugin-a', ui: { entry: 'ui/index.js', styles: ['ui/app.css'] },
    }, { 'ui/index.js': '// entry', 'ui/app.css': '/* styles */' }));
    const enable = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));

    const ws = captureWs();
    plugins.handleGetPlugins(srv.wsHandlerContext, ws, {});
    const [entry] = ws.sent[0].plugins;
    assert.strictEqual(entry.status, 'enabled');
    assert.strictEqual(entry.entryUrl, `/plugins/plugin-a/ui/index.js?h=${encodeURIComponent(enable.plugin.hash)}`);
    assert.deepStrictEqual(entry.styleUrls, [`/plugins/plugin-a/ui/app.css?h=${encodeURIComponent(enable.plugin.hash)}`]);
  });

  test('an invalid plugin is listed with its errors and no assets, never hidden', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'good-plugin' }));
    // A hand-written package with no valid manifest: discovery must still
    // find and report it invalid, not just skip it.
    const badDir = path.join(srv.getWorkspace(), '.rundock', 'plugins', 'bad-plugin');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'manifest.json'), '{not valid json');

    const ws = captureWs();
    plugins.handleGetPlugins(srv.wsHandlerContext, ws, {});
    const entries = ws.sent[0].plugins.sort((a, b) => a.id.localeCompare(b.id));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].status, 'invalid');
    assert.ok(entries[0].errors.length > 0);
    assert.strictEqual(entries[0].entryUrl, null);
    assert.strictEqual(entries[1].status, 'disabled');
  });
});

describe('handleInstallPlugin / handleEnablePlugin / handleDisablePlugin', () => {
  test('install replies plugin_installed and enable replies plugin_enabled', () => {
    useWorkspace({ agents: standardTeam() });
    const wsA = captureWs();
    plugins.handleInstallPlugin(srv.wsHandlerContext, wsA, { path: makeSource({ id: 'plugin-a' }) });
    assert.strictEqual(wsA.sent[0].type, 'plugin_installed');
    assert.strictEqual(wsA.sent[0].pluginId, 'plugin-a');

    const wsB = captureWs();
    plugins.handleEnablePlugin(srv.wsHandlerContext, wsB, { pluginId: 'plugin-a' });
    assert.strictEqual(wsB.sent[0].type, 'plugin_enabled');
  });

  test('a failed install replies plugin_error with structured errors, not a crash', () => {
    useWorkspace({ agents: standardTeam() });
    const ws = captureWs();
    plugins.handleInstallPlugin(srv.wsHandlerContext, ws, { path: makeSource({ schemaVersion: 99 }) });
    assert.strictEqual(ws.sent[0].type, 'plugin_error');
    assert.strictEqual(ws.sent[0].action, 'install');
    assert.ok(Array.isArray(ws.sent[0].errors) && ws.sent[0].errors.length > 0);
  });

  test('disable replies plugin_disabled', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    lifecycle.enablePlugin('plugin-a');
    const ws = captureWs();
    plugins.handleDisablePlugin(srv.wsHandlerContext, ws, { pluginId: 'plugin-a' });
    assert.strictEqual(ws.sent[0].type, 'plugin_disabled');
  });
});

describe('handlePluginDataGet / handlePluginDataReplace', () => {
  function enabledPluginWithResource() {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({
      id: 'plugin-a',
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json' }],
    }, { 'templates/state.json': '{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}' }));
    const enable = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));
  }

  test('get replies plugin_data with an etag and the document', () => {
    enabledPluginWithResource();
    const ws = captureWs();
    plugins.handlePluginDataGet(srv.wsHandlerContext, ws, { requestId: 'r1', pluginId: 'plugin-a', resourceId: 'state' });
    assert.strictEqual(ws.sent[0].type, 'plugin_data');
    assert.strictEqual(ws.sent[0].requestId, 'r1');
    assert.match(ws.sent[0].etag, /^sha256:/);
    assert.strictEqual(ws.sent[0].document.balance, 0);
  });

  test('a matching replace saves and broadcasts plugin_data_changed to every connected client', () => {
    enabledPluginWithResource();
    const reader = captureWs();
    plugins.handlePluginDataGet(srv.wsHandlerContext, reader, { requestId: 'r1', pluginId: 'plugin-a', resourceId: 'state' });
    const { etag } = reader.sent[0];

    // Two "connected" clients: the writer and a bystander. Both must see the change.
    const writer = captureWs();
    const bystander = captureWs();
    srv.connectedClients.add(writer);
    srv.connectedClients.add(bystander);
    try {
      plugins.handlePluginDataReplace(srv.wsHandlerContext, writer, {
        requestId: 'r2', pluginId: 'plugin-a', resourceId: 'state', baseEtag: etag, document: { schemaVersion: 1, balance: 50 },
      });
    } finally {
      srv.connectedClients.delete(writer);
      srv.connectedClients.delete(bystander);
    }

    const savedReply = writer.sent.find(m => m.type === 'plugin_data_saved');
    assert.ok(savedReply, 'writer must get a direct plugin_data_saved reply');
    assert.strictEqual(savedReply.requestId, 'r2');

    const writerBroadcast = writer.sent.find(m => m.type === 'plugin_data_changed');
    const bystanderBroadcast = bystander.sent.find(m => m.type === 'plugin_data_changed');
    assert.ok(writerBroadcast && bystanderBroadcast, 'both clients must receive plugin_data_changed');
    assert.strictEqual(writerBroadcast.document.balance, 50);
    assert.strictEqual(bystanderBroadcast.document.balance, 50);
  });

  test('a stale baseEtag replies plugin_data_conflict with the current etag and document, no broadcast', () => {
    enabledPluginWithResource();
    const bystander = captureWs();
    srv.connectedClients.add(bystander);
    const ws = captureWs();
    try {
      plugins.handlePluginDataReplace(srv.wsHandlerContext, ws, {
        requestId: 'r3', pluginId: 'plugin-a', resourceId: 'state', baseEtag: 'sha256:stale', document: { schemaVersion: 1, balance: 999 },
      });
    } finally {
      srv.connectedClients.delete(bystander);
    }
    assert.strictEqual(ws.sent[0].type, 'plugin_data_conflict');
    assert.strictEqual(ws.sent[0].document.balance, 0);
    assert.ok(!bystander.sent.some(m => m.type === 'plugin_data_changed'), 'a rejected write must not broadcast');
  });

  test('a missing resource replies plugin_data_error', () => {
    enabledPluginWithResource();
    const ws = captureWs();
    plugins.handlePluginDataGet(srv.wsHandlerContext, ws, { requestId: 'r4', pluginId: 'plugin-a', resourceId: 'does-not-exist' });
    assert.strictEqual(ws.sent[0].type, 'plugin_data_error');
  });
});

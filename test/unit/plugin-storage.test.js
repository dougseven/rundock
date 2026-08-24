'use strict';
// lib/plugins/storage.js: resource bootstrap, atomic reads, and
// compare-and-swap replacement. Uses the real install/enable path from
// lib/plugins/lifecycle.js to set up an "enabled plugin with a resource"
// fixture, since storage.js resolves resources against the currently
// enabled plugin's manifest the same way the real protocol handlers will.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const discovery = require('../../lib/plugins/discovery.js');
const storage = require('../../lib/plugins/storage.js');
const { makeWorkspace, makeTempDir, standardTeam, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  config.setWorkspace(dir);
  discovery.invalidatePluginDiscoveryCache();
  invalidateAgentCache();
  return dir;
}

// Installs and enables a plugin declaring one resource ("state", state.json,
// from templates/state.json), returning the workspace directory. Every
// storage.js test starts from this.
function enabledPluginWithResource(templateContent, overrides = {}) {
  const ws = useWorkspace({ agents: standardTeam() });
  const src = makeTempDir('plugin-src-');
  writePluginPackage(src, minimalManifest({
    id: 'plugin-a',
    resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json', ...overrides }],
  }), { 'templates/state.json': templateContent });
  const install = lifecycle.installFromFolder(src);
  assert.strictEqual(install.success, true, JSON.stringify(install.errors));
  const enable = lifecycle.enablePlugin('plugin-a');
  assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));
  return ws;
}

describe('bootstrapResources (through enablePlugin)', () => {
  test('creates the resource file from its template, normalizing revision and updatedAt', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":7,"updatedAt":"stale","balance":0}');
    const dataPath = path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json');
    const doc = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.strictEqual(doc.revision, 0);
    assert.notStrictEqual(doc.updatedAt, 'stale');
    assert.strictEqual(doc.balance, 0);
  });

  test('never overwrites an already-existing resource file (idempotent, preserves user data)', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    const dataDir = path.join(ws, '.rundock', 'plugin-data', 'plugin-a');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{"schemaVersion":1,"revision":40,"updatedAt":"x","balance":999}');

    const src = makeTempDir('plugin-src-');
    writePluginPackage(src, minimalManifest({
      id: 'plugin-a',
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json' }],
    }), { 'templates/state.json': '{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}' });
    lifecycle.installFromFolder(src);
    const enable = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));

    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf-8'));
    assert.strictEqual(doc.revision, 40);
    assert.strictEqual(doc.balance, 999);
  });

  test('an oversized bootstrapped document refuses enablement with a clear message', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    const src = makeTempDir('plugin-src-');
    writePluginPackage(src, minimalManifest({
      id: 'plugin-a',
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json', maximumBytes: 10 }],
    }), { 'templates/state.json': '{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0,"padding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' });
    lifecycle.installFromFolder(src);
    const enable = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(enable.success, false);
    assert.match(enable.errors[0].message, /byte limit/);
    assert.ok(!fs.existsSync(path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json')));
  });
});

describe('readResource', () => {
  test('reads back the bootstrapped document with a stable etag', () => {
    enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}');
    const result = storage.readResource('plugin-a', 'state');
    assert.match(result.etag, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(result.document.balance, 0);
    const again = storage.readResource('plugin-a', 'state');
    assert.strictEqual(again.etag, result.etag);
  });

  test('errors for an unknown resource id', () => {
    enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x"}');
    const result = storage.readResource('plugin-a', 'does-not-exist');
    assert.ok(result.error);
  });

  test('errors for a plugin that is not enabled', () => {
    useWorkspace({ agents: standardTeam() });
    const result = storage.readResource('plugin-a', 'state');
    assert.ok(result.error);
  });

  test('reports corruption without throwing, for a hand-corrupted file', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x"}');
    fs.writeFileSync(path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json'), '{not valid json');
    const result = storage.readResource('plugin-a', 'state');
    assert.strictEqual(result.corrupt, true);
    assert.ok(result.error);
  });
});

describe('replaceResource', () => {
  test('a matching baseEtag succeeds and the server sets revision/updatedAt, ignoring the client\'s own values', () => {
    enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}');
    const before = storage.readResource('plugin-a', 'state');
    const result = storage.replaceResource('plugin-a', 'state', before.etag, {
      schemaVersion: 1, revision: 999, updatedAt: 'client-supplied', balance: 50,
    });
    assert.ok(!result.error && !result.conflict, JSON.stringify(result));
    assert.strictEqual(result.document.revision, 1, 'server increments from the PRIOR document, ignoring the client-sent revision');
    assert.notStrictEqual(result.document.updatedAt, 'client-supplied');
    assert.strictEqual(result.document.balance, 50);
    assert.notStrictEqual(result.etag, before.etag);
  });

  test('a stale baseEtag returns a conflict with the CURRENT etag and document, and does not write', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}');
    const dataPath = path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json');
    const beforeBytes = fs.readFileSync(dataPath);

    const result = storage.replaceResource('plugin-a', 'state', 'sha256:stale-etag-value', { schemaVersion: 1, balance: 999 });
    assert.strictEqual(result.conflict, true);
    assert.match(result.etag, /^sha256:/);
    assert.strictEqual(result.document.balance, 0, 'conflict document is the CURRENT on-disk document, not the rejected write');
    assert.deepStrictEqual(fs.readFileSync(dataPath), beforeBytes, 'nothing was written on conflict');
  });

  test('a write without baseEtag is rejected', () => {
    enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x"}');
    const result = storage.replaceResource('plugin-a', 'state', undefined, { schemaVersion: 1 });
    assert.ok(result.error);
    assert.match(result.error, /baseEtag/);
  });

  test('a document over its byte limit fails without losing the prior bytes', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}', { maximumBytes: 300 });
    const before = storage.readResource('plugin-a', 'state');
    const dataPath = path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json');
    const beforeBytes = fs.readFileSync(dataPath);

    const result = storage.replaceResource('plugin-a', 'state', before.etag, {
      schemaVersion: 1, balance: 0, padding: 'x'.repeat(200),
    });
    assert.ok(result.error);
    assert.match(result.error, /byte limit/);
    assert.deepStrictEqual(fs.readFileSync(dataPath), beforeBytes);
  });

  test('a non-object document is rejected', () => {
    enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x"}');
    const before = storage.readResource('plugin-a', 'state');
    assert.ok(storage.replaceResource('plugin-a', 'state', before.etag, null).error);
    assert.ok(storage.replaceResource('plugin-a', 'state', before.etag, [1, 2]).error);
    assert.ok(storage.replaceResource('plugin-a', 'state', before.etag, 'a string').error);
  });

  test('a corrupt on-disk file is reported, never silently overwritten', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x"}');
    fs.writeFileSync(path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json'), '{not valid json');
    const result = storage.replaceResource('plugin-a', 'state', 'sha256:anything', { schemaVersion: 1 });
    assert.strictEqual(result.corrupt, true);
  });
});

describe('resetResourceFromTemplate', () => {
  test('rewrites a corrupt resource back to a fresh copy of its template', () => {
    const ws = enabledPluginWithResource('{"schemaVersion":1,"revision":0,"updatedAt":"x","balance":0}');
    const dataPath = path.join(ws, '.rundock', 'plugin-data', 'plugin-a', 'state.json');
    fs.writeFileSync(dataPath, '{not valid json');

    const result = storage.resetResourceFromTemplate('plugin-a', 'state');
    assert.ok(!result.error, JSON.stringify(result));
    assert.strictEqual(result.document.balance, 0);
    assert.strictEqual(result.document.revision, 0);

    const reread = storage.readResource('plugin-a', 'state');
    assert.strictEqual(reread.document.balance, 0);
  });
});

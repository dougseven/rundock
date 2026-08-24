'use strict';
// lib/plugins/ownership.js: .rundock/plugin-state.json reads/writes.
// Covers the atomic temp-file+rename write, and the "invalid state is
// backed up once and rebuilt with every plugin disabled" recovery rule.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const ownership = require('../../lib/plugins/ownership.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace() {
  const dir = makeTempDir('ws-');
  config.setWorkspace(dir);
  return dir;
}

function statePath(ws) { return path.join(ws, '.rundock', 'plugin-state.json'); }

describe('readPluginState / writePluginState', () => {
  test('reading with no state file yet returns an empty, valid state', () => {
    const ws = useWorkspace();
    const state = ownership.readPluginState();
    assert.strictEqual(state.schemaVersion, 1);
    assert.deepStrictEqual(state.plugins, {});
  });

  test('a written state round-trips exactly', () => {
    useWorkspace();
    const state = ownership.emptyState();
    state.plugins['plugin-a'] = {
      enabled: true, approvedHash: 'sha256:abc', installedVersion: '1.0.0',
      assignedOrders: { lead: 5 }, materializedAgents: ['rundock-plugin-plugin-a-lead'], materializedSkills: [],
    };
    ownership.writePluginState(state);
    const read = ownership.readPluginState();
    assert.deepStrictEqual(read, state);
  });

  test('writes leave no temp file behind', () => {
    const ws = useWorkspace();
    ownership.writePluginState(ownership.emptyState());
    const files = fs.readdirSync(path.join(ws, '.rundock'));
    assert.ok(!files.some(f => f.includes('.tmp-')), `unexpected temp file among: ${files.join(', ')}`);
    assert.ok(files.includes('plugin-state.json'));
  });

  test('malformed JSON is backed up once and reset to an empty (all-disabled) state', () => {
    const ws = useWorkspace();
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(statePath(ws), '{not valid json');
    const state = ownership.readPluginState();
    assert.deepStrictEqual(state.plugins, {});
    const files = fs.readdirSync(path.join(ws, '.rundock'));
    assert.ok(files.some(f => f.startsWith('plugin-state.json.invalid-')));
  });

  test('a wrong-shaped but valid-JSON file is also backed up and reset', () => {
    const ws = useWorkspace();
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(statePath(ws), JSON.stringify({ schemaVersion: 1, plugins: 'not-an-object' }));
    const state = ownership.readPluginState();
    assert.deepStrictEqual(state.plugins, {});
  });

  test('a future/unknown schemaVersion is backed up and reset rather than trusted', () => {
    const ws = useWorkspace();
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(statePath(ws), JSON.stringify({ schemaVersion: 2, plugins: {} }));
    const state = ownership.readPluginState();
    assert.strictEqual(state.schemaVersion, 1);
    assert.deepStrictEqual(state.plugins, {});
  });
});

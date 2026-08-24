'use strict';
// lib/plugins/discovery.js: package scan, classification, hashing, and the
// workspace-scoped discovery cache.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const discovery = require('../../lib/plugins/discovery.js');
const ownership = require('../../lib/plugins/ownership.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

function useWorkspace() {
  const dir = makeTempDir('ws-');
  config.setWorkspace(dir);
  discovery.invalidatePluginDiscoveryCache();
  return dir;
}

function installPackage(ws, id, overrides, extraFiles) {
  const dest = path.join(ws, '.rundock', 'plugins', id);
  writePluginPackage(dest, minimalManifest({ id, ...overrides }), extraFiles);
  return dest;
}

describe('computePackageHash', () => {
  test('is stable for identical content and differs for different content', () => {
    const ws = useWorkspace();
    const a = installPackage(ws, 'plugin-a');
    const b = installPackage(ws, 'plugin-b');
    const hashA1 = discovery.computePackageHash(a);
    const hashA2 = discovery.computePackageHash(a);
    const hashB = discovery.computePackageHash(b);
    assert.strictEqual(hashA1, hashA2);
    assert.notStrictEqual(hashA1, hashB);
    assert.match(hashA1, /^sha256:[0-9a-f]{64}$/);
  });

  test('changing a byte inside the package changes the hash', () => {
    const ws = useWorkspace();
    const dest = installPackage(ws, 'plugin-a', {}, { 'notes.txt': 'v1' });
    const before = discovery.computePackageHash(dest);
    fs.writeFileSync(path.join(dest, 'notes.txt'), 'v2');
    const after2 = discovery.computePackageHash(dest);
    assert.notStrictEqual(before, after2);
  });

  test('throws when the package contains a symbolic link anywhere', () => {
    const ws = useWorkspace();
    const dest = installPackage(ws, 'plugin-a');
    const outside = makeTempDir('outside-');
    fs.symlinkSync(outside, path.join(dest, 'linked-dir'));
    assert.throws(() => discovery.computePackageHash(dest), /symbolic link/);
  });
});

describe('discoverPlugins: classification', () => {
  test('an empty workspace (no .rundock/plugins) returns no plugins', () => {
    useWorkspace();
    assert.deepStrictEqual(discovery.discoverPlugins(), []);
  });

  test('a valid package with no plugin-state record is disabled', () => {
    const ws = useWorkspace();
    installPackage(ws, 'plugin-a');
    const [entry] = discovery.discoverPlugins();
    assert.strictEqual(entry.id, 'plugin-a');
    assert.strictEqual(entry.status, 'disabled');
    assert.deepStrictEqual(entry.errors, []);
  });

  test('an invalid package does not hide a valid sibling package', () => {
    const ws = useWorkspace();
    installPackage(ws, 'good-plugin');
    installPackage(ws, 'bad-plugin', { schemaVersion: 99 });
    const entries = discovery.discoverPlugins().sort((a, b) => a.id.localeCompare(b.id));
    assert.strictEqual(entries.length, 2);
    const bad = entries.find(e => e.id === 'bad-plugin');
    const good = entries.find(e => e.id === 'good-plugin');
    assert.strictEqual(bad.status, 'invalid');
    assert.ok(bad.errors.length > 0);
    assert.strictEqual(good.status, 'disabled');
  });

  test('enabled with a matching approved hash is "enabled"', () => {
    const ws = useWorkspace();
    const dest = installPackage(ws, 'plugin-a');
    const hash = discovery.computePackageHash(dest);
    const state = ownership.emptyState();
    state.plugins['plugin-a'] = { enabled: true, approvedHash: hash, installedVersion: '1.0.0', assignedOrders: {}, materializedAgents: [], materializedSkills: [] };
    ownership.writePluginState(state);
    discovery.invalidatePluginDiscoveryCache();
    const [entry] = discovery.discoverPlugins();
    assert.strictEqual(entry.status, 'enabled');
  });

  test('enabled with a stale approved hash is "approval_required"', () => {
    const ws = useWorkspace();
    const dest = installPackage(ws, 'plugin-a');
    const state = ownership.emptyState();
    state.plugins['plugin-a'] = { enabled: true, approvedHash: 'sha256:stale', installedVersion: '1.0.0', assignedOrders: {}, materializedAgents: [], materializedSkills: [] };
    ownership.writePluginState(state);
    discovery.invalidatePluginDiscoveryCache();
    const [entry] = discovery.discoverPlugins();
    assert.strictEqual(entry.status, 'approval_required');
  });

  test('a symlinked package directory is invalid', () => {
    const ws = useWorkspace();
    const real = makeTempDir('real-plugin-');
    writePluginPackage(real, minimalManifest({ id: 'plugin-a' }));
    fs.mkdirSync(path.join(ws, '.rundock', 'plugins'), { recursive: true });
    fs.symlinkSync(real, path.join(ws, '.rundock', 'plugins', 'plugin-a'));
    const [entry] = discovery.discoverPlugins();
    assert.strictEqual(entry.status, 'invalid');
  });
});

describe('discoverPlugins: cache', () => {
  test('repeated calls with no change on disk return the cached result by identity', () => {
    const ws = useWorkspace();
    installPackage(ws, 'plugin-a');
    const first = discovery.discoverPlugins();
    const second = discovery.discoverPlugins();
    assert.strictEqual(first, second);
  });

  test('a package added on disk is picked up without an explicit invalidate (directory signature changes)', () => {
    const ws = useWorkspace();
    installPackage(ws, 'plugin-a');
    const first = discovery.discoverPlugins();
    assert.strictEqual(first.length, 1);
    installPackage(ws, 'plugin-b');
    const second = discovery.discoverPlugins();
    assert.strictEqual(second.length, 2);
  });

  test('switching workspaces does not leak the previous workspace\'s cached plugins', () => {
    const wsA = useWorkspace();
    installPackage(wsA, 'plugin-a');
    const fromA = discovery.discoverPlugins();
    assert.strictEqual(fromA.length, 1);
    assert.strictEqual(fromA[0].id, 'plugin-a');

    const wsB = useWorkspace(); // switches config.setWorkspace to a fresh dir
    const fromB = discovery.discoverPlugins();
    assert.deepStrictEqual(fromB, []);
  });
});

'use strict';
// lib/plugins/assets.js: resolveAsset(), the approved-asset gate the HTTP
// router (lib/http-router.js) calls. Uses the real install/enable path so
// the entry it resolves against is the same discovery.discoverPlugins()
// shape the router sees.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const discovery = require('../../lib/plugins/discovery.js');
const assets = require('../../lib/plugins/assets.js');
const { makeWorkspace, makeTempDir, standardTeam, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

function enabledPlugin(overrides = {}, extraFiles = {}) {
  const ws = makeWorkspace({ agents: standardTeam() });
  config.setWorkspace(ws);
  discovery.invalidatePluginDiscoveryCache();
  invalidateAgentCache();
  const src = makeTempDir('plugin-src-');
  writePluginPackage(src, minimalManifest({
    id: 'plugin-a', ui: { entry: 'ui/index.js', styles: ['ui/app.css'] }, ...overrides,
  }), { 'ui/index.js': '// entry', 'ui/app.css': '/* styles */', ...extraFiles });
  const install = lifecycle.installFromFolder(src);
  assert.strictEqual(install.success, true, JSON.stringify(install.errors));
  const enable = lifecycle.enablePlugin('plugin-a');
  assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));
  return { ws, hash: enable.plugin.hash };
}

describe('resolveAsset', () => {
  test('resolves the declared entry and each declared style', () => {
    const { hash } = enabledPlugin();
    const entry = assets.resolveAsset('plugin-a', 'ui/index.js', hash);
    assert.strictEqual(entry.ok, true);
    assert.strictEqual(entry.contentType, 'application/javascript');
    const style = assets.resolveAsset('plugin-a', 'ui/app.css', hash);
    assert.strictEqual(style.ok, true);
    assert.strictEqual(style.contentType, 'text/css');
  });

  test('refuses an invalid plugin id shape before touching the filesystem', () => {
    enabledPlugin();
    const result = assets.resolveAsset('../escape', 'ui/index.js', 'sha256:x');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });

  test('refuses a plugin that is not installed', () => {
    const result = assets.resolveAsset('does-not-exist', 'ui/index.js', 'sha256:x');
    assert.strictEqual(result.ok, false);
  });

  test('refuses a disabled plugin even with its own real hash', () => {
    const { hash } = enabledPlugin();
    lifecycle.disablePlugin('plugin-a');
    const result = assets.resolveAsset('plugin-a', 'ui/index.js', hash);
    assert.strictEqual(result.ok, false);
  });

  test('refuses a stale hash', () => {
    enabledPlugin();
    const result = assets.resolveAsset('plugin-a', 'ui/index.js', 'sha256:stale');
    assert.strictEqual(result.ok, false);
  });

  test('refuses a real file in the package that is not the declared entry or a declared style', () => {
    const { hash } = enabledPlugin({}, { 'ui/other.js': '// not declared' });
    const result = assets.resolveAsset('plugin-a', 'ui/other.js', hash);
    assert.strictEqual(result.ok, false);
  });

  test('refuses manifest.json even with the correct hash', () => {
    const { hash } = enabledPlugin();
    const result = assets.resolveAsset('plugin-a', 'manifest.json', hash);
    assert.strictEqual(result.ok, false);
  });

  test('refuses traversal segments in the requested path', () => {
    const { hash } = enabledPlugin();
    const result = assets.resolveAsset('plugin-a', '../../../etc/passwd', hash);
    assert.strictEqual(result.ok, false);
  });
});

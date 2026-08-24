'use strict';
// Integration: the /plugins/<id>/<path>?h=<hash> HTTP route
// (lib/http-router.js + lib/plugins/assets.js), served by a real HTTP
// server. Exercises the full request path a browser-loaded plugin script
// or stylesheet actually takes, including the asset-refusal matrix the spec
// requires: disabled plugin, stale hash, undeclared file, plain traversal,
// encoded traversal, and symlink traversal.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const discovery = require('../../lib/plugins/discovery.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

let approvedHash;

before(async () => {
  await h.boot();
  const src = makeTempDir('plugin-src-');
  writePluginPackage(src, minimalManifest({
    id: 'plugin-a', ui: { entry: 'ui/index.js', styles: ['ui/app.css'] },
  }), {
    'ui/index.js': "RundockPluginHost.register('plugin-a', {});",
    'ui/app.css': '.plugin-a { color: red; }',
  });
  const install = lifecycle.installFromFolder(src);
  assert.strictEqual(install.success, true, JSON.stringify(install.errors));
  const enable = lifecycle.enablePlugin('plugin-a');
  assert.strictEqual(enable.success, true, JSON.stringify(enable.errors));
  approvedHash = enable.plugin.hash;
});
after(async () => h.shutdown());

function get(urlPath) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`).then(async res => ({
    status: res.status, body: await res.text(), headers: res.headers,
  }));
}

describe('/plugins/<id>/<path>?h=<hash>', () => {
  test('serves the declared entry script as application/javascript, nosniff, no-store', async () => {
    const res = await get(`/plugins/plugin-a/ui/index.js?h=${encodeURIComponent(approvedHash)}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes("register('plugin-a'"));
    assert.strictEqual(res.headers.get('content-type'), 'application/javascript');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });

  test('serves a declared style as text/css', async () => {
    const res = await get(`/plugins/plugin-a/ui/app.css?h=${encodeURIComponent(approvedHash)}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('.plugin-a'));
    assert.strictEqual(res.headers.get('content-type'), 'text/css');
  });

  test('a stale hash is refused', async () => {
    const res = await get('/plugins/plugin-a/ui/index.js?h=sha256:0000000000000000000000000000000000000000000000000000000000000000');
    assert.strictEqual(res.status, 404);
  });

  test('a missing hash is refused', async () => {
    const res = await get('/plugins/plugin-a/ui/index.js');
    assert.strictEqual(res.status, 404);
  });

  test('an undeclared file inside the same package is refused, even with the correct hash', async () => {
    const res = await get(`/plugins/plugin-a/manifest.json?h=${encodeURIComponent(approvedHash)}`);
    assert.strictEqual(res.status, 404);
  });

  test('a disabled plugin is refused even with its still-valid hash', async () => {
    const disable = lifecycle.disablePlugin('plugin-a');
    assert.strictEqual(disable.success, true);
    try {
      const res = await get(`/plugins/plugin-a/ui/index.js?h=${encodeURIComponent(approvedHash)}`);
      assert.strictEqual(res.status, 404);
    } finally {
      const reenable = lifecycle.enablePlugin('plugin-a');
      assert.strictEqual(reenable.success, true, JSON.stringify(reenable.errors));
      approvedHash = reenable.plugin.hash;
    }
  });

  test('plain path traversal is refused', async () => {
    const res = await get(`/plugins/plugin-a/../../../../etc/passwd?h=${encodeURIComponent(approvedHash)}`);
    // Node's http parser itself may normalize ../ before the handler ever
    // sees req.url; either a 404 from the handler or an entirely different
    // route (never a 200 exposing a file outside the package) is correct.
    assert.notStrictEqual(res.status, 200);
  });

  test('encoded path traversal is refused', async () => {
    const res = await get(`/plugins/plugin-a/ui%2f..%2f..%2fmanifest.json?h=${encodeURIComponent(approvedHash)}`);
    assert.notStrictEqual(res.status, 200);
  });

  test('the declared entry itself resolving through a symlink is refused, even with a matching approved hash', async () => {
    // Swap the DECLARED entry file for a symlink to something outside the
    // package, keeping the same declared name, and re-approve the resulting
    // hash directly (bypassing normal enable) so this isolates the real-
    // path/symlink check (steps 4-6): both the declared-asset-name check
    // and the hash check are made to pass, leaving only the symlink itself
    // as a reason to refuse.
    const ownership = require('../../lib/plugins/ownership.js');
    const packageDir = path.join(h.workspaceDir, '.rundock', 'plugins', 'plugin-a');
    const outside = makeTempDir('outside-');
    const outsideFile = path.join(outside, 'evil.js');
    fs.writeFileSync(outsideFile, 'console.log("should never serve");');
    const entryPath = path.join(packageDir, 'ui', 'index.js');
    const originalContent = fs.readFileSync(entryPath, 'utf-8');
    fs.unlinkSync(entryPath);
    fs.symlinkSync(outsideFile, entryPath);
    discovery.invalidatePluginDiscoveryCache();
    let symlinkedHash;
    try {
      symlinkedHash = discovery.computePackageHash(fs.realpathSync(packageDir));
    } catch (e) {
      // computePackageHash itself refuses any symlink in the tree: that IS
      // the property under test, just caught one layer earlier than the
      // HTTP route. Either way, nothing must ever be served for this state.
      symlinkedHash = null;
    }
    if (symlinkedHash) {
      const state = ownership.readPluginState();
      state.plugins['plugin-a'].approvedHash = symlinkedHash;
      ownership.writePluginState(state);
      discovery.invalidatePluginDiscoveryCache();
    }
    try {
      const res = await get(`/plugins/plugin-a/ui/index.js?h=${encodeURIComponent(symlinkedHash || approvedHash)}`);
      assert.strictEqual(res.status, 404);
    } finally {
      fs.unlinkSync(entryPath);
      fs.writeFileSync(entryPath, originalContent);
      const state = ownership.readPluginState();
      state.plugins['plugin-a'].approvedHash = approvedHash;
      ownership.writePluginState(state);
      discovery.invalidatePluginDiscoveryCache();
    }
  });
});

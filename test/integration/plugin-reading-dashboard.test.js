'use strict';
// The generic-framework proof: test/fixtures/reading-dashboard/ is a
// complete, deliberately non-investment plugin package (one route, one
// read-only agent, one JSON resource) that exercises install, enable,
// materialization, resource bootstrap, and approved asset serving through
// nothing but the public plugin contract. Per the spec: "Issue #199 is not
// complete until this second fixture passes." No framework module (lib/
// plugins/*, lib/protocol/handlers/plugins.js, lib/http-router.js,
// public/plugin-host.js) is modified by this test or needed any change to
// make it pass.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const storage = require('../../lib/plugins/storage.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'reading-dashboard');

let enableResult;

before(async () => {
  await h.boot();
  const install = lifecycle.installFromFolder(FIXTURE_DIR);
  assert.strictEqual(install.success, true, JSON.stringify(install.errors));
  enableResult = lifecycle.enablePlugin('reading-dashboard');
  assert.strictEqual(enableResult.success, true, JSON.stringify(enableResult.errors));
});
after(async () => h.shutdown());

function get(urlPath) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`).then(async res => ({
    status: res.status, body: await res.text(), headers: res.headers,
  }));
}

describe('reading-dashboard: install and enable', () => {
  test('materializes its one agent under the reserved runtime slug, loadable by name', () => {
    const agentPath = path.join(h.workspaceDir, '.claude', 'agents', 'rundock-plugin-reading-dashboard-librarian.md');
    assert.ok(fs.existsSync(agentPath));
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.match(content, /^name: rundock-plugin-reading-dashboard-librarian$/m);
    assert.match(content, /^type: specialist$/m);
    assert.match(content, /^rundockPlugin: reading-dashboard$/m);
    assert.match(content, /^rundockManaged: true$/m);

    const { discoverAgents } = require('../../lib/agents/discovery.js');
    const roster = discoverAgents();
    const librarian = roster.find(a => a.name === 'rundock-plugin-reading-dashboard-librarian');
    assert.ok(librarian, 'the materialized agent must be visible to normal agent discovery');
    assert.strictEqual(librarian.status, 'onTeam');
  });

  test('bootstraps its one resource from the template', () => {
    const dataPath = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'reading-dashboard', 'reading-list.json');
    assert.ok(fs.existsSync(dataPath));
    const doc = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.deepStrictEqual(doc.books, []);
    assert.strictEqual(doc.revision, 0);
  });
});

describe('reading-dashboard: generic resource storage', () => {
  test('reads and compare-and-swap writes the resource through lib/plugins/storage.js', () => {
    const before1 = storage.readResource('reading-dashboard', 'reading-list');
    assert.deepStrictEqual(before1.document.books, []);

    const written = storage.replaceResource('reading-dashboard', 'reading-list', before1.etag, {
      books: [{ title: 'A Fixture, Read Closely' }],
    });
    assert.ok(!written.error && !written.conflict, JSON.stringify(written));
    assert.strictEqual(written.document.books.length, 1);
    assert.strictEqual(written.document.revision, 1);

    const after1 = storage.readResource('reading-dashboard', 'reading-list');
    assert.deepStrictEqual(after1.document.books, [{ title: 'A Fixture, Read Closely' }]);
  });
});

describe('reading-dashboard: approved asset serving', () => {
  test('serves its entry script and stylesheet at the approved-hash URL', async () => {
    const hash = enableResult.plugin.hash;
    const script = await get(`/plugins/reading-dashboard/ui/index.js?h=${encodeURIComponent(hash)}`);
    assert.strictEqual(script.status, 200);
    assert.ok(script.body.includes("RundockPluginHost.register('reading-dashboard'"));
    assert.strictEqual(script.headers.get('content-type'), 'application/javascript');

    const style = await get(`/plugins/reading-dashboard/ui/reading.css?h=${encodeURIComponent(hash)}`);
    assert.strictEqual(style.status, 200);
    assert.ok(style.body.includes('data-plugin-id="reading-dashboard"'));
  });
});

describe('reading-dashboard: disable and uninstall', () => {
  test('disable removes the materialized agent but preserves package and data', () => {
    const agentPath = path.join(h.workspaceDir, '.claude', 'agents', 'rundock-plugin-reading-dashboard-librarian.md');
    const dataPath = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'reading-dashboard', 'reading-list.json');
    const packageDir = path.join(h.workspaceDir, '.rundock', 'plugins', 'reading-dashboard');

    const disable = lifecycle.disablePlugin('reading-dashboard');
    assert.strictEqual(disable.success, true);
    assert.ok(!fs.existsSync(agentPath));
    assert.ok(fs.existsSync(dataPath), 'plugin data must survive a disable');
    assert.ok(fs.existsSync(packageDir), 'the installed package must survive a disable');
  });

  test('uninstall removes the package but preserves data by default', () => {
    const dataPath = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'reading-dashboard', 'reading-list.json');
    const packageDir = path.join(h.workspaceDir, '.rundock', 'plugins', 'reading-dashboard');

    const uninstall = lifecycle.uninstallPlugin('reading-dashboard');
    assert.strictEqual(uninstall.success, true);
    assert.ok(!fs.existsSync(packageDir));
    assert.ok(fs.existsSync(dataPath));
  });
});

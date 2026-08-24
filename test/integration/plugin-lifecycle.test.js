'use strict';
// Round-trip coverage for lib/plugins/lifecycle.js: install, enable, disable,
// update, uninstall, and workspace-open reconciliation. Phase 1 of the
// plugin framework spec (.specs/spec-rundock-workspace-plugin-framework.md);
// see .specs/workplan-rundock-workspace-plugin-framework.md for phase scope.
//
// Every enable-path test here uses a manifest with no agents, skills, or
// resources: materialize.js (Phase 2) and storage.js (Phase 3) do not exist
// yet, and lifecycle.enablePlugin() deliberately refuses anything that would
// need them (see the PHASE BOUNDARY note at the top of lifecycle.js). One
// test below exercises that refusal directly.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const discovery = require('../../lib/plugins/discovery.js');
const ownership = require('../../lib/plugins/ownership.js');
const { makeWorkspace, makeTempDir, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  config.setWorkspace(dir);
  discovery.invalidatePluginDiscoveryCache();
  // Agent discovery caches its roster for AGENT_CACHE_TTL regardless of
  // workspace; without this, enablePlugin's orchestrator resolution could
  // read a PREVIOUS test's roster within that window.
  invalidateAgentCache();
  return dir;
}

function makeSource(overrides, extraFiles) {
  const dir = makeTempDir('plugin-src-');
  writePluginPackage(dir, minimalManifest(overrides), extraFiles);
  return dir;
}

describe('installFromFolder', () => {
  test('installs a valid package and records a disabled plugin-state entry', () => {
    useWorkspace();
    const src = makeSource({ id: 'plugin-a' });
    const result = lifecycle.installFromFolder(src);
    assert.strictEqual(result.success, true);

    const installedManifest = path.join(config.getWorkspace(), '.rundock', 'plugins', 'plugin-a', 'manifest.json');
    assert.ok(fs.existsSync(installedManifest));

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, false);
    assert.strictEqual(state.plugins['plugin-a'].approvedHash, null);
    assert.strictEqual(state.plugins['plugin-a'].installedVersion, '1.0.0');
  });

  test('never enables UI code implicitly: the source ui/ files are copied but nothing is materialized', () => {
    useWorkspace();
    const src = makeSource({ id: 'plugin-a', ui: { entry: 'ui/index.js' } }, { 'ui/index.js': '// entry' });
    const result = lifecycle.installFromFolder(src);
    assert.strictEqual(result.success, true);
    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, false);
  });

  test('rejects an invalid manifest and installs nothing', () => {
    const ws = useWorkspace();
    const src = makeSource({ schemaVersion: 99 });
    const result = lifecycle.installFromFolder(src);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
    assert.ok(!fs.existsSync(path.join(ws, '.rundock', 'plugins', 'test-plugin')));
  });

  test('rejects a symlinked source directory', () => {
    useWorkspace();
    const real = makeSource({ id: 'plugin-a' });
    const link = path.join(makeTempDir('link-parent-'), 'link');
    fs.symlinkSync(real, link);
    const result = lifecycle.installFromFolder(link);
    assert.strictEqual(result.success, false);
  });

  test('refuses to install over an already-installed plugin id', () => {
    useWorkspace();
    const src = makeSource({ id: 'plugin-a' });
    assert.strictEqual(lifecycle.installFromFolder(src).success, true);
    const result = lifecycle.installFromFolder(src);
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /already installed/);
  });
});

describe('enablePlugin', () => {
  test('fails when the workspace has no orchestrator', () => {
    useWorkspace({ agents: {} });
    const src = makeSource({ id: 'plugin-a' });
    lifecycle.installFromFolder(src);
    const result = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /orchestrator/);
  });

  test('enables an empty (no agents/skills/resources) plugin and records the approved hash', () => {
    useWorkspace({ agents: standardTeam() });
    const src = makeSource({ id: 'plugin-a' });
    lifecycle.installFromFolder(src);
    const result = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.match(result.plugin.hash, /^sha256:/);

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, true);
    assert.strictEqual(state.plugins['plugin-a'].approvedHash, result.plugin.hash);

    const [entry] = discovery.discoverPlugins();
    assert.strictEqual(entry.status, 'enabled');
  });

  test('refuses to enable a plugin declaring agents, with a clear Phase 2 message (not a crash)', () => {
    useWorkspace({ agents: standardTeam() });
    const src = makeSource(
      { id: 'plugin-a', agents: [{ slug: 'lead', source: 'agents/lead.md', reportsTo: '$orchestrator' }] },
      { 'agents/lead.md': '---\nname: lead\n---\n\nYou lead.' },
    );
    lifecycle.installFromFolder(src);
    const result = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /Phase 2/);
  });

  test('fails cleanly when the plugin is not installed', () => {
    useWorkspace({ agents: standardTeam() });
    const result = lifecycle.enablePlugin('does-not-exist');
    assert.strictEqual(result.success, false);
  });
});

describe('disablePlugin', () => {
  test('flips enabled to false and preserves the installed package', () => {
    useWorkspace({ agents: standardTeam() });
    const src = makeSource({ id: 'plugin-a' });
    lifecycle.installFromFolder(src);
    lifecycle.enablePlugin('plugin-a');

    const result = lifecycle.disablePlugin('plugin-a');
    assert.strictEqual(result.success, true);

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, false);
    assert.ok(fs.existsSync(path.join(config.getWorkspace(), '.rundock', 'plugins', 'plugin-a', 'manifest.json')));
  });

  test('disabling an already-disabled plugin is a no-op success', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    assert.strictEqual(lifecycle.disablePlugin('plugin-a').success, true);
  });
});

describe('updateFromFolder', () => {
  test('replaces the package and revokes the prior approval', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a', version: '1.0.0' }));
    lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(ownership.readPluginState().plugins['plugin-a'].enabled, true);

    const updateSrc = makeSource({ id: 'plugin-a', version: '1.1.0' }, { 'CHANGES.md': 'v1.1.0' });
    const result = lifecycle.updateFromFolder('plugin-a', updateSrc);
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, false);
    assert.strictEqual(state.plugins['plugin-a'].approvedHash, null);
    assert.strictEqual(state.plugins['plugin-a'].installedVersion, '1.1.0');
    assert.ok(fs.existsSync(path.join(config.getWorkspace(), '.rundock', 'plugins', 'plugin-a', 'CHANGES.md')));
  });

  test('refuses an update package whose manifest id differs from the installed plugin', () => {
    useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    const wrongId = makeSource({ id: 'plugin-b' });
    const result = lifecycle.updateFromFolder('plugin-a', wrongId);
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /does not match/);
  });

  test('fails when the plugin is not already installed', () => {
    useWorkspace({ agents: standardTeam() });
    const result = lifecycle.updateFromFolder('plugin-a', makeSource({ id: 'plugin-a' }));
    assert.strictEqual(result.success, false);
  });
});

describe('uninstallPlugin', () => {
  test('removes the package and state record but preserves plugin data by default', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    lifecycle.enablePlugin('plugin-a');

    const dataDir = path.join(ws, '.rundock', 'plugin-data', 'plugin-a');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');

    const result = lifecycle.uninstallPlugin('plugin-a');
    assert.strictEqual(result.success, true);
    assert.ok(!fs.existsSync(path.join(ws, '.rundock', 'plugins', 'plugin-a')));
    assert.ok(!ownership.readPluginState().plugins['plugin-a']);
    assert.ok(fs.existsSync(dataDir), 'plugin data must survive a default uninstall');
  });

  test('deleteData: true also removes the plugin data directory', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    const dataDir = path.join(ws, '.rundock', 'plugin-data', 'plugin-a');
    fs.mkdirSync(dataDir, { recursive: true });

    lifecycle.uninstallPlugin('plugin-a', { deleteData: true });
    assert.ok(!fs.existsSync(dataDir));
  });
});

describe('reconcile', () => {
  test('disables an enabled plugin whose package changed outside Rundock', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(ownership.readPluginState().plugins['plugin-a'].enabled, true);

    // Simulate an external edit to the installed package.
    fs.writeFileSync(path.join(ws, '.rundock', 'plugins', 'plugin-a', 'extra-file.txt'), 'surprise');

    lifecycle.reconcile();
    assert.strictEqual(ownership.readPluginState().plugins['plugin-a'].enabled, false);
  });

  test('does not disturb a disabled plugin or a still-valid enabled plugin', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource({ id: 'plugin-a' }));
    lifecycle.installFromFolder(makeSource({ id: 'plugin-b' }));
    lifecycle.enablePlugin('plugin-b');

    lifecycle.reconcile();

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['plugin-a'].enabled, false);
    assert.strictEqual(state.plugins['plugin-b'].enabled, true);
  });

  test('is a no-op with no workspace selected', () => {
    config.setWorkspace(null);
    assert.doesNotThrow(() => lifecycle.reconcile());
  });
});

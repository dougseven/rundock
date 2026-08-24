'use strict';
// Round-trip coverage for lib/plugins/lifecycle.js: install, enable, disable,
// update, uninstall, and workspace-open reconciliation, following the plugin
// framework spec (.specs/spec-rundock-workspace-plugin-framework.md).
//
// Most enable-path tests use a manifest with no agents, skills, or
// resources: the smallest case that fully exercises install/enable/disable/
// update/uninstall without needing lib/plugins/storage.js, which does not
// exist yet (a plugin declaring resources is still refused, tested below).
// A separate describe block below covers real agent/skill materialization,
// through lib/plugins/materialize.js, end to end.
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

  test('refuses to enable a plugin declaring resources, with a clear message (not a crash)', () => {
    useWorkspace({ agents: standardTeam() });
    const src = makeSource(
      { id: 'plugin-a', resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json' }] },
      { 'templates/state.json': '{}' },
    );
    lifecycle.installFromFolder(src);
    const result = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /storage\.js/);
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

describe('enablePlugin: real agent and skill materialization', () => {
  function makeInvestmentishSource(overrides) {
    return makeSource({
      id: 'investment-dashboard',
      agents: [
        { slug: 'lead-partner', source: 'agents/lead-partner.md', reportsTo: '$orchestrator' },
        { slug: 'equity-analyst', source: 'agents/equity-analyst.md', reportsTo: 'lead-partner' },
      ],
      skills: [{ slug: 'investment-review', source: 'skills/investment-review/SKILL.md' }],
      ...overrides,
    }, {
      'agents/lead-partner.md': '---\nname: lead-partner\nskills: [investment-review]\n---\n\nYou lead.',
      'agents/equity-analyst.md': '---\nname: equity-analyst\n---\n\nYou analyse.',
      'skills/investment-review/SKILL.md': '---\nname: Investment Review\n---\n\nHow to review.',
    });
  }

  test('materializes both agents (with correct reportsTo chain) and the skill', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeInvestmentishSource());
    const result = lifecycle.enablePlugin('investment-dashboard');
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));

    const leadPath = path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-lead-partner.md');
    const analystPath = path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-equity-analyst.md');
    const skillPath = path.join(ws, '.claude', 'skills', 'rundock-plugin-investment-dashboard-investment-review', 'SKILL.md');
    assert.ok(fs.existsSync(leadPath));
    assert.ok(fs.existsSync(analystPath));
    assert.ok(fs.existsSync(skillPath));

    const leadContent = fs.readFileSync(leadPath, 'utf-8');
    assert.match(leadContent, /^reportsTo: chief-of-staff$/m, 'lead-partner reports to the ACTUAL orchestrator frontmatter name');
    assert.match(leadContent, /^skills: \[rundock-plugin-investment-dashboard-investment-review\]$/m);
    const analystContent = fs.readFileSync(analystPath, 'utf-8');
    assert.match(analystContent, /^reportsTo: rundock-plugin-investment-dashboard-lead-partner$/m,
      'equity-analyst reports to the LEAD PARTNER\'s derived runtime slug, not the workspace orchestrator');

    const state = ownership.readPluginState();
    assert.deepStrictEqual(state.plugins['investment-dashboard'].materializedAgents.sort(), [
      'rundock-plugin-investment-dashboard-equity-analyst',
      'rundock-plugin-investment-dashboard-lead-partner',
    ]);
    assert.deepStrictEqual(state.plugins['investment-dashboard'].materializedSkills, [
      'rundock-plugin-investment-dashboard-investment-review',
    ]);

    // Claude and Codex both load agent instructions straight from .claude/agents/:
    // this file existing there under its runtime slug IS that guarantee.
    const { discoverAgents } = require('../../lib/agents/discovery.js');
    invalidateAgentCache();
    const roster = discoverAgents();
    const materializedLead = roster.find(a => a.name === 'rundock-plugin-investment-dashboard-lead-partner');
    assert.ok(materializedLead, 'the materialized agent must be visible to normal agent discovery');
    assert.strictEqual(materializedLead.rundockManaged, true);
    assert.strictEqual(materializedLead.rundockPlugin, 'investment-dashboard');
  });

  test('disable removes the materialized files and clears the state record; re-enable regenerates them', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeInvestmentishSource());
    lifecycle.enablePlugin('investment-dashboard');
    const leadPath = path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-lead-partner.md');
    assert.ok(fs.existsSync(leadPath));

    lifecycle.disablePlugin('investment-dashboard');
    assert.ok(!fs.existsSync(leadPath));
    let state = ownership.readPluginState();
    assert.deepStrictEqual(state.plugins['investment-dashboard'].materializedAgents, []);
    assert.deepStrictEqual(state.plugins['investment-dashboard'].materializedSkills, []);

    const reenable = lifecycle.enablePlugin('investment-dashboard');
    assert.strictEqual(reenable.success, true, JSON.stringify(reenable.errors));
    assert.ok(fs.existsSync(leadPath));
    state = ownership.readPluginState();
    assert.strictEqual(state.plugins['investment-dashboard'].materializedAgents.length, 2);
  });

  test('enablement is blocked when the target runtime slug already exists', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-lead-partner.md'), 'squatting');
    lifecycle.installFromFolder(makeInvestmentishSource());
    const result = lifecycle.enablePlugin('investment-dashboard');
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /already exists/);
  });

  test('an agent whose source frontmatter name does not match its manifest slug refuses enablement, with nothing materialized', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeSource(
      { id: 'plugin-a', agents: [{ slug: 'lead', source: 'agents/lead.md', reportsTo: '$orchestrator' }] },
      { 'agents/lead.md': '---\nname: someone-else\n---\n\nHi.' },
    ));
    const result = lifecycle.enablePlugin('plugin-a');
    assert.strictEqual(result.success, false);
    assert.match(result.errors[0].message, /must equal the manifest slug/);
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-plugin-a-lead.md')));
    assert.strictEqual(ownership.readPluginState().plugins['plugin-a'].enabled, false);
  });

  test('update revokes approval AND removes the previous version\'s projections', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    lifecycle.installFromFolder(makeInvestmentishSource());
    lifecycle.enablePlugin('investment-dashboard');
    const leadPath = path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-lead-partner.md');
    assert.ok(fs.existsSync(leadPath));

    // The updated package drops the equity-analyst agent entirely.
    const updateSrc = makeSource({
      id: 'investment-dashboard', version: '1.1.0',
      agents: [{ slug: 'lead-partner', source: 'agents/lead-partner.md', reportsTo: '$orchestrator' }],
    }, { 'agents/lead-partner.md': '---\nname: lead-partner\n---\n\nYou lead, alone now.' });

    const result = lifecycle.updateFromFolder('investment-dashboard', updateSrc);
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.ok(!fs.existsSync(leadPath), 'the prior version\'s projection must be gone once update disables the plugin');

    const state = ownership.readPluginState();
    assert.strictEqual(state.plugins['investment-dashboard'].enabled, false);
    assert.deepStrictEqual(state.plugins['investment-dashboard'].materializedAgents, []);

    const reenable = lifecycle.enablePlugin('investment-dashboard');
    assert.strictEqual(reenable.success, true, JSON.stringify(reenable.errors));
    assert.ok(fs.existsSync(leadPath));
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-investment-dashboard-equity-analyst.md')));
  });
});

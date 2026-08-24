'use strict';
// lib/plugins/lifecycle.js: the pure/synchronous pieces of the enable
// transaction that Phase 1 implements fully (orchestrator resolution,
// runtime-slug conflict detection, org-chart order assignment), tested
// directly rather than only through the full install/enable round trip.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const { makeWorkspace, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  config.setWorkspace(dir);
  // Agent discovery caches its roster for AGENT_CACHE_TTL regardless of
  // workspace; without this, a test that switches workspace within that
  // window would read the PREVIOUS workspace's roster.
  invalidateAgentCache();
  return dir;
}

describe('resolveOrchestrator', () => {
  test('errors when the workspace has no orchestrator', () => {
    useWorkspace({ agents: {} });
    const { orchestrator, error } = lifecycle.resolveOrchestrator();
    assert.strictEqual(orchestrator, null);
    assert.match(error, /exactly one workspace orchestrator/);
  });

  test('resolves the single orchestrator', () => {
    useWorkspace({ agents: standardTeam() });
    const { orchestrator, error } = lifecycle.resolveOrchestrator();
    assert.strictEqual(error, null);
    assert.strictEqual(orchestrator.type, 'orchestrator');
  });

  test('errors when more than one orchestrator exists', () => {
    const team = standardTeam();
    team['second-orchestrator'] = agentFile({
      name: 'second-orchestrator', type: 'orchestrator', order: 10,
    });
    useWorkspace({ agents: team });
    const { orchestrator, error } = lifecycle.resolveOrchestrator();
    assert.strictEqual(orchestrator, null);
    assert.match(error, /found 2/);
  });
});

describe('runtimeSlugConflicts', () => {
  test('no conflicts when nothing is materialized yet', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    const manifest = { id: 'investment-dashboard', agents: [{ slug: 'lead-partner', source: 'agents/lead-partner.md' }], skills: [] };
    assert.deepStrictEqual(lifecycle.runtimeSlugConflicts(manifest), []);
  });

  test('flags an agent runtime slug that already exists on disk, even if malformed', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    const runtimeSlug = 'rundock-plugin-investment-dashboard-lead-partner';
    fs.writeFileSync(path.join(ws, '.claude', 'agents', `${runtimeSlug}.md`), 'not even frontmatter');
    const manifest = { id: 'investment-dashboard', agents: [{ slug: 'lead-partner', source: 'agents/lead-partner.md' }], skills: [] };
    const conflicts = lifecycle.runtimeSlugConflicts(manifest);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].type, 'agent');
    assert.strictEqual(conflicts[0].slug, runtimeSlug);
  });

  test('flags a skill runtime slug that already exists on disk', () => {
    const ws = useWorkspace({ agents: standardTeam() });
    const runtimeSlug = 'rundock-plugin-investment-dashboard-investment-review';
    fs.mkdirSync(path.join(ws, '.claude', 'skills', runtimeSlug), { recursive: true });
    const manifest = { id: 'investment-dashboard', agents: [], skills: [{ slug: 'investment-review', source: 'skills/investment-review/SKILL.md' }] };
    const conflicts = lifecycle.runtimeSlugConflicts(manifest);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].type, 'skill');
    assert.strictEqual(conflicts[0].slug, runtimeSlug);
  });
});

describe('assignOrders', () => {
  test('a manifest with no agents gets no assigned orders', () => {
    assert.deepStrictEqual(lifecycle.assignOrders({ agents: [] }, []), {});
  });

  test('roots reporting to $orchestrator take the next whole numbers after the current max order', () => {
    const existingAgents = [{ order: 1 }, { order: 4 }];
    const manifest = {
      agents: [
        { slug: 'lead-partner', reportsTo: '$orchestrator' },
      ],
    };
    assert.deepStrictEqual(lifecycle.assignOrders(manifest, existingAgents), { 'lead-partner': 5 });
  });

  test('plugin-local children take fractional suffixes under their parent, in declaration order', () => {
    const existingAgents = [{ order: 4 }];
    const manifest = {
      agents: [
        { slug: 'lead-partner', reportsTo: '$orchestrator' },
        { slug: 'equity-analyst', reportsTo: 'lead-partner' },
        { slug: 'risk-manager', reportsTo: 'lead-partner' },
      ],
    };
    assert.deepStrictEqual(lifecycle.assignOrders(manifest, existingAgents), {
      'lead-partner': 5,
      'equity-analyst': 5.1,
      'risk-manager': 5.2,
    });
  });

  test('an existing roster with no ordered agents starts the plugin at order 1', () => {
    const manifest = { agents: [{ slug: 'solo', reportsTo: '$orchestrator' }] };
    assert.deepStrictEqual(lifecycle.assignOrders(manifest, []), { solo: 1 });
  });
});

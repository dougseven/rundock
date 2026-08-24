'use strict';
// lib/plugins/materialize.js: agent/skill frontmatter transformation and the
// materialize/remove transaction. See the plugin framework spec's "Agent
// materialization" and "Skill materialization" sections for the exact
// transformations under test.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const materialize = require('../../lib/plugins/materialize.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  config.setWorkspace(dir);
  return dir;
}

function agentSource({ name = 'lead', extra = '', body = 'You lead.' } = {}) {
  return `---\nname: ${name}\n${extra}---\n\n${body}\n`;
}

describe('buildMaterializedAgentContent', () => {
  test('rejects a source whose frontmatter name does not equal the manifest slug', () => {
    assert.throws(() => materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'lead-partner' }, sourceContent: agentSource({ name: 'lead' }),
      reportsToRuntimeValue: 'cos', assignedOrder: 5, localSkillSlugToRuntimeSlug: new Map(),
    }), materialize.MaterializeError);
  });

  test('rejects a source with no frontmatter block', () => {
    assert.throws(() => materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'lead' }, sourceContent: 'no frontmatter here',
      reportsToRuntimeValue: 'cos', assignedOrder: 5, localSkillSlugToRuntimeSlug: new Map(),
    }), materialize.MaterializeError);
  });

  test('sets name, type, reportsTo, order, and the rundock ownership fields', () => {
    const { runtimeSlug, content } = materialize.buildMaterializedAgentContent({
      pluginId: 'investment-dashboard', agentDecl: { slug: 'lead-partner' },
      sourceContent: agentSource({ name: 'lead-partner', extra: 'type: specialist\ndisplayName: Lead Partner\n' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 5, localSkillSlugToRuntimeSlug: new Map(),
    });
    assert.strictEqual(runtimeSlug, 'rundock-plugin-investment-dashboard-lead-partner');
    assert.match(content, /^name: rundock-plugin-investment-dashboard-lead-partner$/m);
    assert.match(content, /^rundockPluginAgent: lead-partner$/m);
    assert.match(content, /^type: specialist$/m);
    assert.match(content, /^reportsTo: chief-of-staff$/m);
    assert.match(content, /^order: 5$/m);
    assert.match(content, /^rundockPlugin: investment-dashboard$/m);
    assert.match(content, /^rundockManaged: true$/m);
    // displayName and the body ride through untouched.
    assert.match(content, /^displayName: Lead Partner$/m);
    assert.match(content, /You lead\./);
  });

  test('overwrites a source that already declares type/order/reportsTo rather than duplicating the line', () => {
    const { content } = materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'lead' },
      sourceContent: agentSource({ name: 'lead', extra: 'type: orchestrator\norder: 1\nreportsTo: nobody\n' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 5, localSkillSlugToRuntimeSlug: new Map(),
    });
    assert.strictEqual((content.match(/^type:/gm) || []).length, 1);
    assert.strictEqual((content.match(/^order:/gm) || []).length, 1);
    assert.strictEqual((content.match(/^reportsTo:/gm) || []).length, 1);
    assert.match(content, /^type: specialist$/m);
    assert.match(content, /^order: 5$/m);
    assert.match(content, /^reportsTo: chief-of-staff$/m);
  });

  test('rewrites an inline skills: [] list to derived runtime slugs', () => {
    const map = new Map([['investment-review', 'rundock-plugin-investment-dashboard-investment-review']]);
    const { content } = materialize.buildMaterializedAgentContent({
      pluginId: 'investment-dashboard', agentDecl: { slug: 'lead' },
      sourceContent: agentSource({ name: 'lead', extra: 'skills: [investment-review]\n' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 5, localSkillSlugToRuntimeSlug: map,
    });
    assert.match(content, /^skills: \[rundock-plugin-investment-dashboard-investment-review\]$/m);
  });

  test('rewrites a block-list skills: form to the same inline runtime form', () => {
    const map = new Map([['investment-review', 'rundock-plugin-investment-dashboard-investment-review']]);
    const { content } = materialize.buildMaterializedAgentContent({
      pluginId: 'investment-dashboard', agentDecl: { slug: 'lead' },
      sourceContent: agentSource({ name: 'lead', extra: 'skills:\n  - investment-review\n' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 5, localSkillSlugToRuntimeSlug: map,
    });
    assert.match(content, /^skills: \[rundock-plugin-investment-dashboard-investment-review\]$/m);
  });

  test('rejects a skill reference the manifest does not declare', () => {
    assert.throws(() => materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'lead' },
      sourceContent: agentSource({ name: 'lead', extra: 'skills: [undeclared-skill]\n' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 5, localSkillSlugToRuntimeSlug: new Map(),
    }), materialize.MaterializeError);
  });

  test('$orchestrator resolution and plugin-local parent resolution are both just a passed-through value', () => {
    // materializePlugin resolves WHICH value to pass; buildMaterializedAgentContent
    // only writes whatever it is given. This locks the seam between the two.
    const asOrchestrator = materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'lead' }, sourceContent: agentSource({ name: 'lead' }),
      reportsToRuntimeValue: 'chief-of-staff', assignedOrder: 1, localSkillSlugToRuntimeSlug: new Map(),
    });
    assert.match(asOrchestrator.content, /^reportsTo: chief-of-staff$/m);

    const asLocalParent = materialize.buildMaterializedAgentContent({
      pluginId: 'inv', agentDecl: { slug: 'analyst' }, sourceContent: agentSource({ name: 'analyst' }),
      reportsToRuntimeValue: 'rundock-plugin-inv-lead', assignedOrder: 1.1, localSkillSlugToRuntimeSlug: new Map(),
    });
    assert.match(asLocalParent.content, /^reportsTo: rundock-plugin-inv-lead$/m);
  });
});

describe('materializePlugin', () => {
  function manifestWith(overrides) {
    return {
      id: 'inv', schemaVersion: 1, name: 'Inv', version: '1.0.0',
      rundock: { minimumVersion: '0.11.8' }, agents: [], skills: [], ...overrides,
    };
  }

  function writeSource(dir, rel, content) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }

  test('materializes agents and skills, returning their runtime slugs', () => {
    const ws = useWorkspace();
    const pkgDir = fs.mkdtempSync(path.join(ws, 'pkg-'));
    writeSource(pkgDir, 'agents/lead.md', agentSource({ name: 'lead', extra: 'skills: [review]\n' }));
    writeSource(pkgDir, 'skills/review/SKILL.md', '---\nname: Review\n---\n\nReview things.');

    const manifest = manifestWith({
      agents: [{ slug: 'lead', source: 'agents/lead.md', reportsTo: '$orchestrator' }],
      skills: [{ slug: 'review', source: 'skills/review/SKILL.md' }],
    });
    const result = materialize.materializePlugin({
      pluginId: 'inv', packageRealPath: fs.realpathSync(pkgDir), manifest,
      assignedOrders: { lead: 5 }, orchestratorFrontmatterName: 'chief-of-staff',
    });

    assert.deepStrictEqual(result.materializedAgents, ['rundock-plugin-inv-lead']);
    assert.deepStrictEqual(result.materializedSkills, ['rundock-plugin-inv-review']);
    assert.ok(fs.existsSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-inv-lead.md')));
    assert.ok(fs.existsSync(path.join(ws, '.claude', 'skills', 'rundock-plugin-inv-review', 'SKILL.md')));

    const agentContent = fs.readFileSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-inv-lead.md'), 'utf-8');
    assert.match(agentContent, /^skills: \[rundock-plugin-inv-review\]$/m);
  });

  test('rolls back every file it wrote when a later agent fails to materialize', () => {
    const ws = useWorkspace();
    const pkgDir = fs.mkdtempSync(path.join(ws, 'pkg-'));
    writeSource(pkgDir, 'agents/first.md', agentSource({ name: 'first' }));
    // Second agent's source name does not match its declared slug: fails validation.
    writeSource(pkgDir, 'agents/second.md', agentSource({ name: 'wrong-name' }));

    const manifest = manifestWith({
      agents: [
        { slug: 'first', source: 'agents/first.md', reportsTo: '$orchestrator' },
        { slug: 'second', source: 'agents/second.md', reportsTo: '$orchestrator' },
      ],
    });

    assert.throws(() => materialize.materializePlugin({
      pluginId: 'inv', packageRealPath: fs.realpathSync(pkgDir), manifest,
      assignedOrders: { first: 5, second: 6 }, orchestratorFrontmatterName: 'chief-of-staff',
    }), materialize.MaterializeError);

    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'agents', 'rundock-plugin-inv-first.md')),
      'the first agent, already written before the second failed, must be rolled back');
  });
});

describe('removeMaterializedProjections', () => {
  test('removes exactly the recorded agent and skill runtime slugs, nothing else', () => {
    const ws = useWorkspace();
    const agentsDir = path.join(ws, '.claude', 'agents');
    const skillsDir = path.join(ws, '.claude', 'skills');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'rundock-plugin-inv-review'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'unrelated-skill'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'rundock-plugin-inv-lead.md'), 'x');
    fs.writeFileSync(path.join(agentsDir, 'unrelated-agent.md'), 'x');
    fs.writeFileSync(path.join(skillsDir, 'rundock-plugin-inv-review', 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(skillsDir, 'unrelated-skill', 'SKILL.md'), 'x');

    materialize.removeMaterializedProjections(['rundock-plugin-inv-lead'], ['rundock-plugin-inv-review']);

    assert.ok(!fs.existsSync(path.join(agentsDir, 'rundock-plugin-inv-lead.md')));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'rundock-plugin-inv-review')));
    assert.ok(fs.existsSync(path.join(agentsDir, 'unrelated-agent.md')), 'must not touch an unrelated agent');
    assert.ok(fs.existsSync(path.join(skillsDir, 'unrelated-skill')), 'must not touch an unrelated skill');
  });

  test('is a no-op, not a throw, when nothing is recorded', () => {
    useWorkspace();
    assert.doesNotThrow(() => materialize.removeMaterializedProjections([], []));
    assert.doesNotThrow(() => materialize.removeMaterializedProjections(undefined, undefined));
  });
});

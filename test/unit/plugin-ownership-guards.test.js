'use strict';
// Ownership enforcement in the existing agent/skill/routine CRUD handlers
// (lib/protocol/handlers/team.js): a materialized plugin projection
// (rundockManaged: true in its frontmatter) must be read-only through every
// path that edits, recruits, deletes, or attaches a routine to an agent, and
// a workspace-authored agent/skill can never claim the reserved
// "rundock-plugin-" prefix in the first place. Calls the real handlers with
// the server's real wsHandlerContext (root-owned capabilities), bypassing
// only the WebSocket transport itself, so this exercises the actual guard
// code, not a re-implementation of it.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const team = require('../../lib/protocol/handlers/team.js');
const { makeWorkspace, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

const MANAGED_AGENT_CONTENT = `---
name: rundock-plugin-test-plugin-lead
displayName: Lead
role: Coordinator
type: specialist
order: 5
reportsTo: chief-of-staff
rundockPluginAgent: lead
rundockPlugin: test-plugin
rundockManaged: true
---

You are the lead.
`;

const MANAGED_SKILL_CONTENT = `---
name: Managed Skill
description: A plugin-owned skill.
---

Instructions.
`;

function useWorkspaceWithManagedAgent() {
  const team_ = standardTeam();
  team_['rundock-plugin-test-plugin-lead'] = MANAGED_AGENT_CONTENT;
  const dir = makeWorkspace({
    agents: team_,
    skills: { 'rundock-plugin-test-plugin-review': MANAGED_SKILL_CONTENT },
  });
  srv.setWorkspace(dir);
  srv.invalidateAgentCache();
  return dir;
}

describe('agent/skill creation and update refuse the reserved plugin prefix', () => {
  test('save_agent refuses a brand-new agent named under rundock-plugin-', () => {
    const dir = useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleSaveAgent(srv.wsHandlerContext, ws, {
      name: 'rundock-plugin-other-plugin-analyst',
      content: '---\nname: rundock-plugin-other-plugin-analyst\ntype: specialist\norder: 9\n---\n\nHi.',
    });
    assert.strictEqual(ws.sent[0].type, 'agent_error');
    assert.match(ws.sent[0].message, /reserved for plugin-materialized agents/);
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'rundock-plugin-other-plugin-analyst.md')));
  });

  test('save_agent refuses to overwrite an existing plugin-managed agent by name', () => {
    const dir = useWorkspaceWithManagedAgent();
    const before = fs.readFileSync(path.join(dir, '.claude', 'agents', 'rundock-plugin-test-plugin-lead.md'), 'utf-8');
    const ws = captureWs();
    team.handleSaveAgent(srv.wsHandlerContext, ws, {
      name: 'rundock-plugin-test-plugin-lead',
      content: '---\nname: rundock-plugin-test-plugin-lead\ntype: specialist\norder: 99\n---\n\nHijacked.',
    });
    assert.strictEqual(ws.sent[0].type, 'agent_error');
    assert.match(ws.sent[0].message, /reserved for plugin-materialized agents/);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'agents', 'rundock-plugin-test-plugin-lead.md'), 'utf-8'), before);
  });

  test('save_skill refuses a skill named under rundock-plugin-', () => {
    const dir = useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleSaveSkill(srv.wsHandlerContext, ws, {
      name: 'rundock-plugin-test-plugin-review',
      content: '---\nname: Hijacked\n---\n\nBody.',
    });
    assert.strictEqual(ws.sent[0].type, 'skill_error');
    assert.match(ws.sent[0].message, /reserved for plugin-materialized skills/);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, '.claude', 'skills', 'rundock-plugin-test-plugin-review', 'SKILL.md'), 'utf-8'),
      MANAGED_SKILL_CONTENT,
    );
  });

  test('delete_skill refuses a plugin-managed skill', () => {
    const dir = useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleDeleteSkill(srv.wsHandlerContext, ws, { name: 'rundock-plugin-test-plugin-review' });
    assert.strictEqual(ws.sent[0].type, 'skill_error');
    assert.match(ws.sent[0].message, /reserved for plugin-materialized skills/);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'rundock-plugin-test-plugin-review')));
  });
});

describe('agent CRUD and routine handlers refuse a plugin-managed agent', () => {
  test('delete_agent refuses', () => {
    const dir = useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleDeleteAgent(srv.wsHandlerContext, ws, { agentId: 'rundock-plugin-test-plugin-lead' });
    assert.strictEqual(ws.sent[0].type, 'agent_error');
    assert.match(ws.sent[0].message, /managed by the "test-plugin" plugin/);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'rundock-plugin-test-plugin-lead.md')));
  });

  test('add_to_team refuses (recruit)', () => {
    useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleAddToTeam(srv.wsHandlerContext, ws, { agentId: 'rundock-plugin-test-plugin-lead' });
    assert.strictEqual(ws.sent[0].type, 'agent_error');
    assert.match(ws.sent[0].message, /managed by the "test-plugin" plugin/);
  });

  test('save_routine refuses to attach a routine', () => {
    useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleSaveRoutine(srv.wsHandlerContext, ws, {
      agentId: 'rundock-plugin-test-plugin-lead',
      routine: { name: 'daily-check', schedule: { type: 'daily', time: '09:00' }, prompt: 'Check things.' },
    });
    assert.strictEqual(ws.sent[0].type, 'routine_error');
    assert.match(ws.sent[0].message, /managed by the "test-plugin" plugin/);
  });

  test('delete_routine refuses', () => {
    useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleDeleteRoutine(srv.wsHandlerContext, ws, { agentId: 'rundock-plugin-test-plugin-lead', name: 'x', occurrence: 0 });
    assert.strictEqual(ws.sent[0].type, 'routine_action_error');
    assert.match(ws.sent[0].message, /managed by the "test-plugin" plugin/);
  });

  test('set_routine_paused refuses', () => {
    useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleSetRoutinePaused(srv.wsHandlerContext, ws, { agentId: 'rundock-plugin-test-plugin-lead', name: 'x', occurrence: 0, paused: true });
    assert.strictEqual(ws.sent[0].type, 'routine_action_error');
    assert.match(ws.sent[0].message, /managed by the "test-plugin" plugin/);
  });
});

describe('ordinary (non-plugin) agents and skills are unaffected', () => {
  test('save_agent still works for a normal name', () => {
    const dir = useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleSaveAgent(srv.wsHandlerContext, ws, {
      name: 'ordinary-agent',
      content: '---\nname: ordinary-agent\ntype: specialist\norder: 20\n---\n\nHi.',
    });
    assert.strictEqual(ws.sent[0].type, 'agent_saved');
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'ordinary-agent.md')));
  });

  test('delete_agent still works for a normal agent', () => {
    useWorkspaceWithManagedAgent();
    const ws = captureWs();
    team.handleDeleteAgent(srv.wsHandlerContext, ws, { agentId: 'lead-designer' });
    assert.strictEqual(ws.sent[0].type, 'agent_deleted');
  });
});

'use strict';
// The Investment Partner Hub: the reference plugin demonstrating the
// completed framework (three agents in a two-level reportsTo chain, one
// skill, three resources, one route, the chat-side-panel slot). Nothing
// here is investment-specific in core: every check below exercises the
// same generic install/enable/materialize/bootstrap/serve path
// test/integration/plugin-reading-dashboard.test.js already proved works
// for an unrelated fixture.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const lifecycle = require('../../lib/plugins/lifecycle.js');
const storage = require('../../lib/plugins/storage.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'investment-dashboard');

let enableResult;
let client;

before(async () => {
  await h.boot();
  const install = lifecycle.installFromFolder(FIXTURE_DIR);
  assert.strictEqual(install.success, true, JSON.stringify(install.errors));
  enableResult = lifecycle.enablePlugin('investment-dashboard');
  assert.strictEqual(enableResult.success, true, JSON.stringify(enableResult.errors));
  client = await h.connect();
});
after(async () => h.shutdown());

function get(urlPath) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`).then(async res => ({
    status: res.status, body: await res.text(), headers: res.headers,
  }));
}

describe('investment-dashboard: install and enable', () => {
  test('materializes all three agents with a two-level reportsTo chain', () => {
    const agentsDir = path.join(h.workspaceDir, '.claude', 'agents');
    const leadPath = path.join(agentsDir, 'rundock-plugin-investment-dashboard-lead-partner.md');
    const analystPath = path.join(agentsDir, 'rundock-plugin-investment-dashboard-equity-analyst.md');
    const managerPath = path.join(agentsDir, 'rundock-plugin-investment-dashboard-risk-manager.md');
    assert.ok(fs.existsSync(leadPath));
    assert.ok(fs.existsSync(analystPath));
    assert.ok(fs.existsSync(managerPath));

    const leadContent = fs.readFileSync(leadPath, 'utf-8');
    assert.match(leadContent, /^reportsTo: chief-of-staff$/m, 'lead-partner reports to the actual orchestrator frontmatter name');
    assert.match(leadContent, /^skills: \[rundock-plugin-investment-dashboard-investment-review\]$/m);

    const analystContent = fs.readFileSync(analystPath, 'utf-8');
    assert.match(analystContent, /^reportsTo: rundock-plugin-investment-dashboard-lead-partner$/m,
      'equity-analyst reports to lead-partner\'s derived runtime slug, not the orchestrator');
    const managerContent = fs.readFileSync(managerPath, 'utf-8');
    assert.match(managerContent, /^reportsTo: rundock-plugin-investment-dashboard-lead-partner$/m,
      'risk-manager reports to lead-partner\'s derived runtime slug, not the orchestrator');

    const { discoverAgents } = require('../../lib/agents/discovery.js');
    const roster = discoverAgents();
    const lead = roster.find(a => a.name === 'rundock-plugin-investment-dashboard-lead-partner');
    assert.ok(lead, 'lead-partner must be visible to normal agent discovery immediately (no manual cache invalidation needed)');
    assert.strictEqual(lead.status, 'onTeam');
    assert.ok(lead.order < roster.find(a => a.name === 'rundock-plugin-investment-dashboard-equity-analyst').order,
      'the lead sits above its own children in org-chart order');
  });

  test('materializes the investment-review skill', () => {
    const skillPath = path.join(h.workspaceDir, '.claude', 'skills', 'rundock-plugin-investment-dashboard-investment-review', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath));
  });

  test('bootstraps all three resources from their templates', () => {
    const dataDir = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'investment-dashboard');
    const portfolio = JSON.parse(fs.readFileSync(path.join(dataDir, 'portfolio-state.json'), 'utf-8'));
    const risk = JSON.parse(fs.readFileSync(path.join(dataDir, 'risk-profile.json'), 'utf-8'));
    const journal = JSON.parse(fs.readFileSync(path.join(dataDir, 'decision-journal.json'), 'utf-8'));
    assert.strictEqual(portfolio.baseCurrency, 'USD');
    assert.deepStrictEqual(portfolio.accounts, []);
    assert.strictEqual(risk.constraints.maximumSinglePositionFraction, 0.15);
    assert.deepStrictEqual(journal.entries, []);
  });
});

describe('investment-dashboard: generic resource storage', () => {
  test('a proposed position round-trips through compare-and-swap', () => {
    const before1 = storage.readResource('investment-dashboard', 'portfolio-state');
    const next = {
      baseCurrency: 'USD',
      accounts: [{
        accountId: '00000000-0000-4000-8000-000000000001',
        name: 'Taxable Brokerage', type: 'taxable', currency: 'USD', cashBalance: 5000,
        positions: [{
          positionId: '00000000-0000-4000-8000-000000000002',
          ticker: 'MSFT', name: 'Microsoft Corporation', assetClass: 'us-equity', sector: 'technology', geography: 'united-states',
          quantity: 10, averageCostBasis: 300,
          currentPrice: { amount: 310, currency: 'USD', asOf: new Date().toISOString(), source: 'manual' },
          taxLotType: 'long-term',
        }],
      }],
    };
    const written = storage.replaceResource('investment-dashboard', 'portfolio-state', before1.etag, next);
    assert.ok(!written.error && !written.conflict, JSON.stringify(written));
    assert.strictEqual(written.document.accounts[0].positions[0].ticker, 'MSFT');
    assert.strictEqual(written.document.revision, 1);
  });

  test('a decision journal entry round-trips', () => {
    const before1 = storage.readResource('investment-dashboard', 'decision-journal');
    const written = storage.replaceResource('investment-dashboard', 'decision-journal', before1.etag, {
      entries: [{
        decisionId: '00000000-0000-4000-8000-000000000003',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ticker: 'MSFT', action: 'watch', status: 'proposed',
        thesis: 'Durable cloud/enterprise moat.', bearCase: 'Multiple compression on rate shocks.',
        invalidationMetrics: [{ name: 'Revenue growth', operator: 'below', threshold: 5, unit: 'percent' }],
        sourceConversationId: null,
      }],
    });
    assert.ok(!written.error && !written.conflict, JSON.stringify(written));
    assert.strictEqual(written.document.entries.length, 1);
  });
});

describe('investment-dashboard: approved asset serving', () => {
  test('serves the entry script and stylesheet, and the entry script declares no investment concepts outside the package', async () => {
    const hash = enableResult.plugin.hash;
    const script = await get(`/plugins/investment-dashboard/ui/index.js?h=${encodeURIComponent(hash)}`);
    assert.strictEqual(script.status, 200);
    assert.ok(script.body.includes("RundockPluginHost.register('investment-dashboard'"));
    assert.strictEqual(script.headers.get('content-type'), 'application/javascript');

    const style = await get(`/plugins/investment-dashboard/ui/investment.css?h=${encodeURIComponent(hash)}`);
    assert.strictEqual(style.status, 200);
    assert.ok(style.body.includes('data-plugin-id="investment-dashboard"'));
  });

  test('the manifest.json template and agent source files are never served over HTTP', async () => {
    const hash = enableResult.plugin.hash;
    for (const p of ['manifest.json', 'agents/lead-partner.md', 'templates/portfolio-state.json']) {
      const res = await get(`/plugins/investment-dashboard/${p}?h=${encodeURIComponent(hash)}`);
      assert.strictEqual(res.status, 404, `${p} must not be served`);
    }
  });
});

describe('investment-dashboard: sequential two-level delegation', () => {
  const LEAD = 'rundock-plugin-investment-dashboard-lead-partner';
  const ANALYST = 'rundock-plugin-investment-dashboard-equity-analyst';
  const RISK = 'rundock-plugin-investment-dashboard-risk-manager';

  test('Lead Partner delegates to Equity Analyst then Risk Manager in turn; each COMPLETE restores the Lead Partner, never the orchestrator', async () => {
    const convoId = h.freshConvoId('inv-seq');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'inv-seq-setup' }, turn: [{ text: 'Orchestrator ready.' }] },
      { match: { agent: LEAD, promptIncludes: 'inv-seq review the portfolio' },
        turn: [{ agentTool: { subagent_type: ANALYST, prompt: 'inv-seq equity brief' } }] },
      { match: { agent: ANALYST, promptIncludes: 'inv-seq equity brief' },
        turn: [{ text: 'EQUITY-VIEW-DELIVERED. <!-- RUNDOCK:COMPLETE -->' }] },
      // The resumed Lead Partner's silent pipeline-complete park for the
      // equity leg, then a live follow-up drives it into the risk leg.
      { match: { agent: LEAD, promptIncludes: ['[SYSTEM: pipeline-complete]', 'EQUITY-VIEW-DELIVERED'], promptExcludes: 'RUNDOCK:COMPLETE' },
        turn: [{ text: '<silent>' }] },
      { match: { agent: LEAD, promptIncludes: 'inv-seq now check the risk profile' },
        turn: [{ agentTool: { subagent_type: RISK, prompt: 'inv-seq risk brief' } }] },
      { match: { agent: RISK, promptIncludes: 'inv-seq risk brief' },
        turn: [{ text: 'RISK-VIEW-DELIVERED. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: LEAD, promptIncludes: ['[SYSTEM: pipeline-complete]', 'RISK-VIEW-DELIVERED'], promptExcludes: 'RUNDOCK:COMPLETE' },
        turn: [{ text: '<silent>' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'inv-seq-setup' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { label: 'orchestrator ready' });
    // The orchestrator's process is parked alive for the whole chain by
    // construction (a WS delegate only parks, it never kills) and is never
    // restored to the map, so it must be killed explicitly at teardown or
    // its real child process leaks past the test.
    const orchestratorEntry = h.internal.chatProcesses.get(convoId);

    // ---- Leg 1: Lead Partner -> Equity Analyst -> Lead Partner ----
    const since1 = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: LEAD, context: 'inv-seq review the portfolio' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === ANALYST, { since: since1, label: 'switch to equity analyst' });
    const { index: analystResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === ANALYST, { since: since1, label: 'equity analyst result' });

    const { msg: back1 } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === LEAD, { since: analystResultIdx, label: 'handback to lead after equity leg' });
    assert.strictEqual(back1.fromAgent, ANALYST, 'the equity leg hands back to the Lead Partner directly');
    const noOrchestrator1 = client.messages.slice(analystResultIdx).find(
      m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff');
    assert.ok(!noOrchestrator1, 'the orchestrator is not surfaced after the equity leg');

    const { index: leadRestart1Idx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === LEAD && m.autoContinue, { since: analystResultIdx, label: 'lead restart after equity leg' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === LEAD, { since: leadRestart1Idx + 1, label: 'resumed lead result after equity leg' });

    let entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, LEAD, 'the Lead Partner, not the orchestrator, is live after the equity leg');
    assert.strictEqual(entry.idle, true);

    // ---- Leg 2: Lead Partner -> Risk Manager -> Lead Partner ----
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: LEAD, content: 'inv-seq now check the risk profile' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === RISK, { since: since2, label: 'switch to risk manager' });
    const { index: riskResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === RISK, { since: since2, label: 'risk manager result' });

    const { msg: back2 } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === LEAD, { since: riskResultIdx, label: 'handback to lead after risk leg' });
    assert.strictEqual(back2.fromAgent, RISK, 'the risk leg also hands back to the Lead Partner directly');
    const noOrchestrator2 = client.messages.slice(riskResultIdx).find(
      m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff');
    assert.ok(!noOrchestrator2, 'the orchestrator is not surfaced after the risk leg either');

    const { index: leadRestart2Idx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === LEAD && m.autoContinue, { since: riskResultIdx, label: 'lead restart after risk leg' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === LEAD, { since: leadRestart2Idx + 1, label: 'resumed lead result after risk leg' });

    entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, LEAD, 'the Lead Partner is live again after the risk leg');
    assert.strictEqual(entry.idle, true);

    h.reapConvo(convoId);
    try { orchestratorEntry.process.kill('SIGKILL'); } catch (e) {}
  });
});

describe('investment-dashboard: disable and uninstall', () => {
  test('disable removes all three materialized agents and the skill, preserves package and data', () => {
    const agentsDir = path.join(h.workspaceDir, '.claude', 'agents');
    const dataDir = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'investment-dashboard');
    const packageDir = path.join(h.workspaceDir, '.rundock', 'plugins', 'investment-dashboard');

    const disable = lifecycle.disablePlugin('investment-dashboard');
    assert.strictEqual(disable.success, true);
    assert.ok(!fs.existsSync(path.join(agentsDir, 'rundock-plugin-investment-dashboard-lead-partner.md')));
    assert.ok(!fs.existsSync(path.join(agentsDir, 'rundock-plugin-investment-dashboard-equity-analyst.md')));
    assert.ok(!fs.existsSync(path.join(agentsDir, 'rundock-plugin-investment-dashboard-risk-manager.md')));
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, '.claude', 'skills', 'rundock-plugin-investment-dashboard-investment-review')));
    assert.ok(fs.existsSync(dataDir), 'plugin data must survive a disable');
    assert.ok(fs.existsSync(packageDir), 'the installed package must survive a disable');
  });

  test('uninstall removes the package but preserves data by default', () => {
    const dataDir = path.join(h.workspaceDir, '.rundock', 'plugin-data', 'investment-dashboard');
    const packageDir = path.join(h.workspaceDir, '.rundock', 'plugins', 'investment-dashboard');
    const uninstall = lifecycle.uninstallPlugin('investment-dashboard');
    assert.strictEqual(uninstall.success, true);
    assert.ok(!fs.existsSync(packageDir));
    assert.ok(fs.existsSync(dataDir));
  });
});

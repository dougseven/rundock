'use strict';
// Plugin lifecycle: install, enable, disable, update, uninstall, and the
// workspace-open reconcile operation. See the plugin framework spec's
// "Plugin lifecycle" section for the exact step order this follows.
//
// PHASE BOUNDARY: agent/skill materialization (lib/plugins/materialize.js,
// Phase 2) and resource bootstrap (lib/plugins/storage.js, Phase 3) do not
// exist yet. enablePlugin() below still performs every OTHER step of the
// spec's enable transaction (revalidate, resolve orchestrator, conflict
// check, order assignment, mark enabled, invalidate cache) and reserves the
// exact call sites for materialization and bootstrap, but refuses to enable
// a package that actually declares agents, skills, or resources until those
// modules land — see materializeAgentsAndSkills/bootstrapResources below.
// This keeps the transaction's shape correct now instead of requiring a
// Phase 2 rewrite of this file's control flow.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');
const { discoverAgents } = require('../agents/discovery.js');
const manifestLib = require('./manifest.js');
const discovery = require('./discovery.js');
const ownership = require('./ownership.js');

class PluginPhaseError extends Error {}

function fail(message, extra) { return { success: false, errors: [{ message }], ...extra }; }

function resolveOrchestrator() {
  const agents = discoverAgents();
  const orchestrators = agents.filter(a => a.type === 'orchestrator');
  if (orchestrators.length !== 1) {
    return {
      orchestrator: null,
      error: `Rundock needs exactly one workspace orchestrator to attach plugin agents to; found ${orchestrators.length}.`,
    };
  }
  return { orchestrator: orchestrators[0], error: null };
}

// Blocks enablement if a plugin's derived runtime agent/skill slug already
// exists on disk, whether or not it currently parses as a valid agent/skill
// (a malformed or otherwise-undiscovered file still claims the name).
function runtimeSlugConflicts(manifest) {
  const ws = getWorkspace();
  const conflicts = [];
  for (const a of (manifest.agents || [])) {
    const slug = manifestLib.deriveRuntimeSlug(manifest.id, a.slug);
    if (fs.existsSync(path.join(ws, '.claude', 'agents', `${slug}.md`))) {
      conflicts.push({ type: 'agent', slug, message: `Agent runtime slug "${slug}" already exists.` });
    }
  }
  for (const s of (manifest.skills || [])) {
    const slug = manifestLib.deriveRuntimeSlug(manifest.id, s.slug);
    if (fs.existsSync(path.join(ws, '.claude', 'skills', slug))) {
      conflicts.push({ type: 'skill', slug, message: `Skill runtime slug "${slug}" already exists.` });
    }
  }
  return conflicts;
}

// Stable org-chart order values: plugin agents reporting to $orchestrator
// (roots) take the next whole numbers after the workspace's current maximum
// order; each root's plugin-local children take fractional suffixes in
// declaration order, matching the spec's example
// (lead-partner: 5, equity-analyst: 5.1, risk-manager: 5.2).
function assignOrders(manifest, existingAgents) {
  const agents = manifest.agents || [];
  if (agents.length === 0) return {};

  const maxOrder = existingAgents.reduce((m, a) => (typeof a.order === 'number' && a.order > m ? a.order : m), 0);
  const baseOrder = Math.floor(maxOrder) + 1;

  const bySlug = new Map(agents.map(a => [a.slug, a]));
  const childrenOf = new Map();
  const roots = [];
  for (const a of agents) {
    if (a.reportsTo === '$orchestrator' || !bySlug.has(a.reportsTo)) {
      roots.push(a.slug);
    } else {
      if (!childrenOf.has(a.reportsTo)) childrenOf.set(a.reportsTo, []);
      childrenOf.get(a.reportsTo).push(a.slug);
    }
  }

  const assigned = {};
  roots.forEach((rootSlug, rootIndex) => {
    const rootOrder = baseOrder + rootIndex;
    assigned[rootSlug] = rootOrder;
    (childrenOf.get(rootSlug) || []).forEach((slug, i) => {
      assigned[slug] = Number((rootOrder + (i + 1) / 10).toFixed(2));
    });
  });
  return assigned;
}

// See the PHASE BOUNDARY note at the top of this file.
function materializeAgentsAndSkills(manifest) {
  if ((manifest.agents && manifest.agents.length) || (manifest.skills && manifest.skills.length)) {
    throw new PluginPhaseError(
      'This plugin declares agents or skills. Materializing them into .claude/ lands in Phase 2 (lib/plugins/materialize.js) and is not implemented yet.');
  }
  return { materializedAgents: [], materializedSkills: [] };
}

// See the PHASE BOUNDARY note at the top of this file.
function bootstrapResources(manifest) {
  if (manifest.resources && manifest.resources.length) {
    throw new PluginPhaseError(
      'This plugin declares data resources. Bootstrapping them lands in Phase 3 (lib/plugins/storage.js) and is not implemented yet.');
  }
}

function requireRealDirectory(sourceDir) {
  let lstat;
  try { lstat = fs.lstatSync(sourceDir); } catch (e) { return { error: `Source folder not found: ${e.message}` }; }
  if (lstat.isSymbolicLink()) return { error: 'Source folder must not be a symbolic link.' };
  if (!lstat.isDirectory()) return { error: 'Source path must be a directory.' };
  let realDir;
  try { realDir = fs.realpathSync(sourceDir); } catch (e) { return { error: `Could not resolve source folder: ${e.message}` }; }
  return { realDir };
}

// Stages a candidate package (installed source, or an update source),
// revalidates and re-hashes the staged copy so nothing enters
// .rundock/plugins/ that was not itself validated after copying, and
// returns the staged directory for the caller to rename into place. On any
// failure the staging directory is removed here, before returning, so a
// caller never needs to clean up an errored stagePackage() call itself.
function stagePackage(realSourceDir, pluginsRoot, expectedHash) {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const stagingDir = path.join(pluginsRoot, `.staging-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.cpSync(realSourceDir, stagingDir, { recursive: true });
    // Real-resolve the staged copy before validating/hashing it: pluginsRoot
    // (under the workspace root) may itself sit behind a symlinked ancestor
    // (e.g. macOS's /tmp -> /private/tmp), and manifest path-safety checks
    // require an already-resolved base path to compare against.
    const stagingRealDir = fs.realpathSync(stagingDir);
    const staged = manifestLib.loadAndValidateManifest(stagingRealDir);
    if (staged.errors.length > 0) {
      removeIfExists(stagingDir);
      return { errors: staged.errors, warnings: staged.warnings };
    }
    const stagedHash = discovery.computePackageHash(stagingRealDir);
    if (stagedHash !== expectedHash) {
      removeIfExists(stagingDir);
      return { errors: [{ message: 'Package changed while it was being staged. Try again.' }] };
    }
    return { stagingDir, manifest: staged.manifest, warnings: staged.warnings };
  } catch (e) {
    removeIfExists(stagingDir);
    return { errors: [{ message: `Staging failed: ${e.message}` }] };
  }
}

function removeIfExists(dir) {
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function installFromFolder(sourceDir) {
  const ws = getWorkspace();
  if (!ws) return fail('No workspace selected.');
  if (typeof sourceDir !== 'string' || !sourceDir) return fail('No source folder given.');

  const { realDir: realSourceDir, error: dirError } = requireRealDirectory(sourceDir);
  if (dirError) return fail(dirError);

  const { manifest, errors, warnings } = manifestLib.loadAndValidateManifest(realSourceDir);
  if (errors.length > 0) return { success: false, errors, warnings };

  let hash;
  try { hash = discovery.computePackageHash(realSourceDir); } catch (e) { return fail(e.message); }

  const pluginsRoot = discovery.pluginsDir();
  const destDir = path.join(pluginsRoot, manifest.id);
  if (fs.existsSync(destDir)) {
    return fail(`Plugin "${manifest.id}" is already installed. Use Update instead.`);
  }

  const staged = stagePackage(realSourceDir, pluginsRoot, hash);
  if (staged.errors) return { success: false, errors: staged.errors, warnings: staged.warnings };

  try {
    fs.renameSync(staged.stagingDir, destDir);
  } catch (e) {
    removeIfExists(staged.stagingDir);
    return fail(`Install failed: ${e.message}`);
  }

  const state = ownership.readPluginState();
  state.plugins[manifest.id] = {
    enabled: false,
    approvedHash: null,
    installedVersion: manifest.version,
    assignedOrders: {},
    materializedAgents: [],
    materializedSkills: [],
  };
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();

  return { success: true, errors: [], warnings: staged.warnings, plugin: { id: manifest.id, version: manifest.version, hash } };
}

function enablePlugin(id) {
  const ws = getWorkspace();
  if (!ws) return fail('No workspace selected.');

  const packageDir = path.join(discovery.pluginsDir(), id);
  if (!fs.existsSync(packageDir)) return fail(`Plugin "${id}" is not installed.`);

  // lstat, not a realpath string comparison: an ancestor of the workspace
  // being a symlink (e.g. macOS's /tmp) is benign; only packageDir itself
  // matters here. See the identical comment in discovery.js's scanPlugins.
  let packageLstat;
  try { packageLstat = fs.lstatSync(packageDir); } catch (e) { return fail(`Could not resolve plugin package: ${e.message}`); }
  if (packageLstat.isSymbolicLink()) return fail('Plugin package directory must not be a symbolic link.');
  let realPackageDir;
  try { realPackageDir = fs.realpathSync(packageDir); } catch (e) { return fail(`Could not resolve plugin package: ${e.message}`); }

  const { manifest, errors, warnings } = manifestLib.loadAndValidateManifest(realPackageDir, id);
  if (errors.length > 0) return { success: false, errors, warnings };

  let hash;
  try { hash = discovery.computePackageHash(realPackageDir); } catch (e) { return fail(`Could not hash plugin package: ${e.message}`); }

  const { orchestrator, error: orchestratorError } = resolveOrchestrator();
  if (orchestratorError) return fail(orchestratorError);

  const conflicts = runtimeSlugConflicts(manifest);
  if (conflicts.length > 0) return { success: false, errors: conflicts.map(c => ({ message: c.message })) };

  const existingAgents = discoverAgents();
  const assignedOrders = assignOrders(manifest, existingAgents);

  let materialized;
  try {
    materialized = materializeAgentsAndSkills(manifest);
    bootstrapResources(manifest);
  } catch (e) {
    if (e instanceof PluginPhaseError) return fail(e.message);
    throw e;
  }

  const state = ownership.readPluginState();
  state.plugins[id] = {
    enabled: true,
    approvedHash: hash,
    installedVersion: manifest.version,
    assignedOrders,
    materializedAgents: materialized.materializedAgents,
    materializedSkills: materialized.materializedSkills,
  };
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();

  return { success: true, errors: [], warnings, plugin: { id, version: manifest.version, hash, orchestrator: orchestrator.name } };
}

function disablePlugin(id) {
  const state = ownership.readPluginState();
  const record = state.plugins[id];
  if (!record) return fail(`Plugin "${id}" is not installed.`);
  if (!record.enabled) return { success: true, errors: [] };

  // PHASE BOUNDARY: removing only this plugin's owned .claude/ projections
  // lands in Phase 2 alongside materialize.js. Nothing is materialized yet,
  // so there is nothing to remove today.
  record.enabled = false;
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();
  return { success: true, errors: [] };
}

function updateFromFolder(id, sourceDir) {
  const ws = getWorkspace();
  if (!ws) return fail('No workspace selected.');

  const state = ownership.readPluginState();
  if (!state.plugins[id]) return fail(`Plugin "${id}" is not installed.`);

  const { realDir: realSourceDir, error: dirError } = requireRealDirectory(sourceDir);
  if (dirError) return fail(dirError);

  const { manifest, errors, warnings } = manifestLib.loadAndValidateManifest(realSourceDir);
  if (errors.length > 0) return { success: false, errors, warnings };
  if (manifest.id !== id) {
    return fail(`Update package id "${manifest.id}" does not match the installed plugin "${id}".`);
  }

  let hash;
  try { hash = discovery.computePackageHash(realSourceDir); } catch (e) { return fail(e.message); }

  const pluginsRoot = discovery.pluginsDir();
  const destDir = path.join(pluginsRoot, id);
  const staged = stagePackage(realSourceDir, pluginsRoot, hash);
  if (staged.errors) return { success: false, errors: staged.errors, warnings: staged.warnings };

  const backupDir = path.join(pluginsRoot, `.backup-${id}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.renameSync(destDir, backupDir);
    try {
      fs.renameSync(staged.stagingDir, destDir);
    } catch (e) {
      fs.renameSync(backupDir, destDir);
      throw e;
    }
    removeIfExists(backupDir);
  } catch (e) {
    removeIfExists(staged.stagingDir);
    return fail(`Update failed: ${e.message}`);
  }

  // New hash revokes prior UI approval: the plugin stays disabled until
  // re-approved, but its existing plugin-data and prior projections are
  // left untouched here (materialize.js owns replacing projections, once
  // enable runs again, in Phase 2).
  const record = state.plugins[id];
  record.enabled = false;
  record.approvedHash = null;
  record.installedVersion = manifest.version;
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();

  return { success: true, errors: [], warnings: staged.warnings, plugin: { id, version: manifest.version, hash } };
}

function uninstallPlugin(id, opts = {}) {
  const ws = getWorkspace();
  if (!ws) return fail('No workspace selected.');

  const state = ownership.readPluginState();
  if (!state.plugins[id]) return fail(`Plugin "${id}" is not installed.`);

  // PHASE BOUNDARY: once materialize.js exists (Phase 2), disable's
  // projection removal must run here before the package itself is deleted,
  // with an ownership check that refuses to delete a file not recorded as
  // this plugin's own projection.
  const disableResult = disablePlugin(id);
  if (!disableResult.success) return disableResult;

  const packageDir = path.join(discovery.pluginsDir(), id);
  try {
    if (fs.existsSync(packageDir)) fs.rmSync(packageDir, { recursive: true, force: true });
  } catch (e) {
    return fail(`Could not remove plugin package: ${e.message}`);
  }

  const freshState = ownership.readPluginState();
  delete freshState.plugins[id];
  ownership.writePluginState(freshState);

  if (opts.deleteData) {
    const dataDir = path.join(ws, '.rundock', 'plugin-data', id);
    try {
      if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (e) {
      return fail(`Could not remove plugin data: ${e.message}`);
    }
  }

  discovery.invalidatePluginDiscoveryCache();
  return { success: true, errors: [] };
}

// Called on workspace open, after scaffold and before final agent discovery
// (see lib/protocol/handlers/workspace.js). Verifies every enabled plugin's
// approved hash still matches its package on disk; a mismatch means the
// package changed outside Rundock, so it is disabled pending re-approval.
//
// PHASE BOUNDARY: removing that plugin's stale .claude/ projections and
// re-materializing/re-bootstrapping already-enabled packages both land once
// materialize.js (Phase 2) and storage.js (Phase 3) exist.
function reconcile() {
  const ws = getWorkspace();
  if (!ws) return;

  discovery.invalidatePluginDiscoveryCache();
  const plugins = discovery.discoverPlugins({ force: true });
  const state = ownership.readPluginState();
  let changed = false;

  for (const p of plugins) {
    const record = state.plugins[p.id];
    if (record && record.enabled && p.status === 'approval_required') {
      record.enabled = false;
      changed = true;
      console.log(`  [Plugins] "${p.id}" package changed outside Rundock; disabled pending re-approval.`);
    }
  }

  if (changed) {
    ownership.writePluginState(state);
    discovery.invalidatePluginDiscoveryCache();
  }
}

module.exports = {
  PluginPhaseError,
  installFromFolder, enablePlugin, disablePlugin, updateFromFolder, uninstallPlugin, reconcile,
  // Exported for unit testing pure helpers directly.
  resolveOrchestrator, runtimeSlugConflicts, assignOrders,
};

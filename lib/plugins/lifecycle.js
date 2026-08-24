'use strict';
// Plugin lifecycle: install, enable, disable, update, uninstall, and the
// workspace-open reconcile operation. See the plugin framework spec's
// "Plugin lifecycle" section for the exact step order this follows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');
const { discoverAgents, invalidateAgentCache } = require('../agents/discovery.js');
const manifestLib = require('./manifest.js');
const discovery = require('./discovery.js');
const ownership = require('./ownership.js');
const materialize = require('./materialize.js');
const storage = require('./storage.js');

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

// Delegates to materialize.js, translating its MaterializeError (a content
// problem the manifest itself could not catch, such as a source frontmatter
// name mismatch or an undeclared skill reference) into the same
// PluginPhaseError shape enablePlugin already knows how to turn into a
// clean failure result.
function materializeAgentsAndSkills(manifest, packageRealPath, pluginId, assignedOrders, orchestratorFrontmatterName) {
  try {
    return materialize.materializePlugin({
      pluginId, packageRealPath, manifest, assignedOrders, orchestratorFrontmatterName,
    });
  } catch (e) {
    if (e instanceof materialize.MaterializeError) throw new PluginPhaseError(e.message);
    throw e;
  }
}

// Delegates to storage.js, translating its StorageError (a bad template, or
// a bootstrapped document that already exceeds its own byte limit) into the
// same PluginPhaseError shape enablePlugin already knows how to turn into a
// clean failure result.
function bootstrapResources(manifest, packageRealPath, pluginId) {
  try {
    storage.bootstrapResources(pluginId, manifest, packageRealPath);
  } catch (e) {
    if (e instanceof storage.StorageError) throw new PluginPhaseError(e.message);
    throw e;
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
    materialized = materializeAgentsAndSkills(manifest, realPackageDir, id, assignedOrders, orchestrator.name);
    bootstrapResources(manifest, realPackageDir, id);
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
  // Materialization just wrote new files into .claude/agents/ (and
  // possibly .claude/skills/): the 2-second agent-roster cache must not be
  // allowed to keep answering with the pre-enable roster for however long
  // is left on its TTL.
  invalidateAgentCache();

  return { success: true, errors: [], warnings, plugin: { id, version: manifest.version, hash, orchestrator: orchestrator.name } };
}

function disablePlugin(id) {
  const state = ownership.readPluginState();
  const record = state.plugins[id];
  if (!record) return fail(`Plugin "${id}" is not installed.`);
  if (!record.enabled) return { success: true, errors: [] };

  // Remove only what THIS plugin's own recorded projections name, never a
  // prefix scan or a directory listing, so a disable can never reach a file
  // that is not actually this plugin's. Cleared from state too, so a
  // disabled record accurately says nothing is currently materialized;
  // the next enable recomputes both from scratch.
  materialize.removeMaterializedProjections(record.materializedAgents, record.materializedSkills);
  record.enabled = false;
  record.materializedAgents = [];
  record.materializedSkills = [];
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();
  invalidateAgentCache();
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
  // re-approved. "Disabled" means no projections are materialized (the same
  // invariant disablePlugin maintains), so the OLD version's projections are
  // removed here too, because the updated package may not even declare the
  // same agents or skills, and re-enabling always re-materializes from scratch.
  // Plugin data is untouched: only .claude/ projections are ever removed here.
  const record = state.plugins[id];
  materialize.removeMaterializedProjections(record.materializedAgents, record.materializedSkills);
  record.enabled = false;
  record.approvedHash = null;
  record.materializedAgents = [];
  record.materializedSkills = [];
  record.installedVersion = manifest.version;
  ownership.writePluginState(state);
  discovery.invalidatePluginDiscoveryCache();
  invalidateAgentCache();

  return { success: true, errors: [], warnings: staged.warnings, plugin: { id, version: manifest.version, hash } };
}

function uninstallPlugin(id, opts = {}) {
  const ws = getWorkspace();
  if (!ws) return fail('No workspace selected.');

  const state = ownership.readPluginState();
  if (!state.plugins[id]) return fail(`Plugin "${id}" is not installed.`);

  // disablePlugin() removes this plugin's own projections (by exact
  // recorded runtime slug, never a directory scan) before the package
  // itself is deleted below.
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
// A stale-hash plugin's stale projections are removed the same way a normal
// disable removes them (by exact recorded runtime slug). Re-bootstrapping an
// already-enabled package's resources on every workspace open needs
// lib/plugins/storage.js, which does not exist yet.
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
      materialize.removeMaterializedProjections(record.materializedAgents, record.materializedSkills);
      record.enabled = false;
      record.materializedAgents = [];
      record.materializedSkills = [];
      changed = true;
      console.log(`  [Plugins] "${p.id}" package changed outside Rundock; disabled pending re-approval.`);
    }
  }

  if (changed) {
    ownership.writePluginState(state);
    discovery.invalidatePluginDiscoveryCache();
    invalidateAgentCache();
  }
}

module.exports = {
  PluginPhaseError,
  installFromFolder, enablePlugin, disablePlugin, updateFromFolder, uninstallPlugin, reconcile,
  // Exported for unit testing pure helpers directly.
  resolveOrchestrator, runtimeSlugConflicts, assignOrders,
};

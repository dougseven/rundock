'use strict';
// Plugin manifest schema (version 1) validation. Explicit object/field checks
// rather than a JSON Schema library, per the plugin framework spec: version 1
// deliberately adds no production dependency for this.
//
// validateManifest() takes an already-parsed manifest object plus the
// package's REAL (symlink-resolved) directory, because several rules need
// the filesystem: every package-relative path must stay inside the package,
// resolve to a real file, and never pass through a symbolic link.
//
// `dirName` is the package directory's own name, used only for the
// "id must match its package directory name" rule. It is optional: install
// and update validate a manifest before any destination directory exists
// (the eventual directory is named after the manifest's own id), so those
// callers omit it and the check is skipped. Only discovery, which validates
// packages already living at `.rundock/plugins/<id>/`, passes the real id.
const fs = require('fs');
const path = require('path');
const { parseAgentFrontmatter, readNormalisedFile } = require('../agents/discovery.js');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RESOURCE_FILE_RE = /^[^/\\]+\.json$/;
const SUPPORTED_SCHEMA_VERSION = 1;

// Reserved for materialized runtime agent/skill slugs
// (`rundock-plugin-<plugin-id>-<local-slug>`). User-authored agents, skills,
// and plugin manifests may not claim it: see deriveRuntimeSlug below, and
// the equivalent guard that belongs in agent/skill CRUD handlers (Phase 2).
const RESERVED_AGENT_PREFIX = 'rundock-plugin-';

const KNOWN_SLOT_TARGETS = new Set(['chat-side-panel']);

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'id', 'name', 'version', 'description', 'author',
  'rundock', 'ui', 'routes', 'slots', 'agents', 'skills', 'resources',
]);
const RUNDOCK_FIELDS = new Set(['minimumVersion']);
const UI_FIELDS = new Set(['entry', 'styles']);
const ROUTE_FIELDS = new Set(['id', 'path', 'label', 'icon', 'view']);
const SLOT_FIELDS = new Set(['target', 'view']);
const AGENT_FIELDS = new Set(['slug', 'source', 'reportsTo']);
const SKILL_FIELDS = new Set(['slug', 'source']);
const RESOURCE_FIELDS = new Set(['id', 'file', 'template', 'maximumBytes']);

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deriveRuntimeSlug(pluginId, localSlug) {
  return `${RESERVED_AGENT_PREFIX}${pluginId}-${localSlug}`;
}

// Resolves a package-relative path against the package's real directory and
// verifies every safety rule in one place: forward slashes only, no leading
// slash, no ".." segments, must exist, must stay inside the package, must
// not be reached through a symbolic link anywhere in its chain, and must be
// a regular file. Comparing fs.realpathSync(abs) to the lexically-joined abs
// path catches a symlink at any position (the file itself or an ancestor
// directory) in one check, because resolving any link changes the result.
function resolveSafePackagePath(packageRealPath, relPath) {
  if (typeof relPath !== 'string' || !relPath) return { ok: false, reason: 'must be a non-empty string' };
  if (relPath.includes('\\')) return { ok: false, reason: 'must use forward slashes' };
  if (path.posix.isAbsolute(relPath)) return { ok: false, reason: 'must be a package-relative path, not absolute' };
  const segments = relPath.split('/');
  if (segments.some(s => s === '..' || s === '')) return { ok: false, reason: 'must not contain ".." or empty segments' };

  const abs = path.join(packageRealPath, ...segments);
  let real;
  try { real = fs.realpathSync(abs); } catch (e) { return { ok: false, reason: 'does not exist' }; }
  if (real !== abs) return { ok: false, reason: 'must not resolve through a symbolic link' };
  if (real !== packageRealPath && !real.startsWith(packageRealPath + path.sep)) {
    return { ok: false, reason: 'must remain inside the package directory' };
  }
  let stat;
  try { stat = fs.lstatSync(abs); } catch (e) { return { ok: false, reason: 'does not exist' }; }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'must not be a symbolic link' };
  if (!stat.isFile()) return { ok: false, reason: 'must be a regular file' };
  return { ok: true, absPath: abs };
}

function pushError(errors, field, message) { errors.push({ field, message }); }
function pushWarning(warnings, field, message) { warnings.push({ field, message }); }

function unknownFieldErrors(obj, allowed, prefix, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) pushError(errors, prefix, `Unknown field "${key}" in ${prefix}.`);
  }
}

function validateManifest(manifest, packageRealPath, dirName) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(manifest)) {
    pushError(errors, null, 'manifest.json must contain a JSON object.');
    return { errors, warnings };
  }

  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_FIELDS.has(key)) pushWarning(warnings, key, `Unknown top-level field "${key}".`);
  }

  if (manifest.schemaVersion === undefined) {
    pushError(errors, 'schemaVersion', 'schemaVersion is required.');
  } else if (manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    pushError(errors, 'schemaVersion',
      `Unsupported schema version ${manifest.schemaVersion}. This version of Rundock supports schemaVersion ${SUPPORTED_SCHEMA_VERSION}. Update Rundock, or install a plugin package built for it.`);
  } else if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    pushError(errors, 'schemaVersion', `schemaVersion must equal ${SUPPORTED_SCHEMA_VERSION}.`);
  }

  if (typeof manifest.id !== 'string' || !SLUG_RE.test(manifest.id)) {
    pushError(errors, 'id', `id must match ${SLUG_RE}.`);
  } else if (dirName !== undefined && manifest.id !== dirName) {
    pushError(errors, 'id', `id "${manifest.id}" must match its package directory name "${dirName}".`);
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    pushError(errors, 'name', 'name is required.');
  }

  if (manifest.version === undefined) {
    pushError(errors, 'version', 'version is required.');
  } else if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    pushError(errors, 'version', 'version must be a semantic version in major.minor.patch form.');
  }

  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    pushError(errors, 'description', 'description must be a string.');
  }
  if (manifest.author !== undefined && typeof manifest.author !== 'string') {
    pushError(errors, 'author', 'author must be a string.');
  }

  if (manifest.rundock === undefined) {
    pushError(errors, 'rundock', 'rundock.minimumVersion is required.');
  } else if (!isPlainObject(manifest.rundock)) {
    pushError(errors, 'rundock', 'rundock must be an object.');
  } else {
    unknownFieldErrors(manifest.rundock, RUNDOCK_FIELDS, 'rundock', errors);
    if (manifest.rundock.minimumVersion === undefined) {
      pushError(errors, 'rundock.minimumVersion', 'rundock.minimumVersion is required.');
    } else if (typeof manifest.rundock.minimumVersion !== 'string' || !SEMVER_RE.test(manifest.rundock.minimumVersion)) {
      pushError(errors, 'rundock.minimumVersion', 'rundock.minimumVersion must be a semantic version in major.minor.patch form.');
    }
  }

  if (manifest.ui !== undefined) {
    if (!isPlainObject(manifest.ui)) {
      pushError(errors, 'ui', 'ui must be an object.');
    } else {
      unknownFieldErrors(manifest.ui, UI_FIELDS, 'ui', errors);
      if (manifest.ui.entry !== undefined) {
        if (typeof manifest.ui.entry !== 'string' || !manifest.ui.entry.endsWith('.js')) {
          pushError(errors, 'ui.entry', 'ui.entry must end in .js.');
        } else {
          const res = resolveSafePackagePath(packageRealPath, manifest.ui.entry);
          if (!res.ok) pushError(errors, 'ui.entry', `ui.entry "${manifest.ui.entry}" ${res.reason}.`);
        }
      }
      if (manifest.ui.styles !== undefined) {
        if (!Array.isArray(manifest.ui.styles)) {
          pushError(errors, 'ui.styles', 'ui.styles must be an array.');
        } else {
          manifest.ui.styles.forEach((s, i) => {
            if (typeof s !== 'string' || !s.endsWith('.css')) {
              pushError(errors, `ui.styles[${i}]`, 'each ui.styles entry must end in .css.');
            } else {
              const res = resolveSafePackagePath(packageRealPath, s);
              if (!res.ok) pushError(errors, `ui.styles[${i}]`, `ui.styles "${s}" ${res.reason}.`);
            }
          });
        }
      }
    }
  }

  const routeIds = new Set();
  if (manifest.routes !== undefined) {
    if (!Array.isArray(manifest.routes)) {
      pushError(errors, 'routes', 'routes must be an array.');
    } else {
      manifest.routes.forEach((r, i) => {
        if (!isPlainObject(r)) { pushError(errors, `routes[${i}]`, 'each route must be an object.'); return; }
        unknownFieldErrors(r, ROUTE_FIELDS, `routes[${i}]`, errors);
        if (typeof r.id !== 'string' || !SLUG_RE.test(r.id)) {
          pushError(errors, `routes[${i}].id`, `route id must match ${SLUG_RE}.`);
        } else if (routeIds.has(r.id)) {
          pushError(errors, `routes[${i}].id`, `duplicate route id "${r.id}".`);
        } else {
          routeIds.add(r.id);
        }
        if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
          pushError(errors, `routes[${i}].path`, 'route path must be a string starting with "/".');
        }
        if (typeof r.label !== 'string' || !r.label.trim()) {
          pushError(errors, `routes[${i}].label`, 'route label is required.');
        }
        if (r.icon !== undefined && typeof r.icon !== 'string') {
          pushError(errors, `routes[${i}].icon`, 'route icon must be a string.');
        }
        if (typeof r.view !== 'string' || !SLUG_RE.test(r.view)) {
          pushError(errors, `routes[${i}].view`, `route view must match ${SLUG_RE}.`);
        }
      });
    }
  }

  const slotTargets = new Set();
  if (manifest.slots !== undefined) {
    if (!Array.isArray(manifest.slots)) {
      pushError(errors, 'slots', 'slots must be an array.');
    } else {
      manifest.slots.forEach((s, i) => {
        if (!isPlainObject(s)) { pushError(errors, `slots[${i}]`, 'each slot must be an object.'); return; }
        unknownFieldErrors(s, SLOT_FIELDS, `slots[${i}]`, errors);
        if (typeof s.target !== 'string' || !KNOWN_SLOT_TARGETS.has(s.target)) {
          pushError(errors, `slots[${i}].target`, `unknown slot target "${s.target}". Version 1 defines: ${[...KNOWN_SLOT_TARGETS].join(', ')}.`);
        } else if (slotTargets.has(s.target)) {
          pushError(errors, `slots[${i}].target`, `duplicate slot target "${s.target}".`);
        } else {
          slotTargets.add(s.target);
        }
        if (typeof s.view !== 'string' || !SLUG_RE.test(s.view)) {
          pushError(errors, `slots[${i}].view`, `slot view must match ${SLUG_RE}.`);
        }
      });
    }
  }

  const agentSlugs = new Set();
  const declaredAgentSlugs = new Set();
  if (Array.isArray(manifest.agents)) {
    manifest.agents.forEach(a => {
      if (isPlainObject(a) && typeof a.slug === 'string') declaredAgentSlugs.add(a.slug);
    });
  }

  const sourcePaths = new Set();

  if (manifest.agents !== undefined) {
    if (!Array.isArray(manifest.agents)) {
      pushError(errors, 'agents', 'agents must be an array.');
    } else {
      manifest.agents.forEach((a, i) => {
        if (!isPlainObject(a)) { pushError(errors, `agents[${i}]`, 'each agent must be an object.'); return; }
        unknownFieldErrors(a, AGENT_FIELDS, `agents[${i}]`, errors);

        if (typeof a.slug !== 'string' || !SLUG_RE.test(a.slug)) {
          pushError(errors, `agents[${i}].slug`, `agent slug must match ${SLUG_RE}.`);
        } else if (agentSlugs.has(a.slug)) {
          pushError(errors, `agents[${i}].slug`, `duplicate agent slug "${a.slug}".`);
        } else {
          agentSlugs.add(a.slug);
        }

        let sourceRes = null;
        if (typeof a.source !== 'string') {
          pushError(errors, `agents[${i}].source`, 'agent source is required.');
        } else {
          if (sourcePaths.has(a.source)) pushError(errors, `agents[${i}].source`, `duplicate agent/skill source path "${a.source}".`);
          sourcePaths.add(a.source);
          sourceRes = resolveSafePackagePath(packageRealPath, a.source);
          if (!sourceRes.ok) pushError(errors, `agents[${i}].source`, `agent source "${a.source}" ${sourceRes.reason}.`);
        }

        if (a.reportsTo !== undefined) {
          const validReportsTo = a.reportsTo === '$orchestrator'
            || (typeof a.reportsTo === 'string' && a.reportsTo !== a.slug && declaredAgentSlugs.has(a.reportsTo));
          if (!validReportsTo) {
            pushError(errors, `agents[${i}].reportsTo`,
              'reportsTo must be "$orchestrator" or another agent slug declared by this plugin.');
          }
        }

        if (sourceRes && sourceRes.ok) {
          try {
            const content = readNormalisedFile(sourceRes.absPath);
            const meta = parseAgentFrontmatter(content);
            if (meta.type === 'orchestrator' || meta.type === 'platform') {
              pushError(errors, `agents[${i}].source`,
                `agent file "${a.source}" declares type: ${meta.type}, which a plugin agent cannot use.`);
            }
          } catch (e) {
            pushError(errors, `agents[${i}].source`, `could not read agent file "${a.source}": ${e.message}`);
          }
        }
      });
    }
  }

  const skillSlugs = new Set();
  if (manifest.skills !== undefined) {
    if (!Array.isArray(manifest.skills)) {
      pushError(errors, 'skills', 'skills must be an array.');
    } else {
      manifest.skills.forEach((s, i) => {
        if (!isPlainObject(s)) { pushError(errors, `skills[${i}]`, 'each skill must be an object.'); return; }
        unknownFieldErrors(s, SKILL_FIELDS, `skills[${i}]`, errors);

        if (typeof s.slug !== 'string' || !SLUG_RE.test(s.slug)) {
          pushError(errors, `skills[${i}].slug`, `skill slug must match ${SLUG_RE}.`);
        } else if (skillSlugs.has(s.slug)) {
          pushError(errors, `skills[${i}].slug`, `duplicate skill slug "${s.slug}".`);
        } else {
          skillSlugs.add(s.slug);
        }

        if (typeof s.source !== 'string') {
          pushError(errors, `skills[${i}].source`, 'skill source is required.');
        } else {
          if (sourcePaths.has(s.source)) pushError(errors, `skills[${i}].source`, `duplicate agent/skill source path "${s.source}".`);
          sourcePaths.add(s.source);
          const res = resolveSafePackagePath(packageRealPath, s.source);
          if (!res.ok) pushError(errors, `skills[${i}].source`, `skill source "${s.source}" ${res.reason}.`);
        }
      });
    }
  }

  const resourceIds = new Set();
  if (manifest.resources !== undefined) {
    if (!Array.isArray(manifest.resources)) {
      pushError(errors, 'resources', 'resources must be an array.');
    } else {
      manifest.resources.forEach((r, i) => {
        if (!isPlainObject(r)) { pushError(errors, `resources[${i}]`, 'each resource must be an object.'); return; }
        unknownFieldErrors(r, RESOURCE_FIELDS, `resources[${i}]`, errors);

        if (typeof r.id !== 'string' || !SLUG_RE.test(r.id)) {
          pushError(errors, `resources[${i}].id`, `resource id must match ${SLUG_RE}.`);
        } else if (resourceIds.has(r.id)) {
          pushError(errors, `resources[${i}].id`, `duplicate resource id "${r.id}".`);
        } else {
          resourceIds.add(r.id);
        }

        if (typeof r.file !== 'string' || !RESOURCE_FILE_RE.test(r.file)) {
          pushError(errors, `resources[${i}].file`,
            'resource file must be a bare filename ending in .json, directly under the plugin data directory.');
        }

        if (typeof r.template !== 'string') {
          pushError(errors, `resources[${i}].template`, 'resource template is required.');
        } else {
          const res = resolveSafePackagePath(packageRealPath, r.template);
          if (!res.ok) {
            pushError(errors, `resources[${i}].template`, `resource template "${r.template}" ${res.reason}.`);
          } else {
            try {
              JSON.parse(fs.readFileSync(res.absPath, 'utf-8'));
            } catch (e) {
              pushError(errors, `resources[${i}].template`, `resource template "${r.template}" is not valid JSON: ${e.message}`);
            }
          }
        }

        if (r.maximumBytes !== undefined
          && !(typeof r.maximumBytes === 'number' && Number.isInteger(r.maximumBytes) && r.maximumBytes > 0)) {
          pushError(errors, `resources[${i}].maximumBytes`, 'resource maximumBytes must be a positive integer.');
        }
      });
    }
  }

  return { errors, warnings };
}

// Reads and parses manifest.json from a package's real directory, then
// validates it. Returns { manifest, errors, warnings } even when the file is
// missing or malformed (manifest is null in that case), matching discovery's
// contract of never throwing on a bad package.
function loadAndValidateManifest(packageRealPath, dirName) {
  const manifestPath = path.join(packageRealPath, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    return { manifest: null, errors: [{ field: null, message: `Could not read manifest.json: ${e.message}` }], warnings: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { manifest: null, errors: [{ field: null, message: `manifest.json is not valid JSON: ${e.message}` }], warnings: [] };
  }
  const { errors, warnings } = validateManifest(manifest, packageRealPath, dirName);
  return { manifest, errors, warnings };
}

module.exports = {
  SLUG_RE, SEMVER_RE, SUPPORTED_SCHEMA_VERSION, RESERVED_AGENT_PREFIX, KNOWN_SLOT_TARGETS,
  deriveRuntimeSlug, resolveSafePackagePath, validateManifest, loadAndValidateManifest,
};

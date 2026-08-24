'use strict';
// Generic plugin data storage: resource bootstrap from a package's
// templates, atomic reads, and compare-and-swap replacement under
// .rundock/plugin-data/<plugin-id>/<resource-file>. The server is the only
// writer in version 1 (see the spec's "Writer ownership" section): every
// write here goes through the same temp-file-then-rename pattern
// lib/plugins/ownership.js uses for plugin-state.json.
//
// A resource is identified by manifest id + resource id, never a filesystem
// path, both here and over the protocol: the caller never chooses which
// file gets read or written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');
const manifestLib = require('./manifest.js');
const discovery = require('./discovery.js');

class StorageError extends Error {}

function pluginDataDir(pluginId) {
  return path.join(getWorkspace(), '.rundock', 'plugin-data', pluginId);
}

function resourcePath(pluginId, resourceFile) {
  return path.join(pluginDataDir(pluginId), resourceFile);
}

function computeEtag(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function atomicWriteResource(filePath, bytes) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, filePath);
}

// Resolves a resource identified by manifest id + resource id against the
// CURRENTLY ENABLED plugin's manifest. A disabled or invalid plugin's
// resources are not reachable through this generic protocol: the manifest
// that would describe them (file name, byte limit) may no longer match
// what is on disk once a plugin is mid-update.
function resolveEnabledResource(pluginId, resourceId) {
  const entry = discovery.discoverPlugins().find(e => e.id === pluginId);
  if (!entry || entry.status !== 'enabled' || !entry.manifest) {
    return { error: `Plugin "${pluginId}" is not enabled.` };
  }
  const resource = (entry.manifest.resources || []).find(r => r.id === resourceId);
  if (!resource) return { error: `Plugin "${pluginId}" does not declare a resource "${resourceId}".` };
  let packageRealPath;
  try { packageRealPath = fs.realpathSync(entry.path); } catch (e) { return { error: `Could not resolve plugin package: ${e.message}` }; }
  return { resource, packageRealPath };
}

function readTemplateDocument(packageRealPath, templateRelPath) {
  const res = manifestLib.resolveSafePackagePath(packageRealPath, templateRelPath);
  if (!res.ok) throw new StorageError(`resource template "${templateRelPath}" ${res.reason}.`);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(res.absPath, 'utf-8'));
  } catch (e) {
    throw new StorageError(`resource template "${templateRelPath}" is not valid JSON: ${e.message}`);
  }
  return doc;
}

// A freshly bootstrapped or reset resource has never actually been
// replaced, so it always starts at the same place every example template
// shows: revision 0, updatedAt set to the moment it was created here (not
// whatever static timestamp the template file happens to contain).
function normalizedFreshDocument(doc) {
  return { ...doc, revision: 0, updatedAt: new Date().toISOString() };
}

function writeDocumentIfWithinLimit(filePath, doc, maximumBytes, resourceId) {
  const bytes = Buffer.from(JSON.stringify(doc, null, 2), 'utf-8');
  if (maximumBytes && bytes.length > maximumBytes) {
    throw new StorageError(`resource "${resourceId}" exceeds its ${maximumBytes}-byte limit.`);
  }
  atomicWriteResource(filePath, bytes);
  return { etag: computeEtag(bytes), document: doc };
}

// Bootstraps every resource a plugin declares that does not already exist
// on disk. Idempotent and never overwrites an existing file: an enable that
// runs against a workspace where the data already exists (a prior enable,
// a workspace moved or re-cloned) must never reset user data back to the
// template.
function bootstrapResources(pluginId, manifest, packageRealPath) {
  for (const resource of (manifest.resources || [])) {
    const target = resourcePath(pluginId, resource.file);
    if (fs.existsSync(target)) continue;
    const doc = normalizedFreshDocument(readTemplateDocument(packageRealPath, resource.template));
    writeDocumentIfWithinLimit(target, doc, resource.maximumBytes, resource.id);
  }
}

// Returns { etag, document } on success, or one of:
//   { error }            resource unknown, plugin not enabled, or missing on disk
//   { corrupt, error }   the file exists but is not valid JSON
function readResource(pluginId, resourceId) {
  const resolved = resolveEnabledResource(pluginId, resourceId);
  if (resolved.error) return { error: resolved.error };

  const filePath = resourcePath(pluginId, resolved.resource.file);
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    return { error: `Resource "${resourceId}" has not been created yet.` };
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf-8'));
  } catch (e) {
    return { corrupt: true, error: `Resource "${resourceId}" is corrupt: ${e.message}` };
  }
  return { etag: computeEtag(bytes), document };
}

// Compare-and-swap replace. Returns one of:
//   { etag, document }             the write succeeded; document carries the server-set revision/updatedAt
//   { conflict, etag, document }   baseEtag did not match the current file; etag/document are the CURRENT ones
//   { error }                      rejected outright (unknown resource, missing baseEtag, bad shape, over limit)
//   { corrupt, error }             the file on disk is not valid JSON (never overwritten implicitly)
function replaceResource(pluginId, resourceId, baseEtag, incomingDocument) {
  const resolved = resolveEnabledResource(pluginId, resourceId);
  if (resolved.error) return { error: resolved.error };

  if (typeof baseEtag !== 'string' || !baseEtag) {
    return { error: 'A write without baseEtag is rejected.' };
  }
  if (typeof incomingDocument !== 'object' || incomingDocument === null || Array.isArray(incomingDocument)) {
    return { error: 'document must be a JSON object.' };
  }

  const filePath = resourcePath(pluginId, resolved.resource.file);
  let currentBytes;
  try {
    currentBytes = fs.readFileSync(filePath);
  } catch (e) {
    return { error: `Resource "${resourceId}" has not been created yet.` };
  }
  let currentDoc;
  try {
    currentDoc = JSON.parse(currentBytes.toString('utf-8'));
  } catch (e) {
    return { corrupt: true, error: `Resource "${resourceId}" is corrupt: ${e.message}` };
  }
  const currentEtag = computeEtag(currentBytes);
  if (baseEtag !== currentEtag) {
    return { conflict: true, etag: currentEtag, document: currentDoc };
  }

  // The client must not choose revision or updatedAt: both are overwritten
  // here regardless of what it sent, even if it echoed the prior values back.
  const priorRevision = typeof currentDoc.revision === 'number' ? currentDoc.revision : 0;
  const next = { ...incomingDocument, revision: priorRevision + 1, updatedAt: new Date().toISOString() };

  try {
    return writeDocumentIfWithinLimit(filePath, next, resolved.resource.maximumBytes, resourceId);
  } catch (e) {
    if (e instanceof StorageError) return { error: e.message };
    throw e;
  }
}

// Explicit template reset for a corrupt or otherwise unrecoverable
// resource, per the spec's Plugins-settings recovery path. Not exposed over
// the generic WebSocket protocol yet: the eight reserved message types
// (lib/protocol/handlers/plugins.js) do not include one for it, and how the
// settings UI triggers this is a client-work decision. Available here so
// that UI work can call it directly once it exists.
function resetResourceFromTemplate(pluginId, resourceId) {
  const resolved = resolveEnabledResource(pluginId, resourceId);
  if (resolved.error) return { error: resolved.error };
  let doc;
  try {
    doc = normalizedFreshDocument(readTemplateDocument(resolved.packageRealPath, resolved.resource.template));
  } catch (e) {
    if (e instanceof StorageError) return { error: e.message };
    throw e;
  }
  const filePath = resourcePath(pluginId, resolved.resource.file);
  try {
    return writeDocumentIfWithinLimit(filePath, doc, resolved.resource.maximumBytes, resourceId);
  } catch (e) {
    if (e instanceof StorageError) return { error: e.message };
    throw e;
  }
}

module.exports = {
  StorageError,
  pluginDataDir, resourcePath,
  bootstrapResources, readResource, replaceResource, resetResourceFromTemplate,
};

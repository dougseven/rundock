'use strict';
// Plugin package discovery: scans .rundock/plugins/, validates each
// package's manifest, computes its content hash, and classifies it against
// .rundock/plugin-state.json. Never throws on a broken package: one
// invalid plugin must not hide valid plugins or block workspace open.
//
// The cache follows the workspace root LIVE, same convention as the rest of
// lib/ (see lib/config.js): every call re-reads getWorkspace(), and the
// cached result records the workspace root string plus a cheap
// plugin-directory signature it was computed for, so a workspace switch
// (even to the same directory string reused later) or a package add/remove
// invalidates it without a caller having to remember to call
// invalidatePluginDiscoveryCache() explicitly, though lifecycle.js does that
// too on every mutation as defence in depth.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');
const manifestLib = require('./manifest.js');

function pluginsDir() {
  const ws = getWorkspace();
  return ws ? path.join(ws, '.rundock', 'plugins') : null;
}

let _cache = null; // { wsRoot, signature, result }

function invalidatePluginDiscoveryCache() { _cache = null; }

// Cheap signature over immediate child directories (name + mtime), skipping
// in-flight staging directories: good enough to detect install/update/
// uninstall and external package changes without re-hashing every package
// on every discovery call.
function directorySignature(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return ''; }
  const parts = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.staging-') || ent.name.startsWith('.backup-')) continue;
    // A symlinked entry counts too (isDirectory() is false for Dirent
    // symlinks; isSymbolicLink() is how scanPlugins finds it below to
    // report it as invalid, and the signature must change if such an entry
    // appears or disappears the same as any real package would).
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.lstatSync(path.join(dir, ent.name)).mtimeMs; } catch (e) { /* directory vanished mid-scan */ }
    parts.push(`${ent.name}:${mtimeMs}`);
  }
  return parts.sort().join('|');
}

// Recursively collects every file under a package directory as
// { absPath, relPath } with POSIX-normalized relative paths, throwing if any
// symbolic link is encountered anywhere in the tree (a package must contain
// no symlinks at all, not merely none that a manifest happens to reference).
function walkPackageFiles(root, dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      throw new Error(`package contains a symbolic link, which is not allowed: ${path.relative(root, abs)}`);
    }
    if (ent.isDirectory()) {
      walkPackageFiles(root, abs, out);
    } else if (ent.isFile()) {
      out.push({ absPath: abs, relPath: path.relative(root, abs).split(path.sep).join('/') });
    }
  }
}

// SHA-256 over normalized relative paths and file bytes, in sorted-path
// order so the hash is stable regardless of directory read order.
function computePackageHash(packageRealPath) {
  const files = [];
  walkPackageFiles(packageRealPath, packageRealPath, files);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f.relPath);
    hash.update('\0');
    hash.update(fs.readFileSync(f.absPath));
    hash.update('\0');
  }
  return 'sha256:' + hash.digest('hex');
}

function scanPlugins(dir) {
  const ownership = require('./ownership.js'); // late require: avoids a cycle with lifecycle.js at module-load time
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  const state = ownership.readPluginState();

  for (const ent of entries) {
    if (ent.name.startsWith('.staging-') || ent.name.startsWith('.backup-')) continue;
    // A symlinked entry is deliberately NOT skipped here (Dirent.isDirectory()
    // is false for it): it must be reported as an invalid package below, not
    // silently disappear from discovery.
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const id = ent.name;
    const packageDir = path.join(dir, id);
    const entry = { id, path: packageDir, status: 'invalid', manifest: null, errors: [], warnings: [], hash: null };

    // lstat, not a realpath string comparison: an ANCESTOR of the workspace
    // (e.g. macOS's /tmp -> /private/tmp) being a symlink is common and
    // benign, and a realpath comparison would flag every package under it.
    // What actually matters is whether packageDir ITSELF is a symlink.
    let lstat;
    try { lstat = fs.lstatSync(packageDir); } catch (e) {
      entry.errors.push({ field: null, message: `Could not resolve package directory: ${e.message}` });
      out.push(entry); continue;
    }
    if (lstat.isSymbolicLink()) {
      entry.errors.push({ field: null, message: 'Plugin package directory must not be a symbolic link.' });
      out.push(entry); continue;
    }
    let realPath;
    try { realPath = fs.realpathSync(packageDir); } catch (e) {
      entry.errors.push({ field: null, message: `Could not resolve package directory: ${e.message}` });
      out.push(entry); continue;
    }

    const { manifest, errors, warnings } = manifestLib.loadAndValidateManifest(realPath, id);
    entry.manifest = manifest;
    entry.errors = errors;
    entry.warnings = warnings;
    if (errors.length > 0) { entry.status = 'invalid'; out.push(entry); continue; }

    try {
      entry.hash = computePackageHash(realPath);
    } catch (e) {
      entry.status = 'invalid';
      entry.errors.push({ field: null, message: `Could not hash package: ${e.message}` });
      out.push(entry); continue;
    }

    const record = state.plugins[id];
    if (record && record.enabled && record.approvedHash === entry.hash) {
      entry.status = 'enabled';
    } else if (record && record.enabled && record.approvedHash !== entry.hash) {
      // Package changed on disk since it was approved. Still shown so the
      // settings view can prompt re-approval; lifecycle.reconcile() is what
      // actually flips plugin-state to disabled for this case.
      entry.status = 'approval_required';
    } else {
      entry.status = 'disabled';
    }
    out.push(entry);
  }
  return out;
}

function discoverPlugins(opts = {}) {
  const ws = getWorkspace();
  const dir = pluginsDir();
  if (!ws || !dir) return [];

  const signature = directorySignature(dir);
  if (!opts.force && _cache && _cache.wsRoot === ws && _cache.signature === signature) {
    return _cache.result;
  }
  const result = scanPlugins(dir);
  _cache = { wsRoot: ws, signature, result };
  return result;
}

module.exports = {
  pluginsDir, discoverPlugins, invalidatePluginDiscoveryCache, computePackageHash,
};

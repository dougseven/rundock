'use strict';
// Approved plugin asset resolution for lib/http-router.js's
// /plugins/<plugin-id>/<package-relative-path>?h=<approved-hash> route.
// Applies every check the spec's "HTTP asset serving" section lists, in
// order, and returns a plain result object rather than touching the
// response: the router owns headers and status codes, this module only
// decides whether a request may be served and, if so, what file and
// content type answer it.
const fs = require('fs');
const discovery = require('./discovery.js');
const manifestLib = require('./manifest.js');

const CONTENT_TYPES = { '.js': 'application/javascript', '.css': 'text/css' };

function notFound() { return { ok: false, status: 404, message: 'Not found' }; }

// pluginId and packageRelativePath must already be decoded (the router
// decodes the raw URL before calling this). Every check below operates on
// the decoded value: "encoded traversal" (e.g. %2e%2e%2f) becomes plain
// ".." once decoded, and resolveSafePackagePath's segment check (reused
// from manifest validation, the same rule applied at install/enable time)
// rejects both forms identically.
function resolveAsset(pluginId, packageRelativePath, hash) {
  // 1. Validate the plugin id and path shape before anything filesystem-facing.
  if (typeof pluginId !== 'string' || !manifestLib.SLUG_RE.test(pluginId)) return notFound();
  if (typeof packageRelativePath !== 'string' || !packageRelativePath) return notFound();
  if (typeof hash !== 'string' || !hash) return notFound();

  // 2. Require an enabled plugin whose CURRENT hash matches the one the URL names.
  const entry = discovery.discoverPlugins().find(e => e.id === pluginId);
  if (!entry || entry.status !== 'enabled' || !entry.manifest || entry.hash !== hash) return notFound();

  // 3. The path must equal the manifest's declared UI entry or one of its styles.
  const ui = entry.manifest.ui || {};
  const declaredAssets = new Set([ui.entry, ...(ui.styles || [])].filter(Boolean));
  if (!declaredAssets.has(packageRelativePath)) return notFound();

  // 4-6. Real-path resolution, containment, and symlink/non-file rejection
  // all live in resolveSafePackagePath, the same function manifest
  // validation and materialization already trust for this.
  let packageRealPath;
  try { packageRealPath = fs.realpathSync(entry.path); } catch (e) { return notFound(); }
  const resolved = manifestLib.resolveSafePackagePath(packageRealPath, packageRelativePath);
  if (!resolved.ok) return notFound();

  // 7. Only .js and .css are ever served; the declared-asset check above
  // already guarantees the extension matches ui.entry/ui.styles, but this
  // is the actual gate on what content type goes over the wire.
  const ext = packageRelativePath.slice(packageRelativePath.lastIndexOf('.'));
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return notFound();

  return { ok: true, absPath: resolved.absPath, contentType };
}

module.exports = { resolveAsset };

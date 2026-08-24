'use strict';
// Plugin package fixture builder for the plugin framework test suites.
// Writes a manifest.json plus any extra package files under a directory the
// caller already owns (typically one made with makeTempDir from
// ./workspace.js, whose cleanup this module does not duplicate).
const fs = require('fs');
const path = require('path');

function writePluginPackage(destDir, manifest, extraFiles = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return destDir;
}

// A manifest with no agents, skills, or resources: the only shape Phase 1's
// lifecycle can fully enable, since materialize.js (Phase 2) and storage.js
// (Phase 3) do not exist yet.
function minimalManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A minimal fixture plugin with no agents, skills, or resources.',
    author: 'Test Author',
    rundock: { minimumVersion: '0.11.8' },
    ...overrides,
  };
}

module.exports = { writePluginPackage, minimalManifest };

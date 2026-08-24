'use strict';
// lib/plugins/manifest.js: schema-version-1 validation. One test per rule in
// the spec's "Manifest validation" list, plus resolveSafePackagePath's path-
// traversal and symlink rejection, which every path-bearing field reuses.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const manifestLib = require('../../lib/plugins/manifest.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { writePluginPackage, minimalManifest } = require('../helpers/plugin-fixture.js');

after(cleanup);

// The leaf directory is named literally after the manifest id (not a random
// mkdtemp suffix) so the "id must match its package directory name" rule has
// something meaningful to check, and the result is realpath'd because
// several rules (path safety, symlink rejection) require an already-resolved
// base path — the same contract discovery.js and lifecycle.js honor when
// they call these functions for real.
function pkg(overrides, extraFiles) {
  const parent = makeTempDir('plugin-parent-');
  const id = (overrides && overrides.id) || 'test-plugin';
  const dir = path.join(parent, id);
  writePluginPackage(dir, minimalManifest({ id, ...overrides }), extraFiles);
  return fs.realpathSync(dir);
}

function fieldErrors(errors, field) {
  return errors.filter(e => e.field === field || (typeof e.field === 'string' && e.field.startsWith(field)));
}

describe('validateManifest: top-level shape', () => {
  test('rejects a non-object manifest', () => {
    const { errors } = manifestLib.validateManifest(null, '/nonexistent');
    assert.ok(errors.length > 0);
  });

  test('a fully minimal manifest validates with no errors', () => {
    const dir = pkg();
    const { manifest, errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(manifest.id, 'test-plugin');
  });

  test('unknown top-level field is a warning, not an error', () => {
    const dir = pkg({ notARealField: true });
    const { errors, warnings } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
    assert.ok(warnings.some(w => w.message.includes('notARealField')));
  });
});

describe('validateManifest: schemaVersion', () => {
  test('missing schemaVersion is an error', () => {
    const dir = pkg({ schemaVersion: undefined });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'schemaVersion').length > 0);
  });

  test('schemaVersion 0 is rejected (must equal 1)', () => {
    const dir = pkg({ schemaVersion: 0 });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'schemaVersion').length > 0);
  });

  test('schemaVersion above supported is a clear compatibility error', () => {
    const dir = pkg({ schemaVersion: 2 });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    const e = fieldErrors(errors, 'schemaVersion');
    assert.ok(e.length > 0);
    assert.match(e[0].message, /[Uu]nsupported schema version/);
  });
});

describe('validateManifest: id', () => {
  test('id must match the slug pattern', () => {
    const dir = pkg({ id: 'Not_A_Slug' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'id').length > 0);
  });

  test('id must match its package directory name when dirName is given', () => {
    const dir = pkg({ id: 'test-plugin' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, 'a-different-directory-name');
    assert.ok(fieldErrors(errors, 'id').length > 0);
  });

  test('the directory-name check is skipped when dirName is omitted (install pre-flight)', () => {
    const dir = pkg({ id: 'test-plugin' });
    const { errors } = manifestLib.loadAndValidateManifest(dir); // no dirName
    assert.deepStrictEqual(errors, []);
  });
});

describe('validateManifest: version fields', () => {
  test('version must be a major.minor.patch semver', () => {
    for (const bad of ['1.0', 'v1.0.0', '1.0.0-beta', 'latest', undefined]) {
      const dir = pkg({ version: bad });
      const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
      assert.ok(fieldErrors(errors, 'version').length > 0, `expected an error for version ${JSON.stringify(bad)}`);
    }
  });

  test('rundock.minimumVersion must be a major.minor.patch semver', () => {
    const dir = pkg({ rundock: { minimumVersion: 'not-a-version' } });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'rundock.minimumVersion').length > 0);
  });

  test('unknown field inside rundock is an error (not silently ignored)', () => {
    const dir = pkg({ rundock: { minimumVersion: '0.11.8', typoField: true } });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'rundock').length > 0);
  });
});

describe('validateManifest: package-relative paths (ui)', () => {
  test('ui.entry must end in .js', () => {
    const dir = pkg({ ui: { entry: 'index.txt' } }, { 'index.txt': 'not js' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'ui.entry').length > 0);
  });

  test('ui.entry must exist inside the package', () => {
    const dir = pkg({ ui: { entry: 'ui/missing.js' } });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'ui.entry').length > 0);
  });

  test('ui.entry cannot escape the package via traversal', () => {
    const dir = pkg({ ui: { entry: '../../../etc/passwd.js' } });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'ui.entry').length > 0);
  });

  test('ui.entry rejects backslashes', () => {
    const dir = pkg({ ui: { entry: 'ui\\index.js' } });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'ui.entry').length > 0);
  });

  test('ui.entry resolving through a symbolic link is rejected', () => {
    const dir = pkg();
    const real = path.join(dir, 'real.js');
    fs.writeFileSync(real, 'console.log(1);');
    fs.symlinkSync(real, path.join(dir, 'link.js'));
    const { errors } = manifestLib.validateManifest({ ...minimalManifest(), ui: { entry: 'link.js' } }, dir);
    assert.ok(fieldErrors(errors, 'ui.entry').length > 0);
  });

  test('a valid ui.entry and styles pass', () => {
    const dir = pkg({ ui: { entry: 'ui/index.js', styles: ['ui/app.css'] } }, {
      'ui/index.js': '// entry',
      'ui/app.css': '/* styles */',
    });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
  });

  test('ui.styles entries must end in .css', () => {
    const dir = pkg({ ui: { styles: ['ui/app.js'] } }, { 'ui/app.js': '' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'ui.styles').length > 0);
  });
});

describe('validateManifest: routes and slots', () => {
  test('route id must match the slug pattern', () => {
    const dir = pkg({ routes: [{ id: 'Bad Id', path: '/x', label: 'X', view: 'x' }] });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'routes[0].id').length > 0);
  });

  test('duplicate route ids are rejected', () => {
    const dir = pkg({
      routes: [
        { id: 'home', path: '/a', label: 'A', view: 'a' },
        { id: 'home', path: '/b', label: 'B', view: 'b' },
      ],
    });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate route id/.test(e.message)));
  });

  test('unknown field inside a route is an error', () => {
    const dir = pkg({ routes: [{ id: 'home', path: '/a', label: 'A', view: 'a', extra: 1 }] });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /Unknown field "extra"/.test(e.message)));
  });

  test('an unknown slot target makes the manifest invalid', () => {
    const dir = pkg({ slots: [{ target: 'not-a-real-slot', view: 'x' }] });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'slots[0].target').length > 0);
  });

  test('duplicate slot targets are rejected', () => {
    const dir = pkg({
      slots: [
        { target: 'chat-side-panel', view: 'a' },
        { target: 'chat-side-panel', view: 'b' },
      ],
    });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate slot target/.test(e.message)));
  });

  test('a declared chat-side-panel slot passes', () => {
    const dir = pkg({ slots: [{ target: 'chat-side-panel', view: 'risk-controls' }] });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
  });
});

function agentFileContent({ type } = {}) {
  const lines = ['---', 'name: lead-partner'];
  if (type) lines.push(`type: ${type}`);
  lines.push('---', '', 'You are the lead.');
  return lines.join('\n');
}

describe('validateManifest: agents', () => {
  test('agent slug must match the slug pattern', () => {
    const dir = pkg({ agents: [{ slug: 'Bad_Slug', source: 'agents/a.md' }] }, { 'agents/a.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'agents[0].slug').length > 0);
  });

  test('duplicate agent slugs are rejected', () => {
    const dir = pkg({
      agents: [
        { slug: 'a', source: 'agents/a.md' },
        { slug: 'a', source: 'agents/b.md' },
      ],
    }, { 'agents/a.md': agentFileContent(), 'agents/b.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate agent slug/.test(e.message)));
  });

  test('agent and skill source paths must be unique within the manifest', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'shared.md' }],
      skills: [{ slug: 'b', source: 'shared.md' }],
    }, { 'shared.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate agent\/skill source path/.test(e.message)));
  });

  test('reportsTo must be $orchestrator or a plugin-declared agent slug', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: 'nonexistent-slug' }],
    }, { 'agents/a.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'agents[0].reportsTo').length > 0);
  });

  test('reportsTo of $orchestrator is valid', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: '$orchestrator' }],
    }, { 'agents/a.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
  });

  test('an agent cannot report to itself', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: 'a' }],
    }, { 'agents/a.md': agentFileContent() });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'agents[0].reportsTo').length > 0);
  });

  test('a plugin agent file cannot declare type: orchestrator', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: '$orchestrator' }],
    }, { 'agents/a.md': agentFileContent({ type: 'orchestrator' }) });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /declares type: orchestrator/.test(e.message)));
  });

  test('a plugin agent file cannot declare type: platform', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: '$orchestrator' }],
    }, { 'agents/a.md': agentFileContent({ type: 'platform' }) });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /declares type: platform/.test(e.message)));
  });

  test('type: specialist is fine', () => {
    const dir = pkg({
      agents: [{ slug: 'a', source: 'agents/a.md', reportsTo: '$orchestrator' }],
    }, { 'agents/a.md': agentFileContent({ type: 'specialist' }) });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
  });
});

describe('validateManifest: skills', () => {
  test('skill slug must match the slug pattern', () => {
    const dir = pkg({ skills: [{ slug: 'Bad_Slug', source: 'skills/a/SKILL.md' }] }, { 'skills/a/SKILL.md': '# skill' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'skills[0].slug').length > 0);
  });

  test('duplicate skill slugs are rejected', () => {
    const dir = pkg({
      skills: [
        { slug: 's', source: 'skills/a/SKILL.md' },
        { slug: 's', source: 'skills/b/SKILL.md' },
      ],
    }, { 'skills/a/SKILL.md': '# a', 'skills/b/SKILL.md': '# b' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate skill slug/.test(e.message)));
  });
});

describe('validateManifest: resources', () => {
  test('resource id must match the slug pattern', () => {
    const dir = pkg({
      resources: [{ id: 'Bad_Id', file: 'state.json', template: 'templates/state.json' }],
    }, { 'templates/state.json': '{}' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'resources[0].id').length > 0);
  });

  test('duplicate resource ids are rejected', () => {
    const dir = pkg({
      resources: [
        { id: 'state', file: 'a.json', template: 'templates/a.json' },
        { id: 'state', file: 'b.json', template: 'templates/b.json' },
      ],
    }, { 'templates/a.json': '{}', 'templates/b.json': '{}' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(errors.some(e => /duplicate resource id/.test(e.message)));
  });

  test('resource file must be a bare filename ending in .json', () => {
    for (const bad of ['nested/state.json', 'state.txt', 'state']) {
      const dir = pkg({
        resources: [{ id: 'state', file: bad, template: 'templates/state.json' }],
      }, { 'templates/state.json': '{}' });
      const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
      assert.ok(fieldErrors(errors, 'resources[0].file').length > 0, `expected an error for file ${JSON.stringify(bad)}`);
    }
  });

  test('resource template must be valid JSON', () => {
    const dir = pkg({
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json' }],
    }, { 'templates/state.json': '{not valid json' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.ok(fieldErrors(errors, 'resources[0].template').length > 0);
  });

  test('resource maximumBytes must be a positive integer', () => {
    for (const bad of [0, -1, 1.5, 'lots']) {
      const dir = pkg({
        resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json', maximumBytes: bad }],
      }, { 'templates/state.json': '{}' });
      const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
      assert.ok(fieldErrors(errors, 'resources[0].maximumBytes').length > 0, `expected an error for maximumBytes ${JSON.stringify(bad)}`);
    }
  });

  test('a valid resource passes', () => {
    const dir = pkg({
      resources: [{ id: 'state', file: 'state.json', template: 'templates/state.json', maximumBytes: 1048576 }],
    }, { 'templates/state.json': '{"schemaVersion":1}' });
    const { errors } = manifestLib.loadAndValidateManifest(dir, path.basename(dir));
    assert.deepStrictEqual(errors, []);
  });
});

describe('resolveSafePackagePath', () => {
  // resolveSafePackagePath's contract is that its base directory is already
  // realpath'd (documented at the top of manifest.js) — realpath every temp
  // dir here, matching how discovery.js and lifecycle.js actually call it,
  // so these tests do not depend on the test machine's tmpdir having no
  // symlinked ancestors (macOS's /tmp -> /private/tmp, notably, does).
  test('rejects ".." traversal', () => {
    const dir = fs.realpathSync(makeTempDir('plugin-'));
    const res = manifestLib.resolveSafePackagePath(dir, '../outside.js');
    assert.strictEqual(res.ok, false);
  });

  test('rejects an absolute path', () => {
    const dir = fs.realpathSync(makeTempDir('plugin-'));
    const res = manifestLib.resolveSafePackagePath(dir, '/etc/passwd');
    assert.strictEqual(res.ok, false);
  });

  test('rejects a path through a symlinked ancestor directory', () => {
    const dir = fs.realpathSync(makeTempDir('plugin-'));
    const outside = makeTempDir('outside-');
    fs.writeFileSync(path.join(outside, 'secret.js'), '// secret');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    const res = manifestLib.resolveSafePackagePath(dir, 'linked/secret.js');
    assert.strictEqual(res.ok, false);
  });

  test('accepts a real file inside the package', () => {
    const dir = fs.realpathSync(makeTempDir('plugin-'));
    fs.writeFileSync(path.join(dir, 'ok.js'), '// ok');
    const res = manifestLib.resolveSafePackagePath(dir, 'ok.js');
    assert.strictEqual(res.ok, true);
  });
});

describe('deriveRuntimeSlug', () => {
  test('derives the reserved rundock-plugin- prefixed runtime slug', () => {
    assert.strictEqual(
      manifestLib.deriveRuntimeSlug('investment-dashboard', 'lead-partner'),
      'rundock-plugin-investment-dashboard-lead-partner',
    );
  });
});

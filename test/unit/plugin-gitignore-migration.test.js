'use strict';
// lib/workspace/scaffold.js: migratePluginGitignore(). Verifies the exact-
// line-replacement rule that lets plugin packages be tracked in Git while
// never rewriting a workspace's own hand-edited .gitignore policy.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { migratePluginGitignore } = require('../../lib/workspace/scaffold.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const MANAGED_BLOCK = [
  '.rundock/*',
  '!.rundock/plugins/',
  '!.rundock/plugins/**',
  '.claude/agents/rundock-plugin-*.md',
  '.claude/skills/rundock-plugin-*/',
];

function readGitignore(dir) {
  return fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
}

describe('migratePluginGitignore', () => {
  test('a fresh workspace with no .gitignore gets the managed block appended', () => {
    const dir = makeTempDir('ws-');
    const status = migratePluginGitignore(dir);
    assert.strictEqual(status, 'scaffolded');
    const lines = readGitignore(dir).trim().split('\n');
    assert.deepStrictEqual(lines, MANAGED_BLOCK);
  });

  test('the exact prior Rundock-written ".rundock/" line is replaced with the managed block, in place', () => {
    const dir = makeTempDir('ws-');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.rundock/\nother-thing/\n');
    const status = migratePluginGitignore(dir);
    assert.strictEqual(status, 'migrated');
    const lines = readGitignore(dir).trim().split('\n');
    assert.deepStrictEqual(lines, ['node_modules/', ...MANAGED_BLOCK, 'other-thing/']);
  });

  test('a user-edited .rundock-related line is left untouched', () => {
    const dir = makeTempDir('ws-');
    fs.writeFileSync(path.join(dir, '.gitignore'), '# custom policy\n**/.rundock/\n');
    const status = migratePluginGitignore(dir);
    assert.strictEqual(status, 'user-managed');
    assert.strictEqual(readGitignore(dir), '# custom policy\n**/.rundock/\n');
  });

  test('is idempotent: running twice after a fresh scaffold makes no further change', () => {
    const dir = makeTempDir('ws-');
    migratePluginGitignore(dir);
    const afterFirst = readGitignore(dir);
    const status = migratePluginGitignore(dir);
    assert.strictEqual(status, 'unchanged');
    assert.strictEqual(readGitignore(dir), afterFirst);
  });

  test('is idempotent: running twice after a migration makes no further change', () => {
    const dir = makeTempDir('ws-');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.rundock/\n');
    migratePluginGitignore(dir);
    const afterMigration = readGitignore(dir);
    const status = migratePluginGitignore(dir);
    assert.strictEqual(status, 'unchanged');
    assert.strictEqual(readGitignore(dir), afterMigration);
  });

  test('an unrelated .gitignore with no .rundock mention at all gets the block appended, content preserved', () => {
    const dir = makeTempDir('ws-');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    migratePluginGitignore(dir);
    const lines = readGitignore(dir).trim().split('\n');
    assert.deepStrictEqual(lines, ['dist/', ...MANAGED_BLOCK]);
  });
});

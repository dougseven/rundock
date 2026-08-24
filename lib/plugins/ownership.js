'use strict';
// .rundock/plugin-state.json: server-managed approvals and ownership
// registry. Server-owned and Git-ignored (it records hashes and internal
// bookkeeping, not shareable package content). Writes go through a
// temporary file in the same directory followed by rename, per the plugin
// framework spec, so a crash mid-write can never leave a half-written file
// that a later read would trust.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');

const SCHEMA_VERSION = 1;

function statePath() {
  const ws = getWorkspace();
  return ws ? path.join(ws, '.rundock', 'plugin-state.json') : null;
}

function emptyState() { return { schemaVersion: SCHEMA_VERSION, plugins: {} }; }

function isValidStateShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.schemaVersion !== SCHEMA_VERSION) return false;
  if (!data.plugins || typeof data.plugins !== 'object' || Array.isArray(data.plugins)) return false;
  return true;
}

// Invalid state must never leave Rundock silently trusting a package it can
// no longer verify approval for: back it up once, then rebuild empty (every
// plugin implicitly disabled) rather than half-trusting stale or malformed
// data. Idempotent in effect: a corrupt file that fails to parse a second
// time just gets a second timestamped backup, never overwritten data loss.
function backupAndReset(file, raw) {
  try {
    const backupPath = `${file}.invalid-${Date.now()}`;
    fs.writeFileSync(backupPath, raw);
    console.warn(`  [Plugins] plugin-state.json was invalid; backed up to ${backupPath} and reset. All plugins are now disabled.`);
  } catch (e) {
    console.warn(`  [Plugins] plugin-state.json was invalid and could not be backed up: ${e.message}`);
  }
}

function readPluginState() {
  const file = statePath();
  if (!file) return emptyState();
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) { return emptyState(); }
  let data;
  try { data = JSON.parse(raw); } catch (e) { backupAndReset(file, raw); return emptyState(); }
  if (!isValidStateShape(data)) { backupAndReset(file, raw); return emptyState(); }
  return data;
}

function writePluginState(state) {
  const file = statePath();
  if (!file) throw new Error('No workspace selected.');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.plugin-state.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  SCHEMA_VERSION, statePath, emptyState, readPluginState, writePluginState,
};

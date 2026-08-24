'use strict';
// WS handlers: the plugin lifecycle and generic resource protocol. Message
// names are the eight the spec reserves and core registers here, the only
// place they are ever registered (see buildDispatch in ./index.js).
//
// Every reply to the requesting client, and every list/roster broadcast to
// all connected clients, sends a SANITIZED client manifest: no local
// filesystem paths, no template paths, no ownership internals
// (assignedOrders, materializedAgents/Skills), and no asset URLs for a
// plugin that is not enabled.
const { getWorkspace } = require('../../config.js');
const { discoverAgents } = require('../../agents/discovery.js');
const discovery = require('../../plugins/discovery.js');
const lifecycle = require('../../plugins/lifecycle.js');
const storage = require('../../plugins/storage.js');

function buildAssetUrl(pluginId, packageRelativePath, hash) {
  return `/plugins/${encodeURIComponent(pluginId)}/${packageRelativePath}?h=${encodeURIComponent(hash)}`;
}

// One entry's spec-shaped, client-safe form. `errors`/`warnings` already
// carry no filesystem paths (manifest.js reports field names and messages
// only), so they ride straight through for the settings view to display.
function toClientPlugin(entry) {
  const manifest = entry.manifest;
  const enabled = entry.status === 'enabled';
  const client = {
    id: entry.id,
    name: manifest ? manifest.name : entry.id,
    version: manifest ? manifest.version : null,
    status: entry.status,
    errors: entry.errors,
    warnings: entry.warnings,
    entryUrl: null,
    styleUrls: [],
    routes: manifest ? (manifest.routes || []).map(r => ({ id: r.id, path: r.path, label: r.label, icon: r.icon || null, view: r.view })) : [],
    slots: manifest ? (manifest.slots || []).map(s => ({ target: s.target, view: s.view })) : [],
    agents: manifest ? (manifest.agents || []).map(a => ({ slug: a.slug, reportsTo: a.reportsTo || null })) : [],
  };
  if (enabled && manifest && manifest.ui && manifest.ui.entry) {
    client.entryUrl = buildAssetUrl(entry.id, manifest.ui.entry, entry.hash);
    client.styleUrls = (manifest.ui.styles || []).map(s => buildAssetUrl(entry.id, s, entry.hash));
  }
  return client;
}

function sendPluginList(ws) {
  const plugins = getWorkspace() ? discovery.discoverPlugins().map(toClientPlugin) : [];
  ws.send(JSON.stringify({ type: 'plugins', plugins }));
}

function broadcastPluginList(ctx) {
  const plugins = getWorkspace() ? discovery.discoverPlugins().map(toClientPlugin) : [];
  ctx.broadcast(JSON.stringify({ type: 'plugins', plugins }));
}

// Shared by every lifecycle-mutating handler: broadcast the refreshed
// plugin list plus the roster and skills (materialization/removal changes
// both), matching the spec's enable-transaction step 9. The file tree is
// not broadcast here: .claude/ is a dotfile directory the tree already
// hides, so a plugin's own projections never change what it shows.
function broadcastRosterAfterMutation(ctx) {
  broadcastPluginList(ctx);
  ctx.agents.invalidateAgentCache();
  const updatedAgents = discoverAgents();
  ctx.broadcast(JSON.stringify({ type: 'agents', agents: updatedAgents }));
  ctx.broadcast(JSON.stringify({ type: 'skills', skills: ctx.agents.discoverSkills(updatedAgents) }));
}

function handleGetPlugins(ctx, ws, msg) {
  sendPluginList(ws);
}

function handleInstallPlugin(ctx, ws, msg) {
  const result = lifecycle.installFromFolder(msg && msg.path);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'plugin_error', action: 'install', errors: result.errors }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_installed', pluginId: result.plugin.id, version: result.plugin.version }));
  broadcastPluginList(ctx);
}

function handleEnablePlugin(ctx, ws, msg) {
  const result = lifecycle.enablePlugin(msg && msg.pluginId);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'plugin_error', action: 'enable', pluginId: msg && msg.pluginId, errors: result.errors }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_enabled', pluginId: result.plugin.id }));
  broadcastRosterAfterMutation(ctx);
}

function handleDisablePlugin(ctx, ws, msg) {
  const result = lifecycle.disablePlugin(msg && msg.pluginId);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'plugin_error', action: 'disable', pluginId: msg && msg.pluginId, errors: result.errors }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_disabled', pluginId: msg.pluginId }));
  broadcastRosterAfterMutation(ctx);
}

function handleUpdatePlugin(ctx, ws, msg) {
  const result = lifecycle.updateFromFolder(msg && msg.pluginId, msg && msg.path);
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'plugin_error', action: 'update', pluginId: msg && msg.pluginId, errors: result.errors }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_updated', pluginId: result.plugin.id, version: result.plugin.version }));
  broadcastRosterAfterMutation(ctx);
}

function handleUninstallPlugin(ctx, ws, msg) {
  const result = lifecycle.uninstallPlugin(msg && msg.pluginId, { deleteData: !!(msg && msg.deleteData) });
  if (!result.success) {
    ws.send(JSON.stringify({ type: 'plugin_error', action: 'uninstall', pluginId: msg && msg.pluginId, errors: result.errors }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_uninstalled', pluginId: msg.pluginId }));
  broadcastRosterAfterMutation(ctx);
}

function handlePluginDataGet(ctx, ws, msg) {
  const { requestId, pluginId, resourceId } = msg || {};
  const result = storage.readResource(pluginId, resourceId);
  if (result.error) {
    ws.send(JSON.stringify({ type: 'plugin_data_error', requestId, pluginId, resourceId, message: result.error }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_data', requestId, pluginId, resourceId, etag: result.etag, document: result.document }));
}

function handlePluginDataReplace(ctx, ws, msg) {
  const { requestId, pluginId, resourceId, baseEtag, document } = msg || {};
  const result = storage.replaceResource(pluginId, resourceId, baseEtag, document);
  if (result.conflict) {
    ws.send(JSON.stringify({ type: 'plugin_data_conflict', requestId, pluginId, resourceId, etag: result.etag, document: result.document }));
    return;
  }
  if (result.error) {
    ws.send(JSON.stringify({ type: 'plugin_data_error', requestId, pluginId, resourceId, message: result.error }));
    return;
  }
  ws.send(JSON.stringify({ type: 'plugin_data_saved', requestId, pluginId, resourceId, etag: result.etag }));
  // Every client, including this one, learns the new document: the spec
  // requires a SECOND client mid-edit to be told, and there is no cheaper
  // way to guarantee that than broadcasting to all of them.
  ctx.broadcast(JSON.stringify({ type: 'plugin_data_changed', pluginId, resourceId, etag: result.etag, document: result.document }));
}

module.exports = {
  handleGetPlugins, handleInstallPlugin, handleEnablePlugin, handleDisablePlugin,
  handleUpdatePlugin, handleUninstallPlugin, handlePluginDataGet, handlePluginDataReplace,
};

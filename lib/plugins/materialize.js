'use strict';
// Managed agent/skill projections: copies a plugin's package-local agent and
// skill sources into runtime files under .claude/, rewriting the frontmatter
// fields the spec requires (name, type, reportsTo, order, skills, plus the
// rundockPlugin/rundockManaged/rundockPluginAgent ownership fields). The
// package source is never touched; the materialized file is a derived
// artifact regenerated in full on every enable.
//
// Transaction shape: materializePlugin() writes every agent and skill file
// for one plugin, tracking what it wrote. If any step fails (a content
// validation error, or a filesystem error), everything written so far in
// THIS call is removed before the error propagates, so a caller never has
// to reconstruct which of several writes actually landed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWorkspace } = require('../config.js');
const { parseAgentFrontmatter, extractFrontmatterText, parseSkills, readNormalisedFile } = require('../agents/discovery.js');
const manifestLib = require('./manifest.js');

class MaterializeError extends Error {}

function agentTargetPath(pluginId, localSlug) {
  const runtimeSlug = manifestLib.deriveRuntimeSlug(pluginId, localSlug);
  return path.join(getWorkspace(), '.claude', 'agents', `${runtimeSlug}.md`);
}

function skillTargetDir(pluginId, localSlug) {
  const runtimeSlug = manifestLib.deriveRuntimeSlug(pluginId, localSlug);
  return path.join(getWorkspace(), '.claude', 'skills', runtimeSlug);
}

// Splits "---\n<frontmatter>\n---\n<body>" into its three parts. Returns
// null for content with no frontmatter block, which the caller treats as a
// MaterializeError (a plugin agent file without frontmatter has no `name`
// to verify against the manifest slug).
function splitFrontmatter(content) {
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return null;
  return { open: m[1], fm: m[2], close: m[3], body: m[4] };
}

// Replaces an existing top-level "key: value" line in a frontmatter-text
// fragment, or prepends one as the new first line when absent. Every field
// materialization sets is a plain scalar, so this one rule covers all of
// them; the source's own field order and every other key ride through
// unchanged.
function setField(fm, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  return re.test(fm) ? fm.replace(re, line) : `${line}\n${fm}`;
}

// Rewrites the `skills:` field to the given runtime slugs, replacing
// whichever form (inline `skills: [a, b]` or block `skills:\n  - a`) is
// present. Mirrors the two forms lib/agents/discovery.js's parseSkills
// reads, so the same file parses back the same way after materialization.
// A plugin agent's skills are always rewritten as the compact inline form.
function setSkillsField(fm, runtimeSlugs) {
  const newLine = `skills: [${runtimeSlugs.join(', ')}]`;
  const inlineRe = /^skills:[ \t]*\[[^\]]*\][ \t]*$/m;
  if (inlineRe.test(fm)) return fm.replace(inlineRe, newLine);
  const blockRe = /^skills:[ \t]*\n(?:[ \t]+-[ \t]*[^\n]*(?:\n|$))+/m;
  if (blockRe.test(fm)) return fm.replace(blockRe, `${newLine}\n`);
  if (runtimeSlugs.length === 0) return fm;
  return `${newLine}\n${fm}`;
}

// Transforms one agent source file's raw content into its materialized
// form. Throws MaterializeError for a content problem the manifest itself
// could not have caught (the source frontmatter name not matching its
// declared slug, or a skill reference the manifest never declared).
function buildMaterializedAgentContent({ pluginId, agentDecl, sourceContent, reportsToRuntimeValue, assignedOrder, localSkillSlugToRuntimeSlug }) {
  const split = splitFrontmatter(sourceContent);
  if (!split) {
    throw new MaterializeError(`agent "${agentDecl.slug}": source file has no frontmatter block.`);
  }
  const meta = parseAgentFrontmatter(sourceContent);
  if (meta.name !== agentDecl.slug) {
    throw new MaterializeError(
      `agent "${agentDecl.slug}": source frontmatter name "${meta.name}" must equal the manifest slug "${agentDecl.slug}".`);
  }

  const declaredLocalSkills = parseSkills(extractFrontmatterText(sourceContent));
  for (const localSkillSlug of declaredLocalSkills) {
    if (!localSkillSlugToRuntimeSlug.has(localSkillSlug)) {
      throw new MaterializeError(
        `agent "${agentDecl.slug}" references skill "${localSkillSlug}", which this plugin's manifest does not declare.`);
    }
  }
  const runtimeSkillSlugs = declaredLocalSkills.map(s => localSkillSlugToRuntimeSlug.get(s));

  const runtimeSlug = manifestLib.deriveRuntimeSlug(pluginId, agentDecl.slug);
  let fm = split.fm;
  fm = setField(fm, 'name', runtimeSlug);
  fm = setField(fm, 'rundockPluginAgent', agentDecl.slug);
  fm = setField(fm, 'type', 'specialist');
  fm = setField(fm, 'reportsTo', reportsToRuntimeValue);
  fm = setField(fm, 'order', assignedOrder);
  fm = setField(fm, 'rundockPlugin', pluginId);
  fm = setField(fm, 'rundockManaged', 'true');
  fm = setSkillsField(fm, runtimeSkillSlugs);

  return { runtimeSlug, content: split.open + fm + split.close + split.body };
}

function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Materializes every agent and skill declared by a plugin's manifest.
// `orchestratorFrontmatterName` is the CURRENT orchestrator's own frontmatter
// `name` (not its internal roster id): $orchestrator resolves to that.
// Returns { materializedAgents, materializedSkills } (arrays of runtime
// slugs) on success. On any failure, removes every file this call wrote and
// rethrows, so nothing partially materializes.
function materializePlugin({ pluginId, packageRealPath, manifest, assignedOrders, orchestratorFrontmatterName }) {
  const agents = manifest.agents || [];
  const skills = manifest.skills || [];

  const localSlugToRuntimeSlug = new Map(agents.map(a => [a.slug, manifestLib.deriveRuntimeSlug(pluginId, a.slug)]));
  const localSkillSlugToRuntimeSlug = new Map(skills.map(s => [s.slug, manifestLib.deriveRuntimeSlug(pluginId, s.slug)]));

  const writtenPaths = [];
  const materializedAgents = [];
  const materializedSkills = [];

  try {
    for (const agentDecl of agents) {
      const sourceRes = manifestLib.resolveSafePackagePath(packageRealPath, agentDecl.source);
      if (!sourceRes.ok) {
        throw new MaterializeError(`agent "${agentDecl.slug}" source "${agentDecl.source}" ${sourceRes.reason}.`);
      }
      const sourceContent = readNormalisedFile(sourceRes.absPath);

      let reportsToRuntimeValue;
      if (!agentDecl.reportsTo || agentDecl.reportsTo === '$orchestrator') {
        reportsToRuntimeValue = orchestratorFrontmatterName;
      } else {
        reportsToRuntimeValue = localSlugToRuntimeSlug.get(agentDecl.reportsTo);
      }

      const { runtimeSlug, content } = buildMaterializedAgentContent({
        pluginId, agentDecl, sourceContent, reportsToRuntimeValue,
        assignedOrder: assignedOrders[agentDecl.slug], localSkillSlugToRuntimeSlug,
      });

      const targetPath = agentTargetPath(pluginId, agentDecl.slug);
      atomicWriteFile(targetPath, content);
      writtenPaths.push(targetPath);
      materializedAgents.push(runtimeSlug);
    }

    for (const skillDecl of skills) {
      const sourceRes = manifestLib.resolveSafePackagePath(packageRealPath, skillDecl.source);
      if (!sourceRes.ok) {
        throw new MaterializeError(`skill "${skillDecl.slug}" source "${skillDecl.source}" ${sourceRes.reason}.`);
      }
      const sourceContent = readNormalisedFile(sourceRes.absPath);
      const runtimeSlug = manifestLib.deriveRuntimeSlug(pluginId, skillDecl.slug);
      const targetPath = path.join(skillTargetDir(pluginId, skillDecl.slug), 'SKILL.md');
      atomicWriteFile(targetPath, sourceContent);
      writtenPaths.push(targetPath);
      materializedSkills.push(runtimeSlug);
    }
  } catch (e) {
    for (const p of writtenPaths) removeProjectionFile(p);
    throw e;
  }

  return { materializedAgents, materializedSkills };
}

function removeProjectionFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.rmSync(filePath); } catch (e) { /* best effort */ }
}

// Removes every projection recorded for a plugin (used by disable and, by
// extension, uninstall which disables first). materializedAgents/Skills are
// RUNTIME SLUGS, never paths: reconstructing paths from the recorded slug
// list, rather than trusting a stored path, is what keeps this from ever
// deleting a file that is not actually this plugin's own projection.
function removeMaterializedProjections(materializedAgents, materializedSkills) {
  const ws = getWorkspace();
  for (const slug of (materializedAgents || [])) {
    try {
      const p = path.join(ws, '.claude', 'agents', `${slug}.md`);
      if (fs.existsSync(p)) fs.rmSync(p);
    } catch (e) {
      console.warn(`  [Plugins] could not remove agent projection "${slug}": ${e.message}`);
    }
  }
  for (const slug of (materializedSkills || [])) {
    try {
      const p = path.join(ws, '.claude', 'skills', slug);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      console.warn(`  [Plugins] could not remove skill projection "${slug}": ${e.message}`);
    }
  }
}

module.exports = {
  MaterializeError,
  agentTargetPath, skillTargetDir,
  buildMaterializedAgentContent, materializePlugin, removeMaterializedProjections,
};

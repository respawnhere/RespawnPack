#!/usr/bin/env node
/*
 * RespawnPack · lockdown.js — PreToolUse deny-hook that scopes edits to an allowed path set.
 *
 * Wire as a PreToolUse hook matching Edit|Write|MultiEdit|NotebookEdit (see settings.snippet.json).
 * Enforcement is OFF unless a scope file exists: <project>/.respawnpack/lockdown.allow
 *   - One allowed path prefix per line (repo-relative), e.g.  apps/web/app/(app)/feed
 *   - While that file exists + is non-empty, any Edit/Write to a file OUTSIDE those prefixes is DENIED.
 *   - Delete the file to lift the lockdown.
 * Set scope:   node .claude/hooks/lockdown.js --set apps/web/app/foo  (writes the allow file)
 * Clear:       node .claude/hooks/lockdown.js --clear
 * Status:      node .claude/hooks/lockdown.js --status
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input:{file_path}, cwd}.
 * Deny = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}} + exit 0.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy, and it returns the
 * verdict as DATA — the same object this file used to write — or null for "nothing to say". It writes
 * no stdout and exits no process, so a caller that runs several checks in one process (P4-T-15b's
 * dispatcher) gets every verdict instead of whichever one exited first. The standalone path below
 * builds the same context from stdin and the environment and prints exactly what it always printed.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const scopeFile = path.join(projectDir, '.respawnpack', 'lockdown.allow');

/**
 * The context this check reads. `profile` is null on purpose: `lockdown` is one of the anti-drift
 * core's FIXED ids, so this hook has never consulted a posture and must not start now.
 */
function context(input) {
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: null,
    git: null,
    profile: null,
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name || '')) return null;
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
  if (!filePath) return null;

  let allow;
  try { allow = fs.readFileSync(path.join(ctx.projectDir, '.respawnpack', 'lockdown.allow'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  catch { return null; } // no scope file → lockdown inactive → allow
  if (!allow.length) return null;

  const rel = path.relative(ctx.projectDir, path.resolve(ctx.projectDir, filePath)).replace(/\\/g, '/');
  const inScope = allow.some((p) => {
    const pre = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return rel === pre || rel.startsWith(pre + '/');
  });
  if (inScope) return null;

  const reason =
    `🔒 lockdown active — edits are scoped to [${allow.join(', ')}]. ` +
    `"${rel}" is outside that scope. Edit within scope, or clear the lockdown ` +
    `(node .claude/hooks/lockdown.js --clear) if you need to touch it.`;
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

module.exports = { check, context };

// --- standalone entry point: CLI helpers, then PreToolUse JSON on stdin ---
if (require.main === module) {
  // --- CLI helpers (set/clear/status) ---
  const arg = process.argv[2];
  if (arg === '--set') {
    const prefixes = process.argv.slice(3);
    if (!prefixes.length) { console.error('usage: lockdown.js --set <path> [<path> ...]'); process.exit(1); }
    fs.mkdirSync(path.dirname(scopeFile), { recursive: true });
    fs.writeFileSync(scopeFile, prefixes.join('\n') + '\n');
    console.log('🔒 lockdown ON — edits scoped to:\n  ' + prefixes.join('\n  '));
    process.exit(0);
  }
  if (arg === '--clear') {
    try { fs.unlinkSync(scopeFile); console.log('lockdown OFF (scope cleared)'); } catch { console.log('lockdown already off'); }
    process.exit(0);
  }
  if (arg === '--status') {
    try { console.log('🔒 lockdown ON — scope:\n  ' + fs.readFileSync(scopeFile, 'utf8').trim().split(/\r?\n/).join('\n  ')); }
    catch { console.log('lockdown OFF'); }
    process.exit(0);
  }

  // --- Hook mode (default): read PreToolUse JSON from stdin ---
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const verdict = check(context(input));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
    process.exit(0);
  });
}

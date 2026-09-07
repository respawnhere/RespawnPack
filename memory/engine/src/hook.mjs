// Lesson 6: the post-merge/post-checkout freshness hook. `rmem hook install` writes portable sh
// hooks (git-for-windows runs hooks under sh too) that run `rmem sync` SYNCHRONOUSLY and
// fail-open — their hooks.py pattern, minus the detached-process/lock machinery: sync takes
// seconds at our scale (a few hundred entities), so there's nothing to background or lock.
import { existsSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOOK_NAMES = ['post-merge', 'post-checkout'];
export const MARKER = '# respawn-memory hook v1';

const hooksDir = (root) => resolve(root, '.git', 'hooks');

/**
 * Resolve the true repo root from anywhere inside the repo — the same `git rev-parse
 * --show-toplevel` idea the generated hook body below already uses at run time, applied at
 * install/status/uninstall time too. Without this, `rmem hook status`/`uninstall` run from a
 * subdirectory would treat cwd as the root and truthfully-looking report every hook "absent"
 * while the real hooks stay active at the actual root (install at least THREW from a subdir;
 * status/uninstall silently lied). All three subcommands must resolve the root the same way so
 * they can never disagree with each other — cli.mjs calls this once and passes the result down.
 * Falls back to walking up the directory tree looking for a `.git` entry when git itself isn't
 * available; throws a clear error when neither finds a repo. @param {string} [startDir]
 */
export function resolveRepoRoot(startDir = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: startDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return resolve(out); // git prints POSIX-style separators on Windows; resolve() normalizes
  } catch { /* git missing or not a repo — try the filesystem walk-up below */ }
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`not inside a git repository (looked from ${startDir}) — rmem hook needs a repo root to find .git/hooks`);
}

function hookBody() {
  return [
    '#!/bin/sh',
    MARKER + ' -- managed by rmem hook; do not hand-edit. Uninstall with `rmem hook uninstall`.',
    '# Fails open: a missing rmem / missing config / a failed sync must never block the git operation.',
    'command -v rmem >/dev/null 2>&1 || exit 0',
    'root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    '[ -f "$root/respawn-memory.config.json" ] || exit 0',
    'rmem sync || true',
    '',
  ].join('\n');
}

/** Install both hooks. A pre-existing hook file WITHOUT our marker is left completely untouched
 * (never overwritten) — the caller gets the two lines to append manually instead.
 * @param {string} root repo root (the dir containing .git/) @returns {Record<string, {status:'installed'|'foreign', message?:string}>} */
export function installHooks(root) {
  const dir = hooksDir(root);
  if (!existsSync(dir)) throw new Error(`no .git/hooks directory at ${dir} — is this a git repo?`);
  const results = {};
  for (const name of HOOK_NAMES) {
    const p = join(dir, name);
    if (existsSync(p) && !readFileSync(p, 'utf8').includes(MARKER)) {
      results[name] = {
        status: 'foreign',
        message: `existing ${name} hook has no respawn-memory marker — not modified. Append these two lines manually:\n`
          + '    command -v rmem >/dev/null 2>&1 && rmem sync || true',
      };
      continue;
    }
    writeFileSync(p, hookBody());
    try { chmodSync(p, 0o755); } catch { /* best effort — some filesystems have no POSIX perms */ }
    results[name] = { status: 'installed' };
  }
  return results;
}

/** Remove only marker-verified hooks (never a foreign file). @param {string} root */
export function uninstallHooks(root) {
  const dir = hooksDir(root);
  const results = {};
  for (const name of HOOK_NAMES) {
    const p = join(dir, name);
    if (!existsSync(p)) { results[name] = { status: 'absent' }; continue; }
    if (!readFileSync(p, 'utf8').includes(MARKER)) { results[name] = { status: 'foreign', message: 'not ours — left untouched' }; continue; }
    rmSync(p);
    results[name] = { status: 'removed' };
  }
  return results;
}

/** Report each hook as 'ours' | 'foreign' | 'absent'. @param {string} root */
export function statusHooks(root) {
  const dir = hooksDir(root);
  const results = {};
  for (const name of HOOK_NAMES) {
    const p = join(dir, name);
    if (!existsSync(p)) { results[name] = 'absent'; continue; }
    results[name] = readFileSync(p, 'utf8').includes(MARKER) ? 'ours' : 'foreign';
  }
  return results;
}

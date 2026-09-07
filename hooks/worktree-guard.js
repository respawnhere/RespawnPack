#!/usr/bin/env node
/*
 * RespawnPack · worktree-guard.js — PreToolUse deny-hook that binds edits to the current git worktree.
 *
 * The gap it closes: RespawnPack's EnterWorktree / wave-ledger model runs work inside a linked git
 * worktree, but nothing stops an Edit/Write from resolving to a path OUTSIDE that worktree (into the main
 * checkout or a sibling worktree). The prose "stay in your worktree" rule is the only guard today, and
 * prose guards fail under load. This hard-binds writes to the worktree root. Concept credited to
 * gsd-core's post-incident worktree path-guard (MIT) — pattern re-derived in RespawnPack's own file shape
 * (see ATTRIBUTION.md).
 *
 * A SIBLING to lockdown.js rather than folded into it, because the two have inverse activation and would
 * fight if merged: lockdown is opt-IN (enforces only while .respawnpack/lockdown.allow is present) with a
 * hand-authored path allow-list; worktree-guard is automatic (enforces whenever the session sits in a
 * linked worktree) with an auto-derived root and an opt-OUT marker. They compose cleanly as two
 * PreToolUse Edit matchers (hooks merge most-restrictive-wins).
 *
 * Wire as a PreToolUse hook matching Edit|Write|MultiEdit|NotebookEdit (see settings.snippet.json).
 * Active ONLY inside a linked worktree — detected with zero git exec: a worktree's `.git` is a FILE
 * containing `gitdir: …` rather than a directory. In the main checkout (`.git` is a dir) or outside any
 * repo, the hook does nothing. Then any edit whose resolved absolute path lands outside the worktree root
 * is DENIED.
 * Escape hatch (pack convention): create <worktree-root>/.respawnpack/worktree-guard.off to lift
 * containment for that worktree.
 *
 * ⭐ OR ONE REVIEWED PATH (P1-E-1d). The marker lifts containment for the WHOLE worktree, is untracked
 * and carries no reason. A declared `worktree-guard` exception in `respawnpack.config.json` names one
 * path glob instead — and the subject is the target's path relative to the MAIN checkout's root, not to
 * this worktree, because "which file may be crossed to" is a fact about the repository rather than
 * about whichever tree happens to be asking. The deny below prints that root and that relative path, so
 * the founder declares exactly what the guard saw. Every other escaping write is still refused.
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input:{file_path}, cwd}.
 * Deny = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}} + exit 0.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy and returns the verdict
 * as data; the standalone path below builds the context from stdin and the environment and prints it.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');
/*
 * ⛔ FAIL CLOSED, THROUGH THE BOOTSTRAP BOUNDARY (anti-drift item 27). This hook had no shared
 * dependency until it began reading the project's declared exceptions. A bare require of an
 * `_exceptions.js` that will not load would throw, the hook would exit nonzero, and a nonzero exit from
 * a PreToolUse hook is a NON-BLOCKING error — the escaping write would land. `boot.arm('deny')` makes
 * that an explicit DENY at exit 0: a reader that could not be loaded has not established that this path
 * was excepted, and an unavailable allowance is never an allowance.
 */
const boot = require('./_boot.js');
boot.arm('deny');
const exceptionsLib = boot.need('./_exceptions.js');

const startDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** The one rule id this hook decides, and the one it may ask `_exceptions.js` about. */
const RULE = 'worktree-guard';

/** The one sentence a lifted hit is reported on — the same literal in all four guards (E-1d). */
const allowedBy = (e) => `🔓 allowed by exception ${e.id} (${e.rule}): ${e.reason}`;

/** The verdict a lift emits INSTEAD of the deny, on both channels. */
const lifted = (e) => ({
  systemMessage: allowedBy(e),
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: allowedBy(e) },
});

/**
 * What a deny adds when a declaration was consulted and REFUSED WHOLE. `INVALID` only — see
 * `hooks/shell-guard.js` for why `DEFAULTED` and `UNREADABLE` must leave the refusal byte-identical.
 */
const refusedNote = (resolved) => (resolved && resolved.source === 'INVALID'
  ? `\n⛔ ${resolved.detail}`
  : '');

// Walk up from `from` for the nearest `.git`. Returns the worktree root — the directory holding a `.git`
// FILE that points elsewhere via `gitdir:` — or null when there isn't one (`.git` is a directory → main
// working tree; or no `.git` at all → not a repo). No git process is spawned.
function worktreeRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let stat = null;
    try { stat = fs.statSync(dotgit); } catch { stat = null; }
    if (stat) {
      if (stat.isDirectory()) return null; // main working tree — not a linked worktree
      if (stat.isFile()) {
        try { if (/^gitdir:\s*\S/m.test(fs.readFileSync(dotgit, 'utf8'))) return dir; } catch { /* unreadable */ }
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/*
 * ⛔ TWO SPELLINGS OF ONE PATH ARE ONE PATH, AND THE FIRST PUBLISHED RUN OF THE PATH EXCEPTION PROVED IT.
 * The Windows CI runner's temp directory is an 8.3 short name (`C:\Users\RUNNER~1\...`) while git
 * records the main checkout in the linked worktree's `.git` file in long form, so `path.relative` of the
 * two spellings climbed out through `../../..` and the deny told the founder to except a path that names
 * no file in the repository. A junctioned or symlinked project folder produces the same split on every
 * platform. So every path this guard compares or prints goes through the OS's own real path first
 * (`fs.realpathSync.native`, which expands short names and follows links), applied to the nearest
 * existing ancestor so a file that does not exist yet still canonicalises. A path whose real form cannot
 * be established keeps its resolved spelling: the guard then compares two resolved spellings exactly as
 * it always did, which is the conservative direction, never a lift.
 */
function canonical(p) {
  const abs = path.resolve(p);
  let probe = abs;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(probe), ...tail); }
    catch (e) {
      if (!e || e.code !== 'ENOENT') return abs;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

// True when `resolved` sits outside `root`. path.relative handles Windows drive-letter + separator +
// case-insensitivity: an escaping path yields a leading "..", a different drive yields an absolute result.
// Both arguments arrive canonical (see `canonical` above), so two spellings of one tree compare equal.
function isOutside(root, resolved) {
  const rel = path.relative(root, resolved);
  return rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

/**
 * The MAIN checkout's working-tree root, derived from the linked worktree's own `.git` file.
 *
 * ⛔ THE SUBJECT HAS TO BE ANCHORED SOMEWHERE THAT DOES NOT MOVE, AND A WORKTREE MOVES. A path relative
 * to THIS worktree would be a different string in every sibling tree — `../shared/notes.md` from one and
 * `../../shared/notes.md` from another — so one reviewed file would need a new declaration per worktree,
 * and a founder reading the config could not tell which file any of them meant. The main checkout's root
 * is the one anchor every worktree of a repository agrees on, so that is what the subject is relative to
 * and what the deny prints.
 *
 * ⛔ AND IT IS DERIVED THE WAY GIT ITSELF RECORDS IT, WITH NO GIT PROCESS. `<worktree>/.git` is a file
 * naming the per-worktree gitdir (`…/.git/worktrees/<name>`), and that directory holds `commondir`, a
 * relative pointer to the SHARED git directory (`…/.git`) whose parent is the main working tree. Falling
 * back to two `dirname`s covers a git old enough to omit `commondir`. Anything unreadable returns null,
 * which leaves the subject with no `path` key — and `allowed()` never matches a subject that is missing
 * a declared key, so an underivable root fails closed to the refusal.
 */
function mainCheckoutRoot(worktree) {
  let gitdir = null;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(worktree, '.git'), 'utf8'));
    if (m) gitdir = m[1].trim();
  } catch { return null; }
  if (!gitdir) return null;

  const abs = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktree, gitdir);
  let common = null;
  try { common = fs.readFileSync(path.join(abs, 'commondir'), 'utf8').trim(); } catch { common = null; }
  const shared = common
    ? (path.isAbsolute(common) ? path.resolve(common) : path.resolve(abs, common))
    : path.dirname(path.dirname(abs));
  const root = path.dirname(shared);
  return root && root !== shared ? root : null;
}

/** POSIX separators, so one declaration reads the same on both platforms this pack claims parity on. */
const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * The context this check reads. `projectDir` is the session's starting directory — the same
 * `CLAUDE_PROJECT_DIR || cwd` this hook has always walked up from, never `input.cwd`, because the
 * worktree root is a property of where the session SITS. `profile` is null: `worktree-guard` is one of
 * the anti-drift core's FIXED ids and this hook has never consulted a posture.
 *
 * ⛔ `exceptions` IS A LAZY GETTER THAT MEMOISES. Resolving it eagerly would read
 * `respawnpack.config.json` on every editor call in every project, including the overwhelming majority
 * that are not in a linked worktree at all and where this hook returns before it decides anything.
 * The read happens once, at the moment an escaping write actually needs an answer.
 *
 * ⛔ AND IT RESOLVES FROM `projectDir`, THE SAME ROOT EVERY OTHER GETTER IN THIS DIRECTORY USES, EVEN
 * THOUGH THE SUBJECT IS ANCHORED SOMEWHERE ELSE. Reading from the main checkout instead would be a
 * defensible declaration story and an indefensible dispatcher one: `hooks/dispatch.js` shares one
 * resolution per distinct `ctx.projectDir`, so a check whose READ root differs from the root it
 * advertises would be handed — or would hand out — an answer taken from a different file. The two roots
 * agree in every ordinary session anyway (the declaration is tracked, so a linked worktree carries the
 * same bytes), and where they do not, the honest failure is the guard refusing rather than lifting on a
 * declaration it read somewhere it never said it would.
 */
function context(input) {
  let declared;
  return {
    input: input || {},
    projectDir: startDir,
    workDir: (input && input.cwd) || startDir,
    principal: null,
    git: null,
    profile: null,
    get exceptions() {
      if (declared === undefined) declared = exceptionsLib.resolve(startDir);
      return declared;
    },
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  const start = ctx.projectDir;

  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name || '')) return null;
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
  if (!filePath) return null;

  const root = worktreeRoot(canonical(start));
  if (!root) return null; // not in a linked worktree → nothing to contain

  if (fs.existsSync(path.join(root, '.respawnpack', 'worktree-guard.off'))) return null; // opted out

  const resolved = canonical(path.resolve(start, filePath));
  if (!isOutside(root, resolved)) return null;

  /*
   * ⛔ THE SUBJECT IS THE TARGET'S PATH RELATIVE TO THE MAIN CHECKOUT, AND THE MESSAGE SAYS WHICH ROOT.
   * A relative path with no stated anchor is a string two readers resolve differently, and the whole
   * point of a declared exception is that the founder and the guard mean the same file. When the main
   * root cannot be derived there is NO `path` key on the subject at all — not an empty one — because
   * `allowed()` never matches a subject missing a declared key, so the failure is a refusal.
   */
  const derivedMain = mainCheckoutRoot(root);
  const mainRoot = derivedMain ? canonical(derivedMain) : null;
  const relToMain = mainRoot ? posix(path.relative(mainRoot, resolved)) : null;
  const declaredExceptions = ctx.exceptions;
  const lift = relToMain === null
    ? null
    : exceptionsLib.allowed(declaredExceptions, RULE, { path: relToMain });
  if (lift) return lifted(lift);

  const offMarker = path.join(root, '.respawnpack', 'worktree-guard.off');
  const reason =
    `🔒 worktree-guard blocked a write to "${resolved}" — it resolves OUTSIDE this session's worktree root ` +
    `(${root}). Edits that need to land elsewhere belong to the session that owns that tree; keep this one ` +
    `inside its worktree. If crossing the boundary is genuinely intended, create "${offMarker}" to lift containment.\n` +
    (relToMain === null
      ? `This worktree's main checkout could not be derived from its .git file, so there is no repository-anchored `
        + `path to declare an exception on. Repair the worktree, or use the marker above.`
      : `To except this ONE path instead of lifting containment for the whole worktree, add to `
        + `respawnpack.config.json: {"id": "<a name>", "rule": "${RULE}", "match": {"path": "${relToMain}"}, `
        + `"reason": "<why you reviewed and accepted it>"}. That path is relative to the MAIN checkout's root `
        + `(${mainRoot}), not to this worktree, and a glob is accepted. Every other escaping write stays denied.`)
    + refusedNote(declaredExceptions);
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

module.exports = { check, context };

// --- standalone entry point ---
if (require.main === module) {
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

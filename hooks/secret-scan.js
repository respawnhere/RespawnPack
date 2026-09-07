#!/usr/bin/env node
/*
 * RespawnPack · secret-scan.js — blocks a commit or a push when ADDED diff lines contain HIGH-severity
 * secrets. Commit-time coverage concept credited to the aggregator's secret-scanner hook (MIT) — the same
 * HIGH/MEDIUM pattern set is reused (its noisier low-severity rules deliberately not imported); re-derived
 * in RespawnPack's file shape (see ATTRIBUTION.md).
 *
 * Tri-mode (auto-detected from stdin):
 *  (A) Claude Code PreToolUse hook — matcher Bash, if "Bash(git push *)" OR "Bash(git commit *)"
 *      (see settings.snippet.json). stdin = hook JSON; on HIGH-severity hit → deny JSON + exit 0.
 *        • push   → scans the about-to-be-pushed diff (push-relative ranges, staged fallback).
 *        • commit → scans the about-to-be-committed diff (staged; or staged+unstaged-tracked when -a/--all).
 *  (B) git pre-push hook — installed at .git/hooks/pre-push (see pre-push wrapper).
 *      stdin = the authoritative Git ref protocol; on a HIGH hit, partial range, or inspection failure
 *      → stderr + exit 1 (blocks the push).
 *
 * The commit scan closes a real timing gap: a secret committed but never pushed already sits in local .git
 * history unguarded. "Push is authorized, never automatic" is about AUTHORIZATION timing, not secret-content
 * safety — so commit + stage stay free, but a HIGH-severity secret in what you're committing is stopped here.
 *
 * Scans only ADDED lines (lines starting with '+'). HIGH severity blocks; MEDIUM is reported, not blocked.
 * Requires: node + git on PATH. No jq.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). Mode (A) — the Claude Code PreToolUse hook — is
 * `check(ctx)`: it returns the verdict as data and writes no stdout. Mode (B), the git pre-push shim,
 * stays on the standalone path below, because git's ref protocol is not a Claude Code event and its
 * refusal is a nonzero exit rather than a decision document.
 *
 * ⛔ AND THE GIT RUNNER IS THE ONE THE CONTEXT CARRIES. `ctx.git` is a MEMOISED runner bound to one
 * repository: identical (args, absenceIsExpected) pairs inside one decision run git once, and the first
 * failure is recorded ON the runner (`git.failure`) rather than in a module-level variable. Module state
 * was correct for one process per hook and wrong the moment two checks share one — the second scan would
 * have inherited the first's "could not be inspected" and blocked on it.
 *
 * ⭐ P1-E-1b · EVERY HIGH HIT NAMES ITS SUBJECT, AND A DECLARED EXCEPTION CAN LIFT IT. Class A
 * (the class audit, "Declared exceptions to any guard") gives the founder
 * a fourth move for a subject already judged and accepted — the AWS documentation example key in a
 * README, say — beside disabling the guard, arguing with it, or rewriting the content. A HIGH hit's
 * subject is `{path, fingerprint}`: the file from the diff's `+++ b/` header (per-commit patches in push
 * mode carry those headers too) and `hooks/_exceptions.js`'s `fingerprint()` of the added line itself, so
 * the deny message prints the exact string a founder pastes into `respawnpack.config.json`. `ctx.exceptions`
 * resolves the declared list once per decision through a memoised getter beside `profile` — the precedent
 * `push-guard.js` set for its own posture read (see hooks/README.md, "The `check(ctx)` contract") — and
 * every hit is asked `allowed(resolved, 'secret-scan', subject)`. Every hit lifted: no deny, and a
 * `systemMessage` plus `additionalContext` name the exception and the reason. Some lifted and some not:
 * deny, naming only what still blocks and noting what was already lifted. A truncated scan or an
 * uninspectable range still denies regardless — an exception names a subject, never "could not look" — and
 * the `pre-push` shim (mode B) tells the same story on stderr. `context()`'s `profile` stays null: this
 * hook has no posture row and this task adds none; only the exceptions grammar reaches it.
 */
const { execFileSync } = require('child_process');
// ⛔ Fail closed: this guard blocks commits and pushes carrying secrets, so an unloadable parser denies
// rather than exiting nonzero — a non-blocking error would let the very operation it screens proceed.
const boot = require('./_boot.js');
boot.arm('deny');
const cmdlib = boot.need('./_cmd.js');
// The one reader of the founder's declared exceptions (P1-E-1a). Loaded through `need()` like every
// other shared dependency, so a module that will not load leaves this guard denying — never silently
// un-gated — the same fail-closed direction anti-drift item 27 states for a posture that cannot be read.
const exceptionsLib = boot.need('./_exceptions.js');

// Resolved per-invocation, never captured from process.cwd() alone: DOGFOOD.md DF-007 #6 lost a whole
// drift-check to a `cd` that had not persisted, so every subsystem grep returned 0 and read as a clean
// result. Anything crossing a repo boundary uses an explicit directory — which is now the directory the
// runner in `ctx.git` is BOUND to, so there is no ambient repo for a second check in the same process to
// change out from under the first.
const DEFAULT_REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, sev: 'HIGH', name: 'private key' },
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/, sev: 'HIGH', name: 'Stripe live secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, sev: 'HIGH', name: 'AWS access key id' },
  { re: /\baws_secret_access_key\b\s*[:=]/i, sev: 'HIGH', name: 'AWS secret access key' },
  { re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/, sev: 'HIGH', name: 'GitHub token' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/, sev: 'HIGH', name: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_\-]{30,}\b/, sev: 'HIGH', name: 'Google API key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, sev: 'MEDIUM', name: 'JWT' },
  { re: /(?:api[_-]?key|secret|password|passwd|token|client[_-]?secret)\s*[:=]\s*['"][^'"\n]{8,}['"]/i, sev: 'MEDIUM', name: 'generic secret assignment' },
];

// One git runner. execFileSync (never a shell string) so no argument can be re-interpreted, and always
// with an explicit cwd. stderr suppressed so an unset range (e.g. no @{push}) fails quiet.
//
// ⛔ maxBuffer IS LOAD-BEARING, NOT A TUNING KNOB. Left unset, execFileSync inherits Node's 1 MiB
// default, and `git show` on any commit with more than ~1 MiB of text diff overflows it. The overflow
// surfaces as ENOBUFS, which this runner reports as "could not be inspected" and the caller correctly
// treats as unclean — so the scanner did not permit a large commit, it became structurally unable to
// read one. Every commit over 1 MiB was blocked, permanently, with no finding and no path forward: an
// initial import of 1112 files (~48 MiB of diff) could not be pushed at all. A ceiling that no honest
// commit can clear is not a strict gate, it is a broken one, and the pressure it creates is to disable
// the hook — the opposite of what it exists to do. Raised so the scan can actually run on real commits.
// Still bounded rather than Infinity: a malformed or hostile range should exhaust the buffer and fail
// closed, not the heap.
const SCAN_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Build the one git runner a decision uses, bound to `repo`.
 *
 * MEMOISED on (args, absenceIsExpected): a repository does not move underneath one decision, so a
 * repeated inspection is the same answer at the cost of another process — and the dispatcher this
 * refactor is for (P4-T-15b) will hand this same runner to several checks at once.
 *
 * ⛔ THE FAILURE RECORD LIVES ON THE RUNNER, NOT IN THE MODULE. It used to be a module-level
 * `scanFailure`, which is exactly right for one process per hook and wrong for one process per event:
 * a second check would have inherited the first's "could not be inspected" and blocked a clean push on
 * it. `git.failure` is scoped to the runner, so it is scoped to the decision.
 */
function gitRunner(repo) {
  const seen = new Map();
  const run = (args, { absenceIsExpected = false } = {}) => {
    const key = `${absenceIsExpected ? 'A' : 'R'} ${args.join(' ')}`;
    if (seen.has(key)) return seen.get(key);
    let out;
    try { out = execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: SCAN_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) {
      if (!absenceIsExpected && !run.failure) {
        run.failure = `git ${args.slice(0, 3).join(' ')} could not be inspected (${(e && (e.code || e.status)) ?? 'unknown error'})`;
      }
      out = '';
    }
    seen.set(key, out);
    return out;
  };
  run.repo = repo;
  run.failure = null;
  return run;
}

const runDiff = (git, ...args) => git(['diff', '--no-color', '--no-ext-diff', ...args]);

/**
 * Every ADDED line in a diff, tagged with the path from the most recent `+++ b/<path>` header it
 * followed — the subject's other half, beside `fingerprint()`. Push mode concatenates one `git show` per
 * commit (`patchesForRevisions`); each file's own header pair precedes its hunks, so re-tracking `path`
 * at every header is correct across commits and across files in the same commit alike. The leading `+` is
 * stripped: it is a diff artifact, not part of the line the founder would recognise or paste back.
 */
function addedWithPath(diff) {
  const out = [];
  let currentPath = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      const m = /^\+\+\+ b\/(.+)$/.exec(l);
      currentPath = m ? m[1] : null; // /dev/null, or a header this pattern does not recognise
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) out.push({ path: currentPath, text: l.slice(1) });
  }
  return out;
}

const configuredMax = Number(process.env.RESPAWNPACK_SECRET_SCAN_MAX_COMMITS);
const MAX_SCANNED_COMMITS = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 200;

/*
 * ⛔ THE RANGE DEFECT THIS REPLACES. The old fallback chain ended at `HEAD~1..HEAD`, so on a NEW BRANCH
 * WITH NO UPSTREAM — the single most common shape for "about to push for the first time" — the scan saw
 * only the newest commit. A secret introduced three commits back shipped clean, and the hook reported
 * success. The behavioral harness pins exactly that case.
 *
 * What is actually about to be pushed:
 *   1. If the branch tracks something, `@{push}` / `@{upstream}` answer it exactly.
 *   2. Otherwise it is every commit not yet on ANY remote-tracking ref (`--not --remotes`). Scanning per
 *      commit (`git show`) rather than by range sidesteps the root-commit edge case, where `<oldest>^`
 *      does not exist.
 *   3. Nothing unpushed → fall back to the staged diff.
 * Bounded by MAX_SCANNED_COMMITS, and truncation BLOCKS rather than being silently absorbed — a partial
 * scan cannot be promoted to the clean bill of health this guard is asked to provide.
 */
function patchesForRevisions(git, state, revisionArgs) {
  const shas = git(['rev-list', `--max-count=${MAX_SCANNED_COMMITS + 1}`, ...revisionArgs])
    .split(/\r?\n/).filter(Boolean);
  if (!shas.length) return '';
  const scanned = shas.slice(0, MAX_SCANNED_COMMITS);
  if (shas.length > MAX_SCANNED_COMMITS) state.truncatedAt = Math.max(state.truncatedAt, MAX_SCANNED_COMMITS);
  return scanned.map((s) => git(['show', '--no-color', '--no-ext-diff', '--format=', s])).join('\n');
}

function pushDiffText(git, state, explicitRange, tip = 'HEAD', remoteName = null) {
  /*
   * Scan EACH commit, not only the aggregate endpoint diff. `base..tip` can look clean when one pushed
   * commit introduced a credential and a later commit deleted it; the secret still enters remote
   * history. Per-commit patches also handle root commits without manufacturing `<oldest>^`.
   */
  if (explicitRange) return patchesForRevisions(git, state, [explicitRange]);

  // Only the interactive hook is asking about HEAD. Git pre-push gives an exact local tip; consulting
  // HEAD's upstream for that case would silently scan a different branch.
  if (tip === 'HEAD') {
    for (const base of ['@{push}', '@{upstream}']) {
      if (git(['rev-parse', '--verify', '--quiet', base], { absenceIsExpected: true }).trim()) {
        return patchesForRevisions(git, state, [`${base}..HEAD`]);
      }
    }
  }

  const remoteSelector = remoteName ? `--remotes=${remoteName}` : '--remotes';
  const text = patchesForRevisions(git, state, [tip, '--not', remoteSelector]);
  if (text || git.failure || state.truncatedAt) return text;

  // A git-protocol tip with no commits new to that remote contributes no diff. Falling back to the
  // current index here would inspect unrelated worktree state and could block a clean ref push.
  return tip === 'HEAD' ? runDiff(git, '--cached') : '';
}

// The per-decision scan state. `truncatedAt > 0` ⇒ the scan did not cover everything, and the reason
// string must say so. Passed rather than module-scoped for the same reason `git.failure` is: one
// process may now answer for more than one check.
const newScanState = () => ({ truncatedAt: 0 });

function pushAddedLines(git, state, explicitRange, tip, remoteName) { return addedWithPath(pushDiffText(git, state, explicitRange, tip, remoteName)); }

/*
 * git's pre-push hook receives the refs being pushed on stdin, one per line:
 *   <local ref> <local sha> <remote ref> <remote sha>
 * An all-zero remote sha means the remote does not have this ref yet (a new branch). Ignoring this
 * protocol — as this hook previously did — throws away the only authoritative statement of what is
 * about to be sent.
 */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ZERO = /^(?:0{40}|0{64})$/;
function rangesFromRefProtocol(stdinText) {
  const ranges = [];
  let rows = 0;
  for (const line of String(stdinText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows += 1;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) return { ranges: [], rows, error: `malformed pre-push row ${rows}: expected four fields` };
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if ((!/^refs\//.test(localRef) && localRef !== '(delete)') || !/^refs\//.test(remoteRef)
        || !OBJECT_ID.test(localSha) || !OBJECT_ID.test(remoteSha)) {
      return { ranges: [], rows, error: `malformed pre-push row ${rows}: invalid ref or object id` };
    }
    if (ZERO.test(localSha)) continue; // branch deletion — nothing being added
    ranges.push(ZERO.test(remoteSha)
      ? { range: null, tip: localSha }
      : { range: `${remoteSha}..${localSha}`, tip: localSha });
  }
  return { ranges, rows, error: null };
}
// Commit: what this commit would record. Staged by default; staged+unstaged-tracked when -a/--all.
function commitAddedLines(git, allFlag) {
  return addedWithPath(allFlag ? runDiff(git, 'HEAD') : runDiff(git, '--cached'));
}
/** entries: [{path, text}] from `addedWithPath`. Every pattern match, tagged with what matched and where. */
function scan(entries) {
  const hits = [];
  for (const e of entries) for (const p of PATTERNS) if (p.re.test(e.text)) hits.push({ path: e.path, text: e.text, name: p.name, sev: p.sev });
  return hits;
}

/**
 * The distinct HIGH-severity hits, one per (path, fingerprint) — the subject vocabulary
 * `hooks/_exceptions.js` matches against. Two pattern matches on the same added line collapse to one
 * subject (a founder excepts a LINE, not a pattern name); the same line repeated in two files, or two
 * different lines, are two subjects and need two exceptions (or one path-scoped one).
 */
function highSubjects(hits) {
  const seen = new Map();
  for (const h of hits) {
    if (h.sev !== 'HIGH') continue;
    const fingerprint = exceptionsLib.fingerprint(h.text);
    const key = `${h.path || ''}#${fingerprint}`;
    if (!seen.has(key)) seen.set(key, { path: h.path || null, fingerprint, name: h.name });
  }
  return [...seen.values()];
}

/** Ask the declared exceptions about each HIGH subject once, and sort the answers into two piles. */
function partitionSubjects(subjects, resolved) {
  const lifted = [];
  const unlifted = [];
  for (const s of subjects) {
    const entry = exceptionsLib.allowed(resolved, 'secret-scan', { path: s.path, fingerprint: s.fingerprint });
    if (entry) lifted.push({ subject: s, entry }); else unlifted.push(s);
  }
  return { lifted, unlifted };
}

const describeSubject = (s) => `${s.name} in ${s.path || '(unknown path)'} (${s.fingerprint})`;
const listUnlifted = (unlifted) => unlifted.map(describeSubject).join('; ');

/** "allowed by exception <id> (secret-scan): <reason>", naming the declarer and the expiry when present. */
function allowedByText(entry) {
  const bits = [];
  if (entry.declaredBy) bits.push(`declared by ${entry.declaredBy}`);
  if (entry.expires) bits.push(`expires ${entry.expires}`);
  return `🔓 allowed by exception ${entry.id} (secret-scan): ${entry.reason}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}
const listLifted = (lifted) => lifted.map(({ subject, entry }) => `${allowedByText(entry)} — ${describeSubject(subject)}`);

/**
 * Appended to a deny reason when the declared list itself could not be used to lift anything —
 * UNREADABLE or INVALID. An exception that could not be read is never granted (`hooks/_exceptions.js`'s
 * own rule), and the founder reading this deny is told WHY nothing was lifted rather than left to guess
 * whether the config was ever consulted.
 */
function exceptionsCaveat(resolved) {
  return resolved && (resolved.source === 'INVALID' || resolved.source === 'UNREADABLE') ? ` Note: ${resolved.detail}` : '';
}

/**
 * The context this check reads. The scanned repository is `workDir` — `hook.cwd` when the host supplies
 * one, the project directory otherwise — and `ctx.git` is the memoised runner bound to it. `profile` is
 * null: `secret-scan` is in the anti-drift core's security column (item 25), fixed in every posture, so
 * this hook has never consulted a POSTURE declaration and this task adds none.
 *
 * ⛔ `exceptions` IS A LAZY GETTER, MIRRORING `push-guard.js`'s `profile` (ADR-003's precedent, carried
 * to Class A's grammar). Resolving it here, at context-build time, would move the one read of
 * `respawnpack.config.json` earlier than the point in the pass `check()` actually asks for it, and a
 * clean diff with nothing to except would pay for a declaration it never consults. The getter memoises,
 * so one decision still reads the file at most once, however many times `check()` touches `ctx.exceptions`
 * while building its verdict.
 */
function context(input) {
  const repo = (input && input.cwd) || DEFAULT_REPO;
  let resolvedExceptions;
  return {
    input: input || {},
    projectDir: DEFAULT_REPO,
    workDir: repo,
    principal: null,
    git: gitRunner(repo),
    profile: null,
    get exceptions() {
      if (resolvedExceptions === undefined) resolvedExceptions = exceptionsLib.resolve(DEFAULT_REPO);
      return resolvedExceptions;
    },
  };
}

/** The pure check — mode (A), the Claude Code PreToolUse hook. Returns the output as data, or null. */
function check(ctx) {
  const hook = ctx.input;
  // A malformed Claude envelope is not Git's ref protocol merely because it lacks an event name.
  // Degrade silently unless it is the PreToolUse event this hook actually handles.
  if (!hook || typeof hook !== 'object' || hook.hook_event_name !== 'PreToolUse') return null;

  const git = ctx.git;
  const state = newScanState();
  const cmd = (hook.tool_input && hook.tool_input.command) || '';
  // Structure-aware, shared with push-guard (hooks/_cmd.js): `git -C /repo push` is a push, and
  // `git commit -m "how git push works"` is not.
  const subs = cmdlib.gitSubcommands(cmd);
  const isPush = subs.includes('push');
  const isCommit = subs.includes('commit');
  const c = cmdlib.dequote(cmd);

  // Push takes precedence (a chained `commit && push` is scanned with the broader push ranges).
  if (isPush) {
    const subjects = highSubjects(scan(pushAddedLines(git, state)));
    // ⛔ THE ONE READ, TAKEN HERE ONLY WHEN THERE IS SOMETHING TO ASK ABOUT — a clean push never pays for
    // it, and `partitionSubjects([], anything)` is a no-op so `null` is safe when there is nothing to ask.
    const resolved = subjects.length ? ctx.exceptions : null;
    const { lifted, unlifted } = partitionSubjects(subjects, resolved);
    if (unlifted.length) {
      const reason = `HIGH-severity secret(s) in the diff: ${listUnlifted(unlifted)}. Remove them (and rotate if already committed) before pushing.`
        + (lifted.length ? ` Already lifted and not blocking: ${listLifted(lifted).join('; ')}.` : '')
        + exceptionsCaveat(resolved);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `🔒 push blocked — ${reason}`,
        },
      };
    }
    // ⛔ AN EXCEPTION CANNOT LIFT "COULD NOT LOOK". Truncation and an uninspectable range deny
    // regardless of how many (or how few) HIGH hits the partial scan found and how many of THOSE were
    // lifted — the subject an exception names is a line, never the absence of an answer.
    if (state.truncatedAt || git.failure) {
      const reason = state.truncatedAt
        ? `secret-scan reached its ${state.truncatedAt}-commit limit. Older commits in this push were NOT scanned, so the push cannot be called clean. Raise RESPAWNPACK_SECRET_SCAN_MAX_COMMITS or split and inspect the range.`
        : `secret-scan could not establish the pushed diff: ${git.failure}. An uninspectable range is not clean.`;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `🔒 push blocked — ${reason}`,
        },
      };
    }
    if (lifted.length) {
      // Every HIGH hit was lifted: no deny. `systemMessage` (user-visible) and `additionalContext`
      // (model-visible) carry the same lines — PreToolUse is the one event with both channels — so
      // neither the founder nor the agent that ran the command is left to wonder why nothing blocked.
      const msg = listLifted(lifted).join('\n');
      return { systemMessage: msg, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } };
    }
    return null;
  }

  if (isCommit) {
    const allFlag = /(?:^|\s)-[a-z]*a[a-z]*\b/i.test(c) || /\s--all\b/.test(c); // -a / -am / --all
    const subjects = highSubjects(scan(commitAddedLines(git, allFlag)));
    const resolved = subjects.length ? ctx.exceptions : null;
    const { lifted, unlifted } = partitionSubjects(subjects, resolved);
    if (unlifted.length) {
      const reason = `HIGH-severity secret(s) in the ${allFlag ? 'to-be-committed' : 'staged'} diff: ${listUnlifted(unlifted)}. Unstage and scrub them (git restore --staged <file>, delete the secret, rotate it if it was ever real), then commit.`
        + (lifted.length ? ` Already lifted and not blocking: ${listLifted(lifted).join('; ')}.` : '')
        + exceptionsCaveat(resolved);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `🔒 commit blocked — ${reason}`,
        },
      };
    }
    if (lifted.length) {
      const msg = listLifted(lifted).join('\n');
      return { systemMessage: msg, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } };
    }
    return null;
  }

  return null;
}

module.exports = { check, context };

// --- standalone entry point: mode (A) the Claude hook, mode (B) the git pre-push shim ---
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    let hook = null;
    let isJSON = false;
    try { hook = JSON.parse(raw); isJSON = true; } catch { /* not JSON → git pre-push mode */ }

    if (isJSON) {
      const verdict = check(context(hook));
      if (verdict) process.stdout.write(JSON.stringify(verdict));
      process.exit(0);
    }

    // git pre-push mode (non-JSON stdin) — inherently push-time. stdin carries git's ref protocol, which
    // is the authoritative statement of what is about to be sent; use it rather than guessing a range.
    const git = gitRunner(DEFAULT_REPO);
    const state = newScanState();
    const protocol = rangesFromRefProtocol(raw);
    if (protocol.error) {
      /* Git always invokes pre-push with remote-name and remote-location argv. With neither, malformed
       * non-JSON is a broken Claude envelope: exiting nonzero would be a non-blocking hook crash, not a
       * denial. The wrapper path has argv and therefore refuses malformed protocol rows below. */
      if (!process.argv[2]) process.exit(0);
      process.stderr.write(`\n🔒 RespawnPack secret-scan blocked this push — ${protocol.error}. An unparseable ref protocol cannot establish a clean range.\n`);
      process.exit(1);
    }
    const remoteName = process.argv[2] || null; // pre-push wrapper forwards git's target remote
    // Zero rows, or deletion-only rows, add no commit. Never fall back to unrelated HEAD/index state.
    const entries = protocol.ranges.flatMap((r) => pushAddedLines(git, state, r.range, r.tip, remoteName));
    const subjects = highSubjects(scan(entries));
    const resolved = subjects.length ? exceptionsLib.resolve(DEFAULT_REPO) : null;
    const { lifted, unlifted } = partitionSubjects(subjects, resolved);

    // Mode B has no JSON channel, so the same story — what still blocks, what was already lifted, why
    // the exceptions list itself may have lifted nothing — is told on stderr instead.
    if (unlifted.length) {
      const reason = `HIGH-severity secret(s): ${listUnlifted(unlifted)}\n   Remove them (and rotate if committed) before pushing.`
        + (lifted.length ? `\n   Already lifted and not blocking: ${listLifted(lifted).join('; ')}.` : '')
        + exceptionsCaveat(resolved);
      process.stderr.write(`\n🔒 RespawnPack secret-scan blocked this push — ${reason}\n`);
      process.exit(1);
    }
    // An exception cannot lift "could not look" — truncation and an uninspectable range still block,
    // even when every HIGH hit the partial scan did find was lifted.
    if (state.truncatedAt) {
      process.stderr.write(`\n🔒 RespawnPack secret-scan blocked this push — only the newest ${state.truncatedAt} commit(s) were scanned; older pushed commits were NOT inspected. Raise RESPAWNPACK_SECRET_SCAN_MAX_COMMITS or split and inspect the range.\n`);
      process.exit(1);
    }
    if (git.failure) {
      process.stderr.write(`\n🔒 RespawnPack secret-scan blocked this push — ${git.failure}. An uninspectable range is not clean.\n`);
      process.exit(1);
    }
    // Every HIGH hit was lifted: exit 0 (nothing blocks), but the allowance is still printed rather
    // than swallowed — the shim's own "nothing is silent" half of the mechanism.
    if (lifted.length) process.stderr.write(`\n${listLifted(lifted).join('\n')}\n`);
    process.exit(0);
  });
}

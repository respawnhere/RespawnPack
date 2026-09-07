#!/usr/bin/env node
/*
 * RespawnPack · push-guard.js — PreToolUse hard-block hook that mechanizes "push is authorized, never
 * automatic" (skills/README.md principle 7). Today only secret-scan.js's content-based check blocks a
 * push — an unauthorized-but-clean push otherwise sails through on nothing but the model reading its own
 * prose rule. This closes that gap. Concept credited to mattpocock/skills' git-guardrails-claude-code
 * (MIT) — pattern re-derived in RespawnPack's own file shape (see ATTRIBUTION.md).
 *
 * Wire as a PreToolUse hook matching Bash (see settings.snippet.json). Two tiers:
 *   1. `git push` (incl. `--force`/`--force-with-lease`) — DENIED unless a single-use marker exists:
 *      <project>/.respawnpack/push.allowed. `/ship` writes it at the moment a human gives the go-ahead
 *      (Step 2); this hook consumes (deletes) it the instant it allows one push. One marker, one push.
 *   2. `git reset --hard` / `git clean -f`|`-fd` / `git branch -D` / `git checkout .` / `git restore .` —
 *      DENIED unconditionally. No marker lifts these: RespawnPack's flows have no legitimate autonomous
 *      use for them, unlike an authorized push. Escape hatch is the same one every hook here relies on:
 *      delete/disable the hook (or edit settings.json) if you need to run one of these yourself.
 *
 * ⭐ POSTURE (ADR-003). Tier 1 is `push-guard:tier1`: `off` under `light`, `deny` under `standard` and
 * `strict`. Tier 2 is `push-guard:tier2` and is FIXED in every posture — the anti-drift core's security
 * column — so it is never routed through the resolver at all. Under `light` a `git push` therefore
 * exits 0 in silence and no marker is consumed; `git reset --hard` is denied exactly as it is today.
 *
 * ⭐ AND TIER 2 ACCEPTS A DECLARED EXCEPTION ON ONE COMMAND (P1-E-1d). A posture OVERRIDE would move the
 * rule for every command and is refused on this id; an EXCEPTION names one command line by fingerprint,
 * with a reason, in the tracked config, and the guard prints that it lifted. Tier 2 keeps denying
 * everything else, and tier 1 has no subject notion, so nothing here can except a push.
 *
 * Mint the marker manually:  node .claude/hooks/push-guard.js --allow-next
 * Clear it unused:           node .claude/hooks/push-guard.js --clear
 * Status:                    node .claude/hooks/push-guard.js --status
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input:{command}, cwd}.
 * Deny = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}} + exit 0.
 * Allow (marker consumed) = stdout JSON {hookSpecificOutput:{hookEventName,permissionDecision:"allow",permissionDecisionReason}} + exit 0.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy and returns the verdict
 * as data; the standalone path below builds the context from stdin and the environment and prints it.
 * The posture arrives as `ctx.profile` and is still taken at the SAME point in the pass it always was —
 * the getter behind it memoises, so one invocation is still one reading of the declaration. See
 * hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');
// ⛔ Fail closed: this guard decides whether a push may proceed, so an unloadable parser denies rather
// than exiting nonzero — which the host would treat as a non-blocking error and push anyway.
const boot = require('./_boot.js');
boot.arm('deny');
const cmdlib = boot.need('./_cmd.js');
/*
 * ⛔ THE POSTURE READER, AND ONLY TIER 1 IS ALLOWED TO ASK IT ANYTHING (ADR-003, P3-T-10b).
 * `push-guard:tier1` — the marker-gated push below — is `off` under `light` and `deny` under
 * `standard` and `strict`. `push-guard:tier2`, the unconditional destructive-git set, is in the
 * anti-drift core's SECURITY COLUMN (item 25) and is fixed in every posture: `hooks/_posture.js` has no
 * key for it, its id is never passed to the resolver, and the branch that denies it runs BEFORE any
 * verdict is consulted, so no declaration and no override can reach it.
 *
 * Reached through `need()` like every other shared dependency: this guard is armed `deny`, so a posture
 * reader that will not load leaves the guard denying rather than silently un-gating a push, which is
 * the same fail-closed direction anti-drift item 27 states for a posture that cannot be READ.
 */
const posture = boot.need('./_posture.js');
/*
 * ⛔ AND THE EXCEPTION READER COMES THROUGH THE SAME BOUNDARY, FOR THE OPPOSITE-LOOKING REASON.
 * `_posture.js` must not fail into a looser rule; `_exceptions.js` must not fail into a LIFT. Both are
 * the same direction: this guard is armed `deny`, so a reader that will not load leaves tier 2
 * refusing exactly as it does today rather than silently excusing one destructive command (anti-drift
 * item 27). Tier 2 stays `deny` for every command the founder has not named (item 25).
 */
const exceptionsLib = boot.need('./_exceptions.js');

/** The one rule id this hook may ask `_exceptions.js` about. Tier 1 has no subject and is not here. */
const RULE = 'push-guard:tier2';

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

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const markerFile = path.join(projectDir, '.respawnpack', 'push.allowed');
const consumedFile = path.join(projectDir, '.respawnpack', 'push.consumed');

// ⛔ DETECTION MOVED OFF SUBSTRING MATCHING. The old `/\bgit\s+push\b/` failed in both directions, and
// the behavioral harness caught both: it MISSED `git -C /repo push` and `git --no-pager push` (a global
// option between `git` and its subcommand), and it DENIED `grep -r "git push" docs/` and
// `git commit -m "explain how git push works"` (a mention, not an invocation). hooks/_cmd.js classifies
// on command structure instead — see its header for why this is the DF-007 lesson wearing a new hat.

// Unconditionally-denied destructive ops — no marker gate, matching mattpocock's own design for these.
// Each is matched against a segment that has ALREADY been confirmed to invoke that git subcommand, so a
// quoted mention can no longer reach these patterns.
const UNCONDITIONAL = [
  { sub: 'reset', re: /(?:^|\s)--hard(?:\s|$)/, label: 'git reset --hard' },
  { sub: 'clean', re: /(?:^|\s)(?:-\w*f\w*|--force)(?:\s|$)/, label: 'git clean -f/-fd' },
  { sub: 'branch', re: /(?:^|\s)-\w*D(?:\s|$)/, label: 'git branch -D' },
  { sub: 'checkout', re: /(?:^|\s)(?:--\s+)?\.(?:\s|$)/, label: 'git checkout .' },
  { sub: 'restore', re: /(?:^|\s)\.(?:\s|$)/, label: 'git restore .' },
];

// A previously-authorized push that FAILED (network, auth, rejected non-fast-forward) used to burn its
// marker on the first attempt, so the retry was denied and the human had to re-authorize a push they had
// already approved. The marker is now moved aside rather than deleted, and an identical retry inside
// this window is honored. Bounded deliberately: same command, same session, short window — a retry, not
// a second push.
const RETRY_GRACE_MS = Number(process.env.RESPAWNPACK_PUSH_RETRY_GRACE_MS) || 10 * 60 * 1000;

/*
 * ⛔ "COULD NOT READ THE POLICY" IS SAID OUT LOUD — ON stderr, NEVER INTO THE DECISION.
 *
 * An UNREADABLE or INVALID declaration already resolves to `strict` inside `_posture.js`, so the
 * DECISION is byte-for-byte the decision a project with no declaration at all gets, which is what makes
 * "strict is today" checkable for a target whose config someone has just broken. That leaves the fact
 * itself needing somewhere to go, because a run that quietly fell back is indistinguishable from a run
 * that was told to be strict. stderr is where it goes: it is the channel `_boot.js` already uses to
 * report a hook running in a degraded state, it reaches the operator's transcript, and it cannot
 * perturb the `permissionDecisionReason` the model reads. A DECLARED or DEFAULTED resolution says
 * nothing at all — there is nothing wrong to report.
 */
function sayIfUnreadable(resolved) {
  if (resolved.source !== 'UNREADABLE' && resolved.source !== 'INVALID') return;
  try { process.stderr.write(`RespawnPack push-guard: ${resolved.detail}\n`); } catch { /* stderr is gone; the decision below is what matters */ }
}

/**
 * The context this check reads.
 *
 * ⛔ `profile` IS A LAZY GETTER, AND THAT IS WHAT KEEPS THE RESOLUTION WHERE IT WAS. Resolving it here,
 * at context-build time, would move the one read of `respawnpack.config.json` to a different point in
 * the pass than the one the rule was written at — and a hook that also answers a non-Bash call would
 * read a declaration it never consults. The getter memoises, so the read still happens exactly once,
 * exactly where `check()` asks for it.
 */
function context(input) {
  let stance;
  let declared;
  return {
    input: input || {},
    projectDir,
    workDir: (input && input.cwd) || projectDir,
    principal: null,
    git: null,
    get profile() {
      if (stance === undefined) stance = posture.resolve(projectDir);
      return stance;
    },
    /*
     * ⛔ A SECOND LAZY GETTER, NOT A SECOND READ OF THE SAME QUESTION. The posture answers "what verdict
     * does this rule have"; the exceptions answer "has the founder named THIS subject". They are
     * different questions with different fail-closed directions, they are read by different modules, and
     * collapsing them into one resolution would make an unreadable posture silently decide an allowance
     * too. Both memoise, so one invocation still takes one reading of each.
     */
    get exceptions() {
      if (declared === undefined) declared = exceptionsLib.resolve(projectDir);
      return declared;
    },
  };
}

/** The pure check. Returns this hook's PreToolUse output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};
  if (input.tool_name !== 'Bash') return null;
  const cmd = (input.tool_input && input.tool_input.command) || '';

  /*
   * ⛔ ONE RESOLUTION PER INVOCATION, TAKEN HERE — the position the pack's other guards take their
   * `.respawnpack/<hook>.off` marker check (this one has no marker; the guard it carries is not one a
   * subagent may switch off from inside the project). Resolving per RULE would let one hook invocation
   * answer from two reads of a file that can change between them, which is a second reader of the same
   * policy wearing a disguise. `ctx.profile` memoises, so the reading is taken here and only here.
   */
  const stance = ctx.profile;

  // Structure-aware classification: which git subcommands does this command line actually invoke?
  const segs = cmdlib.segments(cmd).map((s) => ({ seg: s, sub: cmdlib.gitSubcommand(s) })).filter((x) => x.sub);

  const hit = UNCONDITIONAL.find((p) => segs.some((s) => s.sub === p.sub && p.re.test(s.seg)));
  if (hit) {
    /*
     * ⛔ STILL BEFORE ANY VERDICT IS CONSULTED, AND THE EXCEPTION DOES NOT CHANGE THAT. `push-guard:tier2`
     * is in the security column: `_posture.js` has no key for it, this branch asks the resolver nothing,
     * and it runs above tier 1's `verdict()` call exactly as it always has. What an exception moves is
     * the SUBJECT, not the rule: one reviewed command line, named by the fingerprint this deny prints,
     * declared in the tracked founder-owned config. Every other destructive git command still lands here.
     */
    const fingerprint = exceptionsLib.fingerprint(cmdlib.dequote(cmd));
    const resolved = ctx.exceptions;
    const lift = exceptionsLib.allowed(resolved, RULE, { command: fingerprint });
    if (lift) return lifted(lift);

    const reason =
      `🔒 push-guard blocked "${hit.label}" — this destructive op has no legitimate autonomous use in ` +
      `RespawnPack's flows and is always denied. If you genuinely need to run it yourself, disable this ` +
      `hook (delete its entry from .claude/settings.json) and run it directly.\n` +
      `Command fingerprint: ${fingerprint}. To except THIS command and nothing else, add to ` +
      `respawnpack.config.json: {"id": "<a name>", "rule": "${RULE}", "match": {"command": "${fingerprint}"}, ` +
      `"reason": "<why you reviewed and accepted it>"}. Tier 1 (the marker-gated push) is untouched by ` +
      `it, and every other destructive command stays denied.${refusedNote(resolved)}`;
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  }

  if (segs.some((s) => s.sub === 'push')) {
    /*
     * ⛔ TIER 1, AND THE VERDICT IS TAKEN BEFORE THE MARKER IS TOUCHED. `off` means silent exit 0: the
     * rule does not apply, so it neither denies nor ALLOWS, and it must not consume an authorization
     * marker on its way past. A rule that spent the founder's single-use go-ahead while declining to
     * judge the push would leave the next push — the one a tighter posture WOULD judge — unauthorized
     * for a reason nobody could see.
     */
    sayIfUnreadable(stance);
    if (posture.verdict(stance, 'push-guard:tier1') === 'off') return null;

    const allow = (why) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: why },
    });

    if (fs.existsSync(markerFile)) {
      // Move the marker aside instead of deleting it, so an authorized push that FAILS can be retried
      // without a fresh human go-ahead. One authorization still buys one push — only retries of the
      // same command, inside RETRY_GRACE_MS, ride the record.
      try {
        const at = Date.now();
        fs.writeFileSync(consumedFile, JSON.stringify({ at, firstAt: at, cmd, session: input.session_id || null }));
        fs.unlinkSync(markerFile);
      } catch { /* marker already gone — still allow this one push */ }
      return allow('push-guard: authorization marker consumed — this push is allowed. The next push will need a fresh go-ahead (an identical retry within the grace window is honored).');
    }

    /*
     * ⛔ TWO WAYS THIS ONCE EXCEEDED THE BOUND IN ITS OWN COMMENT, both found by the final truth audit.
     *   (1) The comment above says "same session" and the code never read it. `session` was WRITTEN into
     *       push.consumed and never compared, so a byte-identical `git push` from ANY session — another
     *       agent, another window, a cron — rode a human go-ahead given somewhere else entirely.
     *   (2) The window SLID: every honored retry rewrote `at: Date.now()`, so an identical push could be
     *       repeated forever at sub-grace intervals off one authorization. `firstAt` is now fixed at the
     *       moment of consumption and the comparison never moves, so the grace is a window, not a lease
     *       that renews itself. A retry is a retry of one authorized push; it is not a standing permit.
     * ⛔ AND A MISSING SESSION ID DISQUALIFIES THE RECORD. The first version of this comment claimed
     * "absent === absent is required", which is a description of `null === null` — i.e. of a record
     * written before this field existed being ACCEPTED, which is the opposite of what the sentence
     * meant. Measured: a legacy `{at, cmd}` stamp plus an input with no session_id was allowed. A retry
     * now requires a real session id on BOTH sides, so a pre-field marker falls through to the deny.
     */
    const consumed = (() => { try { return JSON.parse(fs.readFileSync(consumedFile, 'utf8')); } catch { return null; } })();
    const sameSession = Boolean(consumed && consumed.session && input.session_id && consumed.session === input.session_id);
    const firstAt = consumed ? Number(consumed.firstAt ?? consumed.at) : 0;
    if (consumed && consumed.cmd === cmd && sameSession && Date.now() - firstAt < RETRY_GRACE_MS) {
      try { fs.writeFileSync(consumedFile, JSON.stringify({ ...consumed, firstAt, at: Date.now(), retries: (consumed.retries || 0) + 1 })); } catch { /* best effort */ }
      return allow('push-guard: identical retry of an already-authorized push inside the grace window — allowed without re-authorization.');
    }
    // True when a matching authorization exists but this host gave us no session to scope it to.
    const consumedFileHasNoSession = Boolean(consumed && consumed.cmd === cmd && (!consumed.session || !input.session_id));
    const reason =
      `🔒 push-guard blocked this push — "push is authorized, never automatic" (skills/README.md principle 7) ` +
      `has no marker on file. Run /ship, which mints the marker at the moment a human gives the explicit ` +
      `go-ahead, or mint it yourself: node .claude/hooks/push-guard.js --allow-next` +
      /*
       * ⛔ WHY THE RETRY DID NOT SAVE YOU, SAID OUT LOUD. Tying the grace window to a session closed a
       * real hole (any session could ride another's go-ahead) and, on a host that does not supply
       * `session_id`, it silently kills the retry path that window exists for — so an authorized push
       * that fails on the network asks for a fresh human go-ahead, which is the behaviour the window was
       * added to end. `session_id` is not in `_harness.mjs`'s UNIVERSAL_FIELDS, so the pack's own hook
       * contract does not promise it. A silent regression here reads as "the guard is broken" and gets
       * the hook deleted; naming it costs one sentence and keeps the deny honest.
       */
      (consumedFileHasNoSession
        ? `\n\nNote: an authorization was consumed recently for this exact command, but this host did not ` +
          `supply a session id, and the retry grace window is scoped to one session on purpose. Mint a ` +
          `fresh marker to retry.`
        : '');
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  }

  return null;
}

module.exports = { check, context };

// --- standalone entry point: CLI helpers, then PreToolUse JSON on stdin ---
if (require.main === module) {
  // --- CLI helpers (mint/clear/status the single-use marker) ---
  const arg = process.argv[2];
  if (arg === '--allow-next') {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, new Date().toISOString() + '\n');
    console.log('push-guard: next `git push` is authorized (single-use — consumed automatically on that push).');
    process.exit(0);
  }
  if (arg === '--clear') {
    try { fs.unlinkSync(markerFile); console.log('push-guard: marker cleared (next push is unauthorized again).'); }
    catch { console.log('push-guard: no marker was set.'); }
    process.exit(0);
  }
  if (arg === '--status') {
    console.log(fs.existsSync(markerFile) ? 'push-guard: a push authorization marker is set (will be consumed by the next push attempt).' : 'push-guard: no marker set — the next `git push` will be denied.');
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

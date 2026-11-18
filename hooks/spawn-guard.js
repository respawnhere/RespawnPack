#!/usr/bin/env node
/*
 * RespawnPack · spawn-guard.js — advisory-first spawn-concurrency circuit breaker. Mechanizes
 * skills/README.md principle 4 ("moderate concurrency... ~13 subagents throttled, stay single-digit")
 * instead of leaving it a number the orchestrator has to remember under pressure. Concept credited to
 * ColeMurray/background-agents' spawn-depth/concurrency guardrails (MIT) — reframed for a session with
 * no server to enforce anything (see ATTRIBUTION.md).
 *
 * Wire as BOTH a PreToolUse hook (matcher Agent|Task — Claude Code has used both tool names across
 * versions for subagent dispatch) and a SubagentStop hook (see settings.snippet.json).
 *   PreToolUse/Agent|Task: increments a session-scoped in-flight counter,
 *     <project>/.respawnpack/spawn-state-<session_id>.json. Past CEILING (default 8) it does NOT deny —
 *     it returns an additionalContext advisory. A hard deny is opt-in only, via
 *     <project>/.respawnpack/spawn-guard.strict (see --strict-on/--strict-off below): the dogfood run's
 *     own value came from firing 2-3 parallel agents per wave, and a miscalibrated hard cap would break
 *     that on day one.
 *   SubagentStop: decrements the same counter.
 * Crash safety: a counter file older than STALE_MS is treated as 0 before incrementing — a parent session
 * killed mid-wave (so SubagentStop never fires to decrement) must never permanently wedge a future session.
 * The staleness clock is refreshed on every SubagentStop as well as every dispatch, so a wave of genuinely
 * long-running agents keeps its own counter alive instead of being reset out from under itself.
 *
 * ⛔ AND A THIRD, FOUND IN M.1c: THE COUNTER WAS KEYED ON THE WORKING DIRECTORY, NOT THE PROJECT.
 * `input.cwd` is wherever the tool call happened to run, so one session produced one counter per
 * directory it worked in: two dispatches from `repo/sub` incremented `repo/sub/.respawnpack/...` while
 * the SubagentStop that ended one landed in `repo/other/...`, and index-guard — which reads the project
 * root — saw no wave in flight at all while three agents were running. The strict marker had the same
 * shape: a ceiling declared at the root simply did not apply from any subdirectory. Both now resolve
 * through `_runtime.projectRoot()`, which is the same root index-guard reads, so there is exactly one
 * counter and one marker per project.
 *
 * ⛔ TWO ACCOUNTING DEFECTS CORRECTED HERE.
 *   1. The old code wrote the incremented count and THEN decided. In strict mode the dispatch was denied
 *      — the agent never started — but the counter kept the increment, so every denial permanently
 *      ratcheted the effective ceiling down. Enough denials and no dispatch could ever succeed again.
 *      A denial must cost nothing: decide first, persist only on allow.
 *   2. read → modify → write with nothing between the read and the write. Concurrent dispatches (the
 *      exact thing this hook exists to count) interleave and lose updates, so the counter undercounts
 *      precisely when it matters. The whole read-decide-write is now inside an exclusive file lock
 *      (_runtime.withLock).
 *
 * Toggle strict mode:  node .claude/hooks/spawn-guard.js --strict-on | --strict-off | --status
 *
 * ⭐ POSTURE (owner decision 26, P1-I-1). `spawn-guard:ceiling` was a resolver row `hooks/README.md`
 * used to call "wired and read by no hook" — present in `hooks/_posture.js`'s table, consulted by
 * nothing. It is read now, beside the marker check above: a DECLARED `strict` posture makes the ceiling
 * a hard deny with no marker required; `light`/`standard` keep today's advisory. The marker only ever
 * TIGHTENS — present, it forces deny under any posture — and can never loosen a declared strict back to
 * advisory.
 * ⛔ DEFAULTED, UNREADABLE AND INVALID DO NOT REACH THE NEW DENY PATH, THOUGH `_posture.js` RESOLVES ALL
 * THREE TO `strict` INTERNALLY. That resolution is `_posture.js`'s own fail-closed/migration answer for
 * readers whose `strict` column already WAS today's unconfigured behaviour (push-guard's tier 1, for
 * one). This hook's `strict` column is not that: its two-mode toggle (advisory by default, hard-deny
 * only behind the marker) predates any posture concept, so today's actual unconfigured behaviour is
 * advisory, not deny. Honoring DEFAULTED here would silently ratchet every never-configured target's
 * ceiling to a hard deny the day it upgrades — the exact drift the migration guarantee forbids — so only
 * a genuine DECLARED resolution tightens the ceiling; the other three sources fall back to exactly
 * today's marker-only behaviour. An UNREADABLE or INVALID declaration still says so on stderr.
 *
 * Contract (Claude Code hooks): stdin = hook JSON {hook_event_name, session_id, tool_name, ...}.
 * Advisory = stdout {hookSpecificOutput:{hookEventName,additionalContext}} + exit 0 (never blocks).
 * Strict deny = stdout {hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}}.
 *
 * ⭐ TWO ENTRY POINTS, ONE DECISION (P4-T-15a). `check(ctx)` is the whole policy — both the PreToolUse
 * increment and the SubagentStop decrement — and it returns the verdict as data. It is PURE in the sense
 * the fence means: no stdout, no exit. It still writes the counter and the wave ledger, because those
 * ARE the hook's behaviour and a refactor that dropped them would be a different hook.
 * See hooks/README.md, "The `check(ctx)` contract".
 */
const fs = require('fs');
const path = require('path');
// ⛔ Fail closed: strict mode refuses dispatch on an unestablished count, and machinery that will not
// load is the strongest possible "unestablished". Denying keeps that promise instead of exiting 1.
const boot = require('./_boot.js');
boot.arm('deny');
const rt = boot.need('./_runtime.js');
/*
 * ⛔ THE POSTURE READER (owner decision 26, P1-I-1). Reached through `need()` like every other shared
 * dependency: this guard is armed `deny`, so a posture reader that will not load leaves the guard
 * denying rather than silently un-gating a ceiling nobody could establish — the same fail-closed
 * direction anti-drift item 27 states for a posture that cannot be READ.
 */
const posture = boot.need('./_posture.js');

// The CLI toggles below resolve the same canonical root the hook path does, so `--strict-on` run from
// a subdirectory declares the ceiling the hook will actually read.
const projectDir = rt.projectRoot(null);
const stateDir = path.join(projectDir, '.respawnpack');
const strictFile = path.join(stateDir, 'spawn-guard.strict');
const CEILING = Number(process.env.RESPAWNPACK_SPAWN_CEILING) || 8;
// 30 minutes — see the crash-safety note above. Defined in _runtime.js so index-guard reads this
// counter with the SAME window, rather than inventing a second opinion about what "in flight" means.
const STALE_MS = rt.SPAWN_STALE_MS;

/*
 * ⛔ "COULD NOT READ THE POLICY" IS SAID OUT LOUD — ON stderr, NEVER INTO THE DECISION. An UNREADABLE or
 * INVALID declaration resolves to `strict` inside `_posture.js`, and this hook treats that resolution
 * exactly as it treats DEFAULTED (see the header): the marker remains the only thing that can tighten it.
 * The fact that the config could not be read is still real and still has to go somewhere, so it goes to
 * the channel `_boot.js` already uses to report a hook running degraded, where it cannot alter the
 * decision.
 */
function sayIfUnreadable(resolved) {
  if (resolved.source !== 'UNREADABLE' && resolved.source !== 'INVALID') return;
  try { process.stderr.write(`RespawnPack spawn-guard: ${resolved.detail}\n`); } catch { /* stderr is gone */ }
}

function counterPath(sessionId, dir) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir || projectDir, '.respawnpack', `spawn-state-${safe}.json`);
}

/*
 * Reads the current in-flight count as an EXPLICIT verdict.
 *
 * ⛔ ABSENT AND CORRUPT ARE DIFFERENT FACTS. The old reader caught everything and returned 0, so an
 * unreadable or garbled counter spelled "nothing in flight". That is a defensible default for the
 * advisory mode, whose only job is to print a number, and it defeats STRICT mode entirely: strict is
 * the owner explicitly choosing a hard ceiling, and silently allowing a dispatch whose count could not
 * be established is exactly the policy they turned off.
 *
 * A MISSING file genuinely is zero (nothing dispatched yet), and a STALE one self-heals to zero by
 * design — a parent killed mid-wave must never wedge a future session (see the crash-safety note above).
 */
function readCountState(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'PASS', count: 0 };
    return { status: 'CANNOT_DETERMINE', reason: `the counter file could not be opened (${e.code || e.message})` };
  }
  if (Date.now() - stat.mtimeMs > STALE_MS) return { status: 'PASS', count: 0 };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { status: 'CANNOT_DETERMINE', reason: `the counter file is corrupt or unreadable (${e.code || 'CORRUPT'})` }; }
  const n = Number(data && data.count);
  if (!Number.isFinite(n)) return { status: 'CANNOT_DETERMINE', reason: 'the counter file holds no usable count' };
  return { status: 'PASS', count: Math.max(0, n) };
}

function writeCount(file, count) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ count: Math.max(0, count), updatedAt: new Date().toISOString() }));
}

/**
 * The context this check reads. `projectDir` is `rt.projectRoot(input)` — the canonical root, not the
 * working directory (see the header: a per-cwd counter is three counters for one wave).
 *
 * ⛔ `profile` IS A LAZY GETTER THAT MEMOISES, mirroring push-guard's own — the ceiling check is the only
 * branch that ever asks (SubagentStop never does), so a getter keeps the one read of
 * `respawnpack.config.json` at the exact point in the pass `check()` asks for it, never earlier.
 */
function context(input) {
  const root = rt.projectRoot(input || {});
  let stance;
  return {
    input: input || {},
    projectDir: root,
    workDir: (input && input.cwd) || root,
    principal: null,
    git: null,
    get profile() {
      if (stance === undefined) stance = posture.resolve(root);
      return stance;
    },
  };
}

/** The pure check. Returns this hook's output as data, or null. */
function check(ctx) {
  const input = ctx.input || {};

  // ⛔ THE PROJECT ROOT, never the working directory. See the header: a per-cwd counter is three
  // counters for one wave, and index-guard reads none of them.
  const dir = ctx.projectDir;
  const file = counterPath(input.session_id, dir);

  if (input.hook_event_name === 'SubagentStop') {
    // An unestablished lock simply skips the decrement; a stale counter self-heals via STALE_MS. A
    // counter that cannot be read is left alone rather than reset — resetting it would be a guess.
    rt.withLock(file, () => {
      const state = readCountState(file);
      if (state.status === 'PASS') writeCount(file, state.count - 1);
    });
    return null;
  }

  /*
   * ⛔ THE CRASH-SAFETY NET WAS ITSELF ENTIRELY MANUAL.
   *
   * CLAUDE.md and skills/README.md both say: "Running work in parallel? Keep a
   * `.respawnpack/wave-ledger.md` so a compaction or crash can't lose the thread." The the 2026-08-07 field run
   * (2026-08-07, §7) pointed out that nothing created or maintained it — the designated recovery
   * artifact for exactly the situations where the working tree is at risk existed only if somebody
   * remembered to write it, under precisely the conditions (long fan-out, filling context) that make
   * remembering least likely. A recovery artifact you have to remember to create is one you will not
   * have when you need it.
   *
   * This hook is already the one place that sees every dispatch, already knows the project root, and
   * already runs under a lock — so it is the one place that can record the wave without being asked.
   * `/respawn` rehydrates the ledger and `/savepoint` folds and deletes it; both already work, and
   * neither ever had a reliable writer.
   *
   * ⛔ IT STAYS IN `.respawnpack/` (gitignored) ON PURPOSE. The dogfood offered "put it somewhere
   * tracked" as an alternative; that would make mid-run scratch a tracked artifact and put a
   * half-finished wave into every commit and diff. The ledger's permanent home is the derived docs
   * `/savepoint` folds it into — so the fix is a writer, not a new location.
   *
   * ⛔ AND IT CANNOT AFFECT THE DECISION. Best-effort, after the count is persisted, wrapped whole: a
   * ledger that fails to write must never deny a dispatch or change what this hook reports.
   */
  function appendLedger(projectDir, hookInput, inFlight) {
    try {
      const ti = hookInput.tool_input || {};
      const type = String(ti.subagent_type || hookInput.tool_name || 'agent').slice(0, 60);
      const what = String(ti.description || ti.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const ledger = path.join(projectDir, '.respawnpack', 'wave-ledger.md');
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      if (!fs.existsSync(ledger)) {
        fs.writeFileSync(ledger,
          '# Wave ledger\n\n' +
          '> Auto-appended by `.claude/hooks/spawn-guard.js` on every subagent dispatch, so a compaction or\n' +
          '> crash mid-wave is resumable. `/respawn` rehydrates this. `/savepoint` folds an untracked ledger\n' +
          '> into the derived docs and deletes it, because it is mid-run scratch, never a second source of\n' +
          '> truth. A tracked ledger is left alone and reported NOT_APPLICABLE.\n' +
          '>\n' +
          '> Dispatch lines are written automatically. **Outcomes are not** — nothing here observes what an\n' +
          '> agent returned, so add the result yourself as you land each one. A dispatch line with no outcome\n' +
          '> beside it means "started, fate unrecorded", which is exactly what a resume needs to know.\n\n');
      }
      fs.appendFileSync(ledger,
        `- \`${new Date().toISOString()}\` · dispatch #${inFlight} in flight · **${type}**` +
        `${what ? ` — ${what}` : ''}${hookInput.session_id ? ` · session ${String(hookInput.session_id).slice(0, 8)}` : ''}\n`);
    } catch { /* best-effort only — never affects the dispatch decision */ }
  }

  if (input.hook_event_name === 'PreToolUse' && /^(Agent|Task)$/.test(input.tool_name || '')) {
    const strict = fs.existsSync(path.join(dir, '.respawnpack', 'spawn-guard.strict'));

    /*
     * ⛔ ONE RESOLUTION PER INVOCATION, TAKEN HERE — BESIDE THE MARKER CHECK ABOVE (owner decision 26,
     * P1-I-1), the position the pack's other guards take their `.respawnpack/<hook>.off` marker check.
     * See the header for why a DECLARED source is required to act on a `deny` verdict here, and why
     * DEFAULTED/UNREADABLE/INVALID are not: all three resolve `_posture.js`'s own `profile` to `strict`,
     * but only a founder who actually wrote the key has tightened anything — the other three keep this
     * hook's original marker-only ceiling exactly as it always behaved.
     */
    const stance = ctx.profile;
    sayIfUnreadable(stance);
    const ruleVerdict = posture.verdict(stance, 'spawn-guard:ceiling');
    const postureDenies = stance.source === 'DECLARED' && ruleVerdict === 'deny';
    // The marker only ever TIGHTENS: it can turn a declared light/standard `advise` into `deny`, and it
    // is the ONLY thing that can do so for DEFAULTED/UNREADABLE/INVALID. Neither direction ever loosens
    // a declared strict back to advisory — there is nothing here that clears `postureDenies`.
    const denyMode = strict || postureDenies;
    const denyModeNamed = () => {
      const parts = [];
      if (postureDenies) parts.push(`the declared posture (\`${stance.profile}\`) resolves spawn-guard:ceiling to deny`);
      if (strict) parts.push('.respawnpack/spawn-guard.strict is present');
      return parts.join(' and ');
    };
    const denyModeEscape = () => {
      const parts = [];
      if (strict) parts.push('run "node .claude/hooks/spawn-guard.js --strict-off" to clear the marker');
      if (postureDenies) parts.push('relax the declared posture (or add an override for "spawn-guard:ceiling" under the posture block\'s "overrides" key) in respawnpack.config.json');
      parts.push('wait for the current wave to land');
      return parts.join(', ');
    };

    const denyHard = (why) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `spawn-guard is in HARD-DENY mode (${denyModeNamed()}), which makes the ceiling (${CEILING}) ` +
          `absolute — and the number of agents already in flight could not be established: ${why}\n` +
          `A ceiling that quietly allows the dispatches it cannot count is not a ceiling. Remove or repair ` +
          `${counterPath(input.session_id, dir)}. Otherwise: ${denyModeEscape()}.`,
      },
    });

    // Read → decide → write, all under one lock. The candidate is what the count WOULD become; it is
    // only persisted when the dispatch is actually allowed to proceed (see defect 1 in the header).
    const locked = rt.withLock(file, () => {
      const state = readCountState(file);
      if (state.status !== 'PASS') return state;
      const candidate = state.count + 1;
      const denying = denyMode && candidate > CEILING;
      if (!denying) writeCount(file, candidate);
      return { status: 'PASS', count: candidate };
    });
    // ⛔ An unestablished lock is not a zero. If exclusivity could not be taken, the counter was not
    // updated and any number we printed would be a guess — so the ADVISORY says nothing rather than
    // something wrong, while a guard in HARD-DENY mode refuses, because its whole contract is a ceiling
    // it can enforce.
    if (!locked.locked) {
      if (denyMode) return denyHard(`exclusive access to the counter could not be taken (${locked.why}).`);
      return null;
    }
    if (locked.value.status !== 'PASS') {
      if (denyMode) return denyHard(`${locked.value.reason}.`);
      return null;
    }
    const next = locked.value.count;

    /*
     * Record it only if it is actually going to happen. In HARD-DENY mode a candidate over the ceiling is
     * DENIED and the count is deliberately not persisted (header defect 1: "a denial must cost
     * nothing") — logging it would put an agent in the recovery record that never started, and a resume
     * that re-dispatches phantom work is worse than one with a gap.
     */
    if (!(denyMode && next > CEILING)) appendLedger(dir, input, next);

    if (next > CEILING) {
      const msg =
        `${next} agents now in flight this session, above the pack's documented ceiling (${CEILING} — ` +
        `skills/README.md principle 4, "stay single-digit"). `;
      if (denyMode) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: msg +
              `spawn-guard is in HARD-DENY mode (${denyModeNamed()}) — ${denyModeEscape()}.`,
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: msg + 'Consider waiting for this wave to land before dispatching more (advisory only — not blocked).',
        },
      };
    }
    return null;
  }

  return null;
}

module.exports = { check, context };

// --- standalone entry point: CLI toggles, then hook JSON on stdin ---
if (require.main === module) {
  // --- CLI helpers (toggle strict hard-deny mode) ---
  const arg = process.argv[2];
  if (arg === '--strict-on') {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(strictFile, new Date().toISOString() + '\n');
    console.log(`spawn-guard: strict mode ON — dispatches above the ceiling (${CEILING}) will be DENIED, not just advised.`);
    process.exit(0);
  }
  if (arg === '--strict-off') {
    try { fs.unlinkSync(strictFile); console.log('spawn-guard: strict mode OFF (advisory only).'); }
    catch { console.log('spawn-guard: strict mode was already off.'); }
    process.exit(0);
  }
  if (arg === '--status') {
    // Names the effective mode AND its source (owner decision 26, P1-I-1): the marker, a declared
    // posture, or neither — never just "advisory"/"strict" with the reason left for the founder to guess.
    const markerPresent = fs.existsSync(strictFile);
    const stance = posture.resolve(projectDir);
    sayIfUnreadable(stance);
    const postureDenies = stance.source === 'DECLARED' && posture.verdict(stance, 'spawn-guard:ceiling') === 'deny';
    const denyMode = markerPresent || postureDenies;
    const sources = [];
    if (markerPresent) sources.push('marker (.respawnpack/spawn-guard.strict)');
    if (postureDenies) sources.push(`declared posture (\`${stance.profile}\`)`);
    if (!sources.length) {
      sources.push(`posture ${stance.source} (\`${stance.profile}\`) — DEFAULTED/UNREADABLE/INVALID never tighten this ceiling on their own, only the marker does`);
    }
    console.log(`spawn-guard: ceiling=${CEILING}  mode=${denyMode ? 'STRICT (hard-deny)' : 'advisory'}  source=${sources.join(' + ')}`);
    process.exit(0);
  }

  // --- Hook mode (default): read hook JSON from stdin ---
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

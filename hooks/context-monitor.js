#!/usr/bin/env node
/*
 * RespawnPack · context-monitor.js — PostToolUse advisory that warns as a session's context fills, so the
 * ledger gets updated and a rollover happens at a clean boundary BEFORE an auto-compaction drops state.
 * Concept credited to gsd-core's gsd-context-monitor / `gsd-health --context` and the aggregator's
 * context-monitor statusline; the real-token upgrade below is credited to the aggregator's
 * context-timeline hook, which proved the same `transcript_path` JSONL this hook already receives carries
 * real per-message token usage (all MIT) — re-derived in RespawnPack's file shape (see ATTRIBUTION.md).
 *
 * REAL TOKENS, WITH A BYTE-PROXY FALLBACK: every assistant turn in the transcript JSONL carries a
 * `message.usage` object (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
 * `output_tokens`). For a *context-occupancy snapshot*, the honest measure is a SINGLE entry's
 * input + cache_read + cache_creation (the tokens actually sent into the model on that call) — NOT a sum
 * across messages, which would count cumulative spend, not what's live in the window right now. So this
 * reads the transcript's most-recent usage-bearing entry and reports that. Two robustness notes baked in:
 *   • It reads only the transcript TAIL (last ~64 KB) and parses backwards, so cost stays flat as the
 *     file grows; the newest usage entry is always near the end.
 *   • It skips entries flagged `isSidechain` (a subagent's occupancy, not the main thread's), falling
 *     back to them only if nothing else is present.
 * When no usage entry parses (very start of a session, or the tail held none), it FALLS BACK to the old
 * transcript-byte-size proxy — a rough stand-in that OVER-states live context (the transcript retains
 * compacted-away history). The advisory says plainly which of the three sources it used.
 *
 * ⭐ v0.3 · THREE MEASUREMENT SOURCES, RANKED BY CONFIDENCE (core/lifecycle/evidence.js's vocabulary):
 *   statusline tee (documented-api, HIGH) — an opt-in tee from adapters/claude-code/statusline/, read
 *     ONLY when its `at` timestamp is fresher than STATUSLINE_FRESH_MS. Not wired by the installer; see
 *     adapters/claude-code/statusline/README.md for manual setup.
 *   transcript-tail usage (internal-format, LOW) — the real-token path above. The JSONL shape is
 *     explicitly internal and can change without notice, so it is trusted less than a documented field.
 *   byte-size proxy (byte-proxy, PROXY) — a rough stand-in, used only when neither of the above answers.
 * Every advisory NAMES its source and confidence — a number with no declared provenance is not acted on
 * by core/policy/thresholds.js, and this hook does not either.
 *
 * ⭐ v0.3 · PER-CYCLE RE-ARM, NOT PER-SESSION. v0.2 latched each threshold in
 * `.respawnpack/context-monitor.state.json`, KEYED BY SESSION ID. A compacted conversation keeps its
 * session id — that is the definition of an in-place rollover — so every threshold fired exactly once in
 * the life of a conversation and went silent for every cycle after it. That file is now LEFT IN PLACE,
 * UNREAD AND UNWRITTEN (a migration artifact of a prior install; nothing here touches it again). Latches
 * now live in core/policy/thresholds.js's own store, `thresholds.json`, inside the conversation's rollover
 * directory (`.respawnpack/runtime/rollover/claude-code-<safe session id>/`), keyed by the machine's
 * CURRENT context-cycle id (core/lifecycle/cycle.js). `forCycle()` replaces the whole latch record with an
 * empty one the moment the cycle id changes — which happens exactly once per OBSERVED compaction
 * completion (core/lifecycle/machine.js `verify-identity`), never on a no-op compaction, and never merely
 * because a session id repeats.
 *
 * ⛔ THIS HOOK NEVER MINTS MACHINE STATE. `core/lifecycle/cycle.js readPersisted()` is a READ of whatever
 * cycle record already exists; it is not `machine.open()`, which would MINT a cycle-0 record as a side
 * effect of a PostToolUse call that has no business creating rollover state. When no cycle record exists
 * yet (no compaction has ever completed for this conversation), this hook uses a READ-ONLY DEFAULT — the
 * synthetic cycle id `claude-code:<session id>:0:unestablished` — and SAYS SO in the record rather than
 * pretending cycle 0 was established the normal way.
 *
 * BUDGET (override freely):
 *   RESPAWNPACK_CONTEXT_BUDGET_TOKENS (default 1000000 — a 1M-token window; the real-token path).
 *   RESPAWNPACK_CONTEXT_BUDGET_BYTES  (default 10000000 ≈ 1M tokens at ~10 transcript bytes/token; the
 *                                      byte-proxy fallback path — still honored for anyone who set it).
 *
 * ⛔ THE DEFAULT IS 1M BECAUSE THAT IS THE WINDOW THE HOSTS THIS HOOK RUNS IN ACTUALLY HAVE, and a
 * denominator that is wrong by 5× does not produce a cautious warning, it produces a discredited one.
 * At the old 200k default a 1M-window session crossed "mandatory handoff" at 170k tokens with 830k still
 * free — the lifecycle fired on every long session, always wrongly, which is how a signal gets ignored.
 * Every current Opus and Sonnet is 1M; Haiku 4.5 is the last 200K model.
 *
 * ⛔ AND THE SAFE DIRECTION FLIPS WITH IT — SAID PLAINLY RATHER THAN LEFT TO BE DISCOVERED. Under-
 * estimating the window reads too FULL: noisy, but it warns early. Over-estimating reads too EMPTY,
 * which is the direction that lets a context fill with no warning at all. So on a host whose window is
 * genuinely smaller than this default — Haiku 4.5, or any model behind a reduced-context deployment —
 * the operator MUST set RESPAWNPACK_CONTEXT_BUDGET_TOKENS, because this hook cannot read the window and
 * will not pretend it can. That is the same posture as the rest of the pack: a number we supplied is
 * declared as ours, never dressed up as a reading.
 *
 * Wire as a PostToolUse hook (no matcher — samples after every tool; see settings.snippet.json). Fires at
 * most ONCE per threshold PER CONTEXT CYCLE (not per session — see above).
 *
 * ⛔ DELIVERY SEMANTICS — THE DEFECT THIS SECTION CORRECTS. This hook used to speak only on
 * `systemMessage`. The published contract defines that field as "Warning message shown to the user":
 * it is a UI notification and is NOT added to the model's context. So the agent whose context this hook
 * exists to pace **never saw a word of it** — the pack was describing a user-only toast as agent
 * enforcement. PostToolUse *does* support `hookSpecificOutput.additionalContext`, so both audiences are
 * now served explicitly: `systemMessage` for the human, `additionalContext` for the model.
 *
 * ⭐ MODE-SENSITIVE, BECAUSE THE TWO FAILURES ARE OPPOSITE. Field run B stayed in one context until it
 * could manufacture a completion claim, which argues for hard lifecycle stages. Field run A
 * was nagged through a read-only session, which argues for leaving people alone. Both are right, for
 * different contracts (ADR-001):
 *   • collaborate / delegate — ADVISORY at 60/80. An interactive session is never told it is being
 *     terminated at an arbitrary percentage; the user decides when to wrap up.
 *   • goal (explicit autonomous work only) — LIFECYCLE at 60/75/85: checkpoint → closeout → mandatory
 *     handoff. Recommendation R-1. These apply only because someone explicitly asked for autonomous
 *     completion; they are never inferred from a task being hard.
 * Stages are configurable (RESPAWNPACK_CONTEXT_STAGES / _CONTEXT_ADVISORY_STAGES) and behavior-tested.
 *
 * ⛔ v0.3 · HONEST MESSAGING. Neither branch below claims a "fresh session" any more. The interactive
 * profile has exactly one automatic move it can make: nothing. Compaction happens only when the OPERATOR
 * runs `/compact`, and this hook says that in those words rather than implying the pack starts one for
 * them. The one path that IS automatic — a managed SDK supervisor issuing `/compact` itself — is named as
 * the alternative, not assumed to be running.
 *
 * Contract (Claude Code hooks): stdin = PostToolUse JSON {session_id, transcript_path, cwd, ...}.
 * Output = {systemMessage, hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext}} + exit 0.
 * Never blocks.
 */
const fs = require('fs');
const path = require('path');
// Advisory: this hook nudges about context budget and enforces nothing, so its documented conservative
// posture is to say why on stderr and exit 0 — never a raw stack, never a failed turn.
const boot = require('./_boot.js');
boot.arm('advisory');
const rt = boot.need('./_runtime.js');

// core/ is the host-neutral rollover core (adapters/kernel consume it; hooks/ is one more consumer). It
// is NOT one of hooks/_*.js's shared-module contracts — a hook cannot mint or gate on lifecycle state
// through a module that lives outside its own directory's bootstrap boundary — so it is loaded with an
// explicit, LOCAL try/catch rather than through the hook's own bootstrap loader. A missing or broken
// core/ degrades this hook to its v0.2 shape (measurement and messaging still work; per-cycle re-arm
// cannot, so it falls back to firing every call rather than staying silent forever, which is the safer
// of the two wrong answers).
let core = null;
try { core = require('../core/index.js'); } catch { core = null; }

const stagesFrom = (env, fallback) => {
  const parsed = String(env || '').split(',').map((n) => Number(n.trim())).filter((n) => n > 0 && n <= 100);
  return parsed.length ? parsed.sort((a, b) => a - b) : fallback;
};
// Named so the message can say what the stage MEANS, not just which number was crossed.
const GOAL_STAGES = { checkpoint: 'checkpoint', closeout: 'closeout', handoff: 'mandatory handoff' };

const TOKEN_BUDGET = Number(process.env.RESPAWNPACK_CONTEXT_BUDGET_TOKENS) || 1000000;
const BYTE_BUDGET = Number(process.env.RESPAWNPACK_CONTEXT_BUDGET_BYTES) || 10000000; // proxy-fallback budget
const TAIL_BYTES = 65536; // read at most this much of a large transcript, from the end
const STATUSLINE_FRESH_MS = 60 * 1000; // adapters/claude-code/statusline/'s documented freshness window

// Same sanitizer the statusline tee and the rest of hooks/_runtime.js use for a filename segment — kept
// local (not core/_io.js's safeSegment) so the tee can be read even when core/ fails to load above.
const safeId = (id) => String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

// Read the transcript's tail (or the whole file if small) without loading a huge file into memory.
function readTranscriptTail(tp) {
  const size = fs.statSync(tp).size; // throws if not on disk yet → caller handles
  if (size <= TAIL_BYTES) return { text: fs.readFileSync(tp, 'utf8'), whole: true, size };
  const fd = fs.openSync(tp, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    return { text: buf.toString('utf8'), whole: false, size };
  } finally { fs.closeSync(fd); }
}

// Most-recent context-occupancy reading (tokens) from the transcript, or null if none parses.
function latestTokenOccupancy(tp) {
  let text, whole;
  try { ({ text, whole } = readTranscriptTail(tp)); } catch { return null; }
  let lines = text.split('\n');
  if (!whole) lines = lines.slice(1); // a mid-file tail read starts mid-line — drop the partial
  let sidechainFallback = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; } // partial/non-JSON line — skip
    const u = (o && o.message && o.message.usage) || (o && o.usage); // both shapes, defensively
    if (!u) continue;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tokens <= 0) continue; // degenerate usage row (e.g. tool-only) — not an occupancy signal
    if (o.isSidechain === true) { if (sidechainFallback == null) sidechainFallback = tokens; continue; }
    return tokens; // newest main-thread reading wins
  }
  return sidechainFallback; // only a subagent's usage was in the tail → still better than the byte proxy
}

/**
 * The opt-in statusline tee (adapters/claude-code/statusline/), read only when fresh. Independent of
 * core/ on purpose: the measurement path must survive a broken core/ just as the byte proxy does.
 * @returns {{usedPercent:number, ageMs:number, doc:object}|null}
 */
function readStatuslineTee(dir, sid) {
  const file = path.join(dir, '.respawnpack', 'runtime', `context-usage-${safeId(sid)}.json`);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!doc || typeof doc.used_percentage !== 'number' || !Number.isFinite(doc.used_percentage) || typeof doc.at !== 'string') return null;
  const ageMs = Date.now() - Date.parse(doc.at);
  if (!Number.isFinite(ageMs) || ageMs > STATUSLINE_FRESH_MS) return null; // absent/stale — not a source
  return { usedPercent: Math.max(0, Math.min(100, doc.used_percentage)), ageMs: Math.max(0, ageMs), doc };
}

/**
 * Resolve ONE measurement from the three-tier source ladder, DECLARED with its source name (the exact
 * strings core/lifecycle/evidence.js's SOURCE_CONFIDENCE recognizes) so confidence travels with the number.
 * @returns {{usedPercent:number, source:string, mode:string, detail:string}|null}
 */
function resolveMeasurement(dir, sid, tp) {
  const tee = readStatuslineTee(dir, sid);
  if (tee) {
    return {
      usedPercent: tee.usedPercent, source: 'documented-api', mode: 'statusline',
      detail: `statusline tee, ${Math.round(tee.ageMs / 1000)}s old`,
    };
  }
  const tokens = latestTokenOccupancy(tp);
  if (tokens != null) {
    return {
      usedPercent: (tokens / TOKEN_BUDGET) * 100, source: 'internal-format', mode: 'tokens', tokens,
      detail: 'transcript-tail usage — the JSONL shape is explicitly internal',
    };
  }
  let size = null;
  try { size = fs.statSync(tp).size; } catch { return null; } // transcript not on disk yet — no source at all
  return {
    usedPercent: (size / BYTE_BUDGET) * 100, source: 'byte-proxy', mode: 'bytes', size,
    detail: 'transcript byte-size proxy — over-states live context (retains compacted-away history)',
  };
}

const CONFIDENCE_LABEL = { HIGH: 'HIGH confidence', LOW: 'LOW confidence', PROXY: 'PROXY (not a token reading)' };

/*
 * ⛔ A READING OVER 100% DISPROVES THE BUDGET. IT IS NOT A REASON TO ESCALATE.
 *
 * The the 2026-08-07 field run (§6) recorded this hook reporting "277% of a 200k budget" and concluded
 * it "over-reports by ~10× and would cause data loss if followed" — following it means compacting
 * repeatedly mid-fan-out, exactly when in-flight agent results are most at risk. Replaying
 * `latestTokenOccupancy` over that session's own transcript reproduces it at 285%, and shows the
 * diagnosis was half right in a way that matters:
 *
 *     input_tokens 2 + cache_read 563,512 + cache_creation 6,287 = 569,801 tokens
 *
 * The NUMERATOR IS CORRECT. That prompt really did carry ~570k tokens; the measurement is doing its job.
 * What is wrong is the DENOMINATOR — `TOKEN_BUDGET` defaults to 200,000 and nothing ever checks it
 * against the evidence. Any session whose window is larger than the default trips every threshold on
 * its FIRST sample and stays tripped for the rest of the conversation, escalating to "mandatory
 * handoff" in goal mode while the window is barely half full.
 *
 * ⭐ SO THE FIX IS NOT "MEASURE REAL CONTEXT" (it already does) — it is to notice that occupancy cannot
 * exceed 100%. A percentage above it is not a very full session; it is proof that the number we are
 * dividing BY is wrong for this conversation. This hook's own doctrine, stated at the top of the file,
 * is that "a number with no declared provenance is not acted on"; a number its own evidence has
 * falsified gets the same treatment. The token count is still reported, because that part is a fact.
 */
function budgetContradicted(m) {
  return m.mode === 'tokens' && m.tokens > TOKEN_BUDGET;
}

function describeContradiction(m) {
  return `~${Math.round(m.tokens / 1000)}k tokens of context (input + cache) — which EXCEEDS the configured ` +
    `${Math.round(TOKEN_BUDGET / 1000)}k-token budget, so no occupancy percentage is being reported. ` +
    'Occupancy cannot exceed 100%: a reading above it means this conversation\'s window is larger than ' +
    'RESPAWNPACK_CONTEXT_BUDGET_TOKENS says, not that the window is overfull. The token count is measured ' +
    'and real; the budget it was being divided by is not right for this session. Set ' +
    'RESPAWNPACK_CONTEXT_BUDGET_TOKENS to this conversation\'s actual window to get pacing advice back.';
}

function describeMeasurement(m, confidence) {
  const pct = Math.round(m.usedPercent);
  const label = CONFIDENCE_LABEL[confidence] || 'confidence undeclared';
  if (m.mode === 'statusline') return `${pct}% of context used (source: ${m.detail}, ${label})`;
  if (m.mode === 'tokens') {
    return `~${Math.round(m.tokens / 1000)}k tokens of context (input + cache), ~${pct}% of the configured ` +
      `${Math.round(TOKEN_BUDGET / 1000)}k-token budget (RESPAWNPACK_CONTEXT_BUDGET_TOKENS) — source: ${m.detail}, ${label}`;
  }
  return `a ~${(m.size / 1048576).toFixed(1)} MB transcript, ~${pct}% of the configured proxy budget ` +
    `(${(BYTE_BUDGET / 1048576).toFixed(1)} MB, RESPAWNPACK_CONTEXT_BUDGET_BYTES) — source: ${m.detail}, ${label}`;
}

/**
 * The cycle id to key latches on, and whether it was ESTABLISHED (a real, persisted cycle record) or a
 * READ-ONLY DEFAULT (nothing has been persisted for this conversation yet). Never mints.
 */
function resolveCycle(projectDir, sid) {
  if (!core) return { cycleId: `claude-code:${sid}:0:unestablished`, established: false, dir: null };
  const dir = core.cycle.conversationDir(projectDir, 'claude-code', sid);
  let read;
  try { read = core.cycle.readPersisted(dir); } catch { read = { status: 'UNREADABLE', cycle: null }; }
  if (read.status === 'OK' && read.cycle && typeof read.cycle.cycleId === 'string') {
    return { cycleId: read.cycle.cycleId, established: true, dir };
  }
  return { cycleId: `claude-code:${sid}:0:unestablished`, established: false, dir };
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const tp = input.transcript_path;
  if (!tp || typeof tp !== 'string') process.exit(0); // no signal available this event

  const dir = rt.projectDir(input);
  const sid = String(input.session_id || 'unknown');

  const measurement = resolveMeasurement(dir, sid, tp);
  if (!measurement) process.exit(0); // transcript not on disk yet — nothing measurable, nothing to say

  const confidence = core ? core.evidence.confidenceOf(measurement.source) : null;

  /*
   * ⛔ THE FALSIFIED-BUDGET BRANCH, BEFORE ANY THRESHOLD IS CONSULTED. See budgetContradicted(). Every
   * threshold is `pct >= t`, so a 285% reading crosses all of them at once and latches all of them —
   * which in goal mode is an immediate jump to "mandatory handoff, stop implementation now". That is
   * the data-loss path the dogfood identified, so this returns before the latch store is touched:
   * nothing is written, nothing is marked as having fired, and the advisory that IS emitted says only
   * what is known. Once the operator sets a correct budget, the thresholds are still un-latched and
   * fire normally at 60/75/85 — suppressing the escalation must not also consume it.
   */
  if (budgetContradicted(measurement)) {
    const line = describeContradiction(measurement);
    process.stdout.write(JSON.stringify({
      systemMessage: `📊 RespawnPack context-monitor: ${line}`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `Context measurement (${measurement.detail}): ${line} Nothing is blocked and no context stage ` +
          'applies — do not compact or hand off on the strength of this reading. Compacting mid-fan-out is ' +
          'how in-flight subagent results get lost, and this number is not evidence that it is needed.',
      },
    }));
    process.exit(0);
  }

  const contract = rt.readContract(dir).mode;
  const goalMode = contract === 'goal';
  const thresholds = goalMode
    ? stagesFrom(process.env.RESPAWNPACK_CONTEXT_STAGES, [60, 75, 85])
    : stagesFrom(process.env.RESPAWNPACK_CONTEXT_ADVISORY_STAGES, [60, 80]);

  // --- per-cycle latch: read → forCycle (re-arm iff the cycle id changed) → decide → write -------------
  const { cycleId, dir: cdir } = resolveCycle(dir, sid);
  const latchDir = cdir || path.join(dir, '.respawnpack', 'runtime', 'rollover', `claude-code-${sid.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);

  let record = { kind: 'threshold-latches', cycleId, latched: {} };
  if (core) {
    try {
      const read = core.thresholds.readLatches(latchDir);
      const base = read.status === 'OK' ? read.record : null;
      record = core.thresholds.forCycle(base, cycleId).record;
    } catch { /* an unreadable latch file degrades to a fresh one for THIS call only — nothing is written yet */ }
  }

  const pct = measurement.usedPercent;
  const newlyCrossed = thresholds.filter((t) => pct >= t && !record.latched[String(t)]);
  if (!newlyCrossed.length) process.exit(0); // nothing new → no write, no message, no repeated nag

  const nowISO = new Date().toISOString();
  for (const t of newlyCrossed) record.latched[String(t)] = { at: nowISO, atPercent: t };
  if (core) { try { core.thresholds.writeLatches(latchDir, record); } catch { /* best-effort — still emit the advisory */ } }

  const tier = Math.max(...newlyCrossed);
  const occupancy = describeMeasurement(measurement, confidence);

  // The model-facing half. In goal mode it is a lifecycle instruction; otherwise it is an offer. Neither
  // claims automation the interactive profile lacks (v0.3 · honest messaging).
  let stage = null, agentText;
  if (goalMode) {
    const idx = thresholds.indexOf(tier);
    stage = idx <= 0 ? GOAL_STAGES.checkpoint : idx === 1 ? GOAL_STAGES.closeout : GOAL_STAGES.handoff;
    if (stage === GOAL_STAGES.checkpoint) {
      agentText =
        `Context ${GOAL_STAGES.checkpoint} stage (goal mode, ${occupancy}). Finish the CURRENT atomic ` +
        'operation and append it to .respawnpack/wave-ledger.md. Do not begin another broad task.';
    } else if (stage === GOAL_STAGES.closeout) {
      agentText =
        `Context ${GOAL_STAGES.closeout} stage (goal mode, ${occupancy}). No new implementation work may ` +
        'start. Run deterministic verification on what exists and prepare the savepoint/handoff.';
    } else {
      agentText =
        `Context ${GOAL_STAGES.handoff} stage (goal mode, ${occupancy}). Stop implementation now. Persist ` +
        'the atomic task, evidence paths, and which checks ran with their exit codes — the PreCompact hook ' +
        'writes and verifies a rollover handoff automatically once compaction starts. Then run /compact IN ' +
        'THIS SESSION: an operator step, because hooks cannot invoke a slash command themselves. ' +
        'SessionStart(compact) will rehydrate this SAME session (not a fresh one) with that verified ' +
        'handoff. Fully automatic continuation — without an operator running /compact — needs the managed ' +
        'SDK supervisor profile (adapters/claude-code/sdk-supervisor); if you cannot confirm one is driving ' +
        'this conversation, say so plainly and leave the verified handoff rather than claiming a ' +
        'continuation that did not happen.';
    }
  } else {
    agentText =
      `Context advisory (${contract} mode, ${occupancy}). Nothing is blocked and this session can continue. ` +
      'If it is a natural boundary, append to .respawnpack/wave-ledger.md and run /compact: the PreCompact ' +
      'hook persists a verified handoff and SessionStart(compact) restores it automatically in this SAME ' +
      'session — an operator step, since hooks cannot invoke /compact themselves.';
  }

  process.stdout.write(JSON.stringify({
    systemMessage: `📊 RespawnPack context-monitor: this session is holding ${occupancy}.` +
      (goalMode ? ` Goal-mode stage: ${stage}.` : ' (Advisory — nothing blocked.)'),
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: agentText },
  }));
  process.exit(0);
});

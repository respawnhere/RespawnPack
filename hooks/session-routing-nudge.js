#!/usr/bin/env node
/*
 * RespawnPack · session-routing-nudge.js — SessionStart hook. Boots the session from CURRENT STATE.
 *
 * Priority order, and the order is the whole design:
 *   1. the generated durable state (docs/derived/STATE.json), REVISION-VALIDATED before it is trusted;
 *   2. any verified compaction handoff written for this session, then marked consumed;
 *   3. the bounded human note from CONTINUITY.md — prose a person wrote, not numbers;
 *   4. the active interaction contract, when it is not the default;
 *   5. the lessons register's two counts, read from the tracked memory files.
 * It also records the session's tree baseline, which the Stop hook subtracts to tell session work from
 * pre-existing dirt.
 *
 * ⛔ WHAT THIS BLOCK NO LONGER CARRIES, AND WHY (A7). An earlier version ended every boot with a static
 * ~65-word routing paragraph (the themed-pass map and the describe-the-goal-in-prose reminder). Claude
 * Code now surfaces SessionStart stdout natively and the routing map already lives where it is read:
 * skills/README.md's prose-routed aliases, the /respawn skill's "Next" hand-off, and the behavior
 * standard's "match ceremony to blast radius" rule that the installer writes into every CLAUDE.md. A
 * paragraph repeated into every boot was budget this block could not afford; it is gone, and the one
 * sentence it carried that the skill did not (describe the goal in prose, no slash command is required)
 * was folded into skills/respawn/SKILL.md in the same change.
 *
 * ⛔ WHY STATE LEADS AND CONTINUITY NO LONGER DOES. The pack's architecture says STATE.json owns live
 * truth, but for a while both this hook and /respawn still booted from CONTINUITY.md — so the kernel
 * was an excellent checker sitting BESIDE the boot path rather than owning it, and a session could
 * still start from a stale projection. Worse, when generated CONTINUITY happened to carry no pause or
 * killed-feature marker, this hook injected boilerplate and no goal, no current task, no blockers and
 * no revision at all.
 *
 * Now: structured facts come from the structured source, and CONTINUITY contributes only what it is
 * uniquely good for — the sentence a human wrote about where things stand. Projects with no kernel
 * state fall back to the old CONTINUITY extraction, so adopting the kernel stays optional.
 *
 * ⛔ AND STATE IS NEVER TRUSTED UNCHECKED. STATE.json is a projection of one revision. If HEAD has
 * moved past it, its numbers describe a project that no longer exists; injecting them silently would
 * be a more confident version of the exact failure this pack keeps correcting. A stale projection is
 * announced as stale, and the session is told to regenerate rather than believe it.
 *
 * The earlier version of this hook was a static ~65-word routing paragraph. Field run A
 * opened on that gap: a live 🛑 pause forbidding all game-design work sat in CONTINUITY.md,
 * the SessionStart path named neither, and four turns later the agent offered three follow-ups that
 * the pause forbade. A guardrail that does not reach the session is not a guardrail.
 *
 * BUDGET DISCIPLINE. Boot context is a budget, not a dumping ground. Each section is capped, the whole
 * injection is bounded, and the two derived docs this reads are read only at their HEAD (A7): the human
 * NOTE block and the generated/seed markers all sit at the top of a rendered or seeded document by
 * construction, so the boot never opens a multi-thousand-row generated block to find them. A truncated
 * pause still says more than no pause at all.
 *
 * The session-start routing-reminder concept (now carried by the skills layer, not this hook; see the
 * block above) was credited to obra/superpowers' session-start routing reminder (MIT); see ATTRIBUTION.md.
 *
 * ⭐ v0.3 · SOURCE-AWARE COMPACTION HANDLING. `source === 'compact'` is the one value that means a
 * compaction just happened, and it is the only one that touches the host-neutral rollover machine
 * (core/lifecycle/machine.js): `observe-completion` (COMPACTING → REHYDRATING, on the documented
 * `session_start_compact` signal — core/lifecycle/evidence.js COMPLETION_SIGNALS) then `verify-identity`
 * (REHYDRATING → ACTIVE, comparing the conversationId persisted in the machine's own cycle record against
 * this event's session_id). A successful verify-identity is what ADVANCES THE CONTEXT CYCLE — the thing
 * context-monitor.js's per-cycle threshold re-arm is keyed on. Every OTHER source runs the ORIGINAL v0.2
 * behavior for the v1 handoff, byte for byte: it was never conditioned on source and this change does not
 * start conditioning it now.
 *
 * The v2 handoff (core/state/handoff.js), when the machine ever reached COMPACTING for this conversation
 * (see precompact-ledger-nudge.js), is consumed through `core.handoff.consume` — exactly once, via the
 * O_EXCL receipt `core/lifecycle/consumable.js` provides. A REDELIVERED SessionStart(compact) — this hook
 * firing twice for the same compaction — must not inject the handoff's content twice: the second call
 * finds `ALREADY_CONSUMED` and gets a one-line pointer, never the block again. When no v2 handoff exists
 * (an older install, or a machine that never reached COMPACTING) this falls back to the v1 record via
 * `core.handoff.fromV1` — a migration shim, not a rewrite of the v1 file — tagged as migrated so a reader
 * knows the difference. `core/`'s own failure is never fatal to the boot: every step here is best-effort
 * and reports what it could not do rather than crashing SessionStart over rollover bookkeeping.
 *
 * Contract (Claude Code hooks): stdin = SessionStart JSON {source, session_id, cwd, ...}.
 * Inject = stdout JSON {hookSpecificOutput:{hookEventName:"SessionStart",additionalContext}} + exit 0.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
/*
 * ⛔ THROUGH THE BOOTSTRAP BOUNDARY, NEVER A BARE REQUIRE. A syntactically invalid `_artifact.js` used
 * to kill this hook with a raw SyntaxError out of `_runtime.js`'s hard require: exit 1, no stdout, no
 * additionalContext, no warning — the session simply started with none of its constraints, forbidden
 * actions or blockers, and no way to know. `session-start` posture emits VALID event output saying so.
 */
const boot = require('./_boot.js');
boot.arm('session-start');
const rt = boot.need('./_runtime.js');

// core/ is the host-neutral rollover core — see context-monitor.js's identical note for why this is a
// LOCAL try/catch rather than routed through the hook's own bootstrap loader (core/ is not one of
// hooks/_*.js's shared-module contracts). A missing or broken core/ must not break the v0.2 boot
// (STATE-first, budgets, contract, lessons), so every use of it below degrades to "v2/machine
// bookkeeping was not attempted" rather than crashing.
let core = null;
try { core = require('../core/index.js'); } catch { core = null; }

const NOTE_BUDGET = 700;   // chars of human prose from CONTINUITY
const STATE_BUDGET = 1600; // chars of structured state
const LEGACY_BUDGET = 1400; // chars when falling back to whole-CONTINUITY extraction
// A7 · the bounded HEAD read for the two derived docs. 16 KiB sits far above everything the boot looks
// for (kernel/lib/render.js renders the NOTE block within the first ~1.6 KB of a rendered doc, after a
// ~5-line header; the installer's seed places its "(Seeded …)" stamp and `<placeholder>` rows in the
// first ~25 lines), and far below a large generated block, so it is a true bound, not the whole file.
const CONTINUITY_HEAD = 16 * 1024;
const GAPS_HEAD = 16 * 1024;

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

/*
 * ⛔ A BOUNDED HEAD READ, NEVER THE WHOLE FILE (A7). Returns the first `limit` bytes decoded as UTF-8 and
 * whether the file ran PAST the window, so a marker that would have sat beyond the bound is announced as
 * unscanned rather than silently read as absent. Best-effort like every other read here: an unreadable
 * or missing file is `null`, and the boot degrades rather than crashing.
 */
function readHead(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, limit);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const got = fs.readSync(fd, buf, off, want - off, off);
      if (got <= 0) break;
      off += got;
    }
    return { text: buf.toString('utf8', 0, off), truncated: size > off };
  } catch { return null; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/*
 * ⛔ GOAL STALENESS (I-9, the hooks-and-install audit §7 T-17, the hooks findings I-9). `goal.json`
 * (kernel/lib/state.js:117-130) carries no timestamp or history of its own, so a goal set five minutes
 * ago and one nobody has revisited in months print identically — the boot has no way to say "this has
 * sat here while everything else moved." Git already holds the history the schema does not: the last
 * commit that touched the tracked path IS "when this was last written," and duplicating that fact into
 * the file would just be a second place for the same information to go stale.
 *
 * GOAL_STALE_THRESHOLD_COMMITS = 8, named by both spec documents above, not derived from anything in
 * this codebase. Low enough to catch a goal that has sat through a real chunk of work; high enough that
 * ordinary same-session commit churn does not nag on every boot.
 *
 * ⛔ THE NAMED BYPASS. `git log -1 -- <path>` answers "when did a commit last touch this file", not
 * "when was this goal last RECONSIDERED". A cosmetic re-save — reformatting, a key reorder, rewriting
 * byte-identical content — is a commit that touches the file exactly like a genuine change of mind, and
 * it resets `<rev>` and the counter right along with it. Only the CONTENT could tell reconsideration
 * apart from a touch, and `goal.json` records no field for intent either way. This is accepted, not
 * solved: teaching this hook to diff goal semantics would mean re-deriving the compiler's own
 * goal-reading logic inside `hooks/`, which is not allowed to require `kernel/` at all (see the
 * GEN_MARKER note below on why that arrow only runs one way).
 *
 * CANNOT_DETERMINE stays silent here exactly like every other check in this hook: no goal.json in git
 * history, a project that is not a git repository, or any git call that fails all print nothing new and
 * never block SessionStart.
 */
const GOAL_STALE_THRESHOLD_COMMITS = 8;
const GOAL_JSON_PATH = 'docs/derived/state/goal.json';

/*
 * execFileSync with an argv array and no shell — the same invocation shape `_runtime.js`'s own
 * (unexported) `git()` helper and every other hook's local git wrapper already use: `cwd`, `encoding:
 * 'utf8'`, `stdio: ['ignore','pipe','ignore']`. `_runtime.js` sits outside this task's touched files and
 * does not export its copy, so this mirrors the established convention rather than inventing a second
 * spawn shape.
 */
function gitQuiet(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Null on any CANNOT_DETERMINE cause (no goal history, no repo, a failing query, nothing else moved, or
 * the goal itself was touched inside the window). A printable line only when every condition holds.
 *
 * Three git subprocesses, not two: the log/rev-list pair the spec names finds the revision and the
 * commit count, but neither one can answer "did anything ELSE under docs/derived move in that range" —
 * that condition is what keeps a quiet project from being nagged, so it gets its own query rather than
 * being dropped to hit a smaller number.
 */
function goalStalenessNudge(dir, goalId) {
  let rev;
  try { rev = gitQuiet(dir, ['log', '-1', '--format=%H', '--', GOAL_JSON_PATH]).trim(); } catch { return null; }
  if (!rev) return null; // no goal.json in git history

  let count;
  try { count = parseInt(gitQuiet(dir, ['rev-list', '--count', `${rev}..HEAD`]).trim(), 10); } catch { return null; }
  if (!Number.isFinite(count) || count < GOAL_STALE_THRESHOLD_COMMITS) return null;

  // `<rev>` is BY DEFINITION the last commit to touch goal.json, so no commit strictly after it up to
  // HEAD can touch goal.json again — anything this finds under docs/derived/ is necessarily something
  // else, with no need to exclude the goal file's own path by name.
  let others;
  try { others = gitQuiet(dir, ['diff', '--name-only', rev, 'HEAD', '--', 'docs/derived']).trim(); } catch { return null; }
  if (!others) return null; // nothing else moved — a quiet project is never nagged

  return `⚠️ goal ${goalId || 'unnamed'} unchanged in ${count} commits while the project moved; reconcile via /loadout?`;
}

/**
 * The compact structured summary. Everything here is a live fact read from the generated state, never
 * prose parsed out of a document.
 */
function renderState(read, dir) {
  const s = read.state;
  const fresh = read.status === 'CURRENT';
  const L = [];

  /*
   * ⛔ A NON-ABSENT READ IS NOT A READ THAT PRODUCED A DOCUMENT. `readDurableState` answers
   * CANNOT_DETERMINE with `state: null` whenever STATE.json is present-but-unusable — an unreadable
   * file, or an acceptance boundary that is itself broken — and every line below dereferences `s`. So
   * the one status that means "something is wrong here" was the one that crashed SessionStart:
   * `TypeError: Cannot read properties of null (reading 'sourceRevision')`, exit 1, no context injected
   * at all. The session lost its constraints and its forbidden actions to a null check that was never
   * written, which is the most expensive possible way to fail.
   *
   * Withheld, and SAID — never a figure, never silence.
   */
  if (!s) {
    return `⚠️ PROJECT STATE COULD NOT BE READ — ${read.detail || `status ${read.status}`}. `
      + 'Every count, criterion and blocker is WITHHELD: this is a FAULT, not a project with no state, and the two '
      + 'must not read alike. Run `node .claude/respawnpack/respawnpack.js doctor` — it reports the broken '
      + 'component as a row rather than dying on it.';
  }

  /*
   * ⛔ WHEN STATE IS NOT FRESH, VOLATILE CLAIMS ARE WITHHELD — not printed with a caveat.
   *
   * A caveat above a precise-looking number does not stop the number anchoring the session; that is
   * exactly how stale-but-plausible integers survive a careful re-read. So counts, completion status,
   * next-unblocked scheduling and blocker arithmetic are SUPPRESSED unless both the revision and every
   * source digest agree.
   *
   * What still gets through is the safety half — active constraints and killed features. Those are
   * prohibitions: acting on a superseded prohibition costs a wasted question, while acting on a
   * superseded schedule costs wrong work. The asymmetry is deliberate and stated.
   */
  if (read.status === 'STALE') {
    L.push(`⚠️ STATE IS STALE — ${read.detail}. Counts, completion status, next work and blocker ` +
      'arithmetic are WITHHELD below rather than shown with a caveat, because a stale number anchors a ' +
      'session even when it is labelled. Run `node .claude/respawnpack/respawnpack.js state` (or /savepoint) to refresh, then re-read.');
  } else if (read.status === 'CANNOT_DETERMINE') {
    L.push(`⚠️ STATE FRESHNESS UNKNOWN — ${read.detail}. Treating it as stale: volatile figures are withheld.`);
  }
  // When HEAD sits on savepoint-only commits above the bound revision, say so in one clause: a reader
  // comparing this line against `git log` would otherwise see two hashes and reach for "stale" — the
  // exact conclusion this hook used to draw, and the one hooks/_manifest.js now defines away.
  const revs = read.revisions || null;
  const depth = revs && Array.isArray(revs.chain) ? revs.chain.indexOf(s.sourceRevision) : -1; // commits between HEAD and the bound revision
  const lag = fresh && depth > 0
    ? ` (HEAD ${String(revs.head).slice(0, 7)} differs only by ${depth} savepoint-only commit${depth === 1 ? '' : 's'} — same source)`
    : '';
  L.push(`Source revision: ${String(s.sourceRevision || 'unknown').slice(0, 7)}${lag} · state generated ${s.generatedAt || 'unknown'}`);

  // --- safety, surfaced even when stale -----------------------------------------------------------
  if (s.constraints && s.constraints.length) L.push(`🛑 ACTIVE CONSTRAINTS (honor before proposing any work${fresh ? '' : '; from a stale projection — verify before relying on it'}): ${s.constraints.join(' · ')}`);
  if (s.forbidden && s.forbidden.length) L.push(`⛔ FORBIDDEN BY THE ONGOING GOAL: ${s.forbidden.join(' · ')}`);
  /*
   * ⛔ KILLED FEATURES ARRIVE WITH THEIR ENFORCEMENT STATUS, NOT AS A BARE LIST (Scenario L). The
   * installed baseline used to state "killed features are never re-added" as an absolute while nothing
   * checked it, so a session read a list of ids and reasonably assumed something was watching. Each row
   * now says whether it is scanned-and-clear, currently VIOLATED, or unverified — and a violated row is
   * the loudest thing in this block, because it means the reintroduction has already happened.
   *
   * The verdict is a function of the scanned live content, which is not a compiler input, so it carries
   * its own corpus manifest. If those files have moved since the scan, the verdict is reported as stale
   * rather than repeated — the same discipline the counts get, applied to the safety half.
   */
  if (s.killedFeatures && s.killedFeatures.length) {
    const rows = s.killedFeatures;
    const violated = rows.filter((k) => k && k.status === 'violated');
    const unverified = rows.filter((k) => k && k.status === 'unverified');
    const label = (k) => `${k.id || k}${k.feature ? ` (${k.feature})` : ''}`;
    L.push(`⛔ KILLED — do not reintroduce: ${rows.map(label).join(', ')}`);
    if (violated.length) {
      L.push(`🚨 ALREADY REINTRODUCED — ${violated.length} killed feature(s) are asserted live RIGHT NOW: ` +
        violated.map((k) => `${label(k)} at ${(k.violations || []).slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ')}`).join(' · ') +
        '. Removing the live assertion comes before new work on that surface.');
    }
    if (unverified.length) {
      L.push(`⚠️ ${unverified.length} killed feature(s) are NOT mechanically enforced (${unverified.map(label).join(', ')}) — ` +
        'no forbidden phrase in the registry, or none that discriminates. Treat those as agent-remembered, not guarded.');
    }
    const rm = s.removals || {};
    if (rm.status && rm.status !== 'PASS' && !violated.length && !unverified.length) {
      L.push(`⚠️ the killed-feature scan itself is ${rm.status} — ${[].concat(rm.why || []).slice(0, 2).join('; ') || 'no detail recorded'}.`);
    } else if (rm.corpusFreshness && rm.corpusFreshness !== 'CURRENT') {
      L.push(`⚠️ the killed-feature verdict was computed against files that have since changed (${rm.corpusFreshness}) — re-run \`node .claude/respawnpack/respawnpack.js removals\`.`);
    }
  }

  /*
   * ⛔ DF-005, SUMMARISED — AND ONLY SUMMARISED. The harness task list and the project's own gap/gate
   * records drift independently, wrong in both directions at once, and a session that never hears
   * about it keeps working from whichever list it happened to read.
   *
   * What is surfaced is the ESTABLISHED verdict, its counts, and the drifting identifiers — all of
   * which the compiler put in STATE.json. This hook does NOT read the project's task source. Injecting
   * a project's own task rows into a session as though they were truth is exactly the thing the
   * comparison exists to catch someone doing, and doing it here would be that, at boot, every time.
   */
  const rc = s.reconciliation || {};
  if (rc.status === 'DRIFT') {
    const ids = (rc.driftIds || []).slice(0, 6).join(', ');
    L.push(`⚠️ task/record reconciliation: DRIFT — ${rc.counts ? `${rc.counts.tasks} task record(s) vs ${rc.counts.project} project record(s), ${rc.counts.drift} disagreement(s)` : 'counts unrecorded'}`
      + `${ids ? ` (${ids}${rc.driftTruncated ? ', …' : ''})` : ''}. The two lists do not agree; neither is authoritative until they do.`);
  } else if (rc.status === 'CANNOT_DETERMINE') {
    L.push(`⚠️ task/record reconciliation could not conclude — ${String(rc.why || 'no detail recorded').slice(0, 220)}. This is NOT agreement.`);
  }

  // The ongoing goal is a durable project fact; naming it is safe. Its COMPLETION is volatile.
  if (s.goal) {
    const gc = s.goalCompletion || {};
    L.push(`Ongoing project goal (${s.ongoingGoalId || 'unnamed'}): ${s.goal}` +
      (fresh ? ` — completion ${gc.status || 'UNKNOWN'}${gc.why ? ` (${gc.why})` : ''}` : ' — completion status withheld (stale state)'));
    const staleness = goalStalenessNudge(dir, s.ongoingGoalId);
    if (staleness) L.push(staleness);
  }
  // Milestone is printed on its own line, always. Collapsing it into the goal line is how a corrective
  // milestone's completion got reported as the project's.
  if (s.milestone) L.push(`Milestone: ${s.milestone}${fresh ? ` — ${s.milestoneComplete ? 'complete' : 'in progress'}` : ' — status withheld (stale state)'}`);

  if (!fresh) {
    L.push('Counts, next unblocked work and blocker arithmetic: WITHHELD until state is regenerated.');
    return clip(L.join('\n'), STATE_BUDGET);
  }

  // --- volatile, fresh state only -----------------------------------------------------------------
  if (s.tracksRequirements && s.counts) {
    const c = s.counts;
    L.push(`Rows: ${c.conformant}/${c.mandatory} mandatory conformant · ${c.candidate} candidate · ${c.unevidenced} unevidenced · ${c.blocked} blocked${c.staleEvidence ? ` · ${c.staleEvidence} stale evidence` : ''}`);
  }
  if (s.openP0P1 && s.openP0P1.length) L.push(`Open P0/P1: ${s.openP0P1.join(', ')}`);
  if (s.currentAtomicTask) L.push(`Current atomic task: ${s.currentAtomicTask}`);
  if (s.nextUnblockedWork && s.nextUnblockedWork.length) {
    L.push(`Next unblocked: ${s.nextUnblockedWork.slice(0, 3).map((n) => `${n.id} ${n.title || ''}`.trim()).join(' · ')}`);
  }
  if (s.blockers && s.blockers.length) {
    L.push(`Blocked (these and their dependents ONLY — the project is ${s.projectBlocked ? '' : 'NOT '}blocked): ` +
      s.blockers.slice(0, 4).map((b) => `${b.id} ← ${(b.blockedBy || []).join(', ')}`).join(' · '));
  }
  if (s.cannotDetermine && s.cannotDetermine.length) L.push(`Could not be determined: ${s.cannotDetermine.join('; ')}`);

  return clip(L.join('\n'), STATE_BUDGET);
}

const NOTE_BLOCK = /<!-- RESPAWNPACK:NOTE[^>]*-->([\s\S]*?)<!-- \/RESPAWNPACK:NOTE -->/;
const NOTE_OPEN_RE = /<!-- RESPAWNPACK:NOTE[^>]*-->/;

/**
 * The human note from a kernel-rendered CONTINUITY (prose only, never numbers), from the ONE bounded
 * head read this hook already took (A7). Three outcomes, never a bare null that reads the same as three
 * different things:
 *   { note }        the bounded note, still cut at NOTE_BUDGET with the marker when it overflows;
 *   { note: null }  the block closed within the window and was empty or the placeholder;
 *   { beyondBound } the block did not open-and-close within the window; a hand edit may have pushed it
 *                   below the boot read bound, which is reported rather than mistaken for "no note".
 */
function humanNote(head) {
  if (!head) return { note: null };
  const m = NOTE_BLOCK.exec(head.text);
  if (m) {
    const note = m[1].trim();
    return { note: note && note !== '_(no human note)_' ? clip(note, NOTE_BUDGET) : null };
  }
  // No closed block in the window. If the open marker is present (block extends past the bound) or the
  // file simply ran past the window, the note may sit beyond it; say so. Only a file read whole with no
  // marker at all is a genuine "no note".
  if (NOTE_OPEN_RE.test(head.text) || head.truncated) return { beyondBound: true };
  return { note: null };
}

/*
 * ⛔ THE TWO WAYS A DERIVED DOC IS NOT A HANDOFF, DETECTED AT BOOT RATHER THAN AT CLOSEOUT.
 *
 * the 2026-08-07 field run §1 and §8 are the same complaint from two ends of a session:
 *
 *   §1 — `savepoint --verify` could never return 0 in that project, because CONTINUITY.md and GAPS.md
 *        were hand-authored and had never been migrated. The fix is gated behind a `--write` no agent
 *        will run unprompted at session END, so it never ran, so exit 2 was permanent. Its own
 *        suggested fix names the right moment: "detect the un-migrated state at SessionStart, not at
 *        savepoint time, and say plainly: this project has never been migrated."
 *
 *   §8 — a fresh session boots from the SEED TEMPLATE, literal `<…>` placeholders and all, "while the
 *        real state lives in PROJECT-STATUS.md, which the pack does not know about." Presenting an
 *        empty template as the handoff is worse than presenting nothing, because nothing prompts a
 *        question and a filled-looking template does not.
 *
 * ⛔ STRING MATCHING, NOT A KERNEL CALL — ON PURPOSE. `hooks/` cannot require `kernel/` (the arrow runs
 * the other way; see hooks/_manifest.js on why the two trees share exactly one module). So this reads
 * the two markers the renderer itself writes as literals. That is a real coupling and it is declared
 * here: if kernel/lib/render.js ever renames GEN_OPEN, this detector silently starts reporting every
 * rendered file as un-migrated. It is checked from both sides in hooks.test.mjs for that reason.
 */
const GEN_MARKER = '<!-- RESPAWNPACK:GENERATED';
const DERIVED_DOCS = [['CONTINUITY.md', 'CONTINUITY.md'], ['GAPS.md', 'GAPS.md']];

function derivedDocReadiness(dir, continuityHead) {
  const unmigrated = [], seeded = [], unscanned = [];
  for (const [name] of DERIVED_DOCS) {
    // CONTINUITY shares the one head read the note already took; GAPS gets its own bounded read. Both
    // markers (GEN and the seed stamp + placeholder) sit in the head of a rendered or seeded doc.
    const head = name === 'CONTINUITY.md' ? continuityHead : readHead(path.join(dir, 'docs', 'derived', name), GAPS_HEAD);
    if (!head) continue;
    const text = head.text;
    const rendered = text.includes(GEN_MARKER);
    /*
     * TWO signals, because each alone is wrong in a different direction:
     *   · the "(Seeded <date>.)" stamp is written by the INSTALLER and never by the renderer, so its
     *     presence proves the file has not been regenerated — but a founder who hand-filled the
     *     template and left the stamp line would be falsely accused;
     *   · a leftover `<placeholder>` proves nobody filled that section in — but angle brackets appear
     *     in ordinary prose, HTML comments and markdown autolinks too.
     * Requiring both is what makes this specific. The placeholder pattern must stay loose enough for
     * BOTH shipped shapes: CONTINUITY's whole-line `<the durable "where we are" …>` (76 chars) and
     * GAPS's inline table cells `| <id> | <title> | P<n> |` (4). An earlier form bounded the run at 60
     * chars and excluded any `:`, which silently missed BOTH of CONTINUITY's longest placeholders —
     * so the file that most needed the message was the one that did not get it. The exclusions now
     * name exactly what they are for: `!`/`/` skip HTML comment delimiters, `://` skips markdown
     * autolinks, and the run may not cross a newline.
     */
    if (rendered) continue;
    const hasStamp = /\(Seeded [^)]*\)/.test(text);
    const hasPlaceholder = /<(?![!/])(?:(?!:\/\/)[^<>\n]){1,120}>/.test(text.replace(/<!--[\s\S]*?-->/g, ''));
    /*
     * ⛔ A STAMP WITH NO PLACEHOLDER IN A FILE THAT RAN PAST THE BOUND IS UNSCANNED, NOT UN-MIGRATED
     * (A7). The seed stamp sits on line 1 but the placeholder that would confirm the seed may sit below
     * the bounded head; on a file longer than the window we cannot prove it is or is not a seed, so it
     * is named as "could not be fully checked" rather than silently rounded to un-migrated. A file read
     * WHOLE (not truncated) with a stamp and no placeholder genuinely is not a seed.
     */
    if (hasStamp && !hasPlaceholder && head.truncated) { unscanned.push(name); continue; }
    /*
     * ⛔ ONE MESSAGE PER FILE, NOT TWO — and the seed wins. A seed template is ALSO un-migrated (the
     * installer ships no generated block), so reporting both would fire two warnings at every
     * fresh-install boot. Worse, the migration advice is actively WRONG for a seed: migrating one
     * archives a placeholder and imports `<the durable "where we are">` into the protected note as
     * though it were someone's prose. "Nobody has filled this in" is the fact that changes what the
     * session does next; migration is what a project does once the file says something.
     */
    (hasStamp && hasPlaceholder ? seeded : unmigrated).push(name);
  }
  return { unmigrated, seeded, unscanned };
}

/*
 * ⭐ THE LESSONS LINE (P2-O-3). The pack promotes verified lessons into `memory/graph/<type>/<slug>.md`
 * and parks unreviewed leads in `memory/candidates/*.json`, and until the register existed a session
 * booted with no idea either directory was there — measured cost: thirteen candidates accumulating
 * across sessions because nobody was ever told. One line fixes that, and it is deliberately the
 * cheapest possible one: two counts and where to read the rest.
 *
 * ⛔ IT NEEDS NO FRESHNESS CAVEAT, AND THAT IS WHY IT COUNTS FILES RATHER THAN READING STATE.json.
 * Everything else structured in this block is a projection of one revision and is withheld when that
 * revision is superseded (anti-drift item 19, which this line does not touch). These two numbers are
 * properties of the tracked files as they sit on disk right now, so there is no revision they could be
 * stale against — the register they point at is a projection, the count is not.
 *
 * ⛔ AND IT IS ADDITIVE. It is pushed after the contract block and before the routing paragraph; it is
 * not part of the narrowed task-session short form (the runner already composed that turn's prompt);
 * and a store it cannot read costs this line only — nothing else in the boot block is withheld because
 * a memory directory was unreadable.
 *
 * ⛔ THE CANDIDATE HALF GOES THROUGH core/memory/candidates.js's `list()` — the SAME classified reader
 * the kernel's own review verb uses — rather than opening the JSON here. hooks/ may not require
 * kernel/, but core/ is host-neutral and already loaded above, so this is the one route that does not
 * become a second, unfenced interpretation of a store that already has an owner. A core/ that would not
 * load reports itself as an unreadable store rather than as an empty one.
 */
const LESSONS_DOC_REL = 'docs/derived/LESSONS.md';

/** Promoted entity files under memory/graph/, counted by NAME AND EXTENSION, never opened (A7). The
 *  count is the number of `.md` files on disk, which is what "promoted entity" means on disk, and a
 *  directory listing already answers it. The trade, stated here and in hooks/README.md: a file that is
 *  listed but cannot be READ is COUNTED here, whereas the kernel's register (kernel/respawnpack.js
 *  readGraphEntities) withholds its number for that same unreadable entity. The two numbers therefore
 *  agree for every readable store and disagree only when an entity cannot be read, where the boot line
 *  is a pointer at the register and the register's own render is the place that surfaces the fault. The
 *  earlier form opened every entity to keep the numbers byte-identical; at 500 entities that was one
 *  read per entity on every boot, for a count the listing already carries. */
function countGraphEntities(dir) {
  const root = path.join(dir, 'memory', 'graph');
  if (!fs.existsSync(root)) return { n: 0 };
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) n++;
    }
  };
  try { walk(root); } catch (e) { return { why: `memory/graph/ could not be listed (${(e && e.code) || 'ERROR'})` }; }
  return { n };
}

/** Candidate-state records in memory/candidates/, or the reason there is no count. */
function countCandidateLeads(dir) {
  if (!core) return { why: 'core/ (the host-neutral rollover core) could not be loaded' };
  let listed;
  try { listed = core.candidates.list({ dir: path.join(dir, 'memory', 'candidates') }); }
  catch (e) { return { why: `memory/candidates/ could not be listed (${(e && e.message) || e})` }; }
  if (listed.status !== 'OK') return { n: 0 };
  if ((listed.unreadable || []).length) {
    return { why: `${listed.unreadable.length} record(s) in memory/candidates/ could not be read (${listed.unreadable[0].file}: ${listed.unreadable[0].why})` };
  }
  return { n: listed.records.filter((r) => r.verificationState === 'candidate').length };
}

/** The one line, in its three states. Never null: silence here would be indistinguishable from zero. */
function lessonsLine(dir) {
  const g = countGraphEntities(dir), c = countCandidateLeads(dir);
  if (g.why || c.why) {
    return `📓 Lessons: store unreadable (${g.why || c.why}) — the promoted-lesson and candidate-lead counts could not be established at boot, so neither is stated. Nothing else in this block is withheld for it; \`${LESSONS_DOC_REL}\` and \`memory/candidates/\` are still there to read.`;
  }
  if (!g.n && !c.n) {
    return '📓 Lessons: none recorded yet — nothing has been promoted into `memory/graph/` and no candidate memory is awaiting review. `/savepoint` captures leads automatically; promotion is always an explicit, audited act.';
  }
  // The label comes from the store's own constant, never a second copy typed here: core/memory/candidates.js
  // owns the word an unverified lead is marked with, and a second spelling is how the two drift apart.
  return `📓 Lessons: ${g.n} verified in \`${LESSONS_DOC_REL}\` · ${c.n} candidates awaiting review. `
    + 'Read the register before re-investigating something; review the leads with `respawnpack memory candidates` — '
    + `until one is promoted it is an ${core.candidates.UNVERIFIED_MARKER}, never a fact to repeat.`;
}

/*
 * Fallback for projects with no kernel state: the original CONTINUITY extraction. Priority is
 * evidence-driven — a 🛑/⛔ pause outranks everything, because that is the class of thing whose
 * absence caused an agent to offer forbidden work.
 */
function extractLegacy(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'docs', 'derived', 'CONTINUITY.md'), 'utf8'); } catch { return null; }

  const halt = [], strong = [], prose = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('<!--')) continue;
    if (/[🛑⛔]/.test(t)) halt.push(t);
    else if (/\*\*[^*]*\b(PAUSED|BLOCKED|DO NOT|FORBIDDEN|FROZEN|HOLD)\b/i.test(t)) strong.push(t);
    else if (prose.length < 3 && t.length > 20) prose.push(t);
  }
  const picked = [...halt, ...strong, ...(halt.length || strong.length ? [] : prose)];
  if (!picked.length) return null;

  let out = '';
  for (const line of picked) {
    if (out.length + line.length > LEGACY_BUDGET) { out += '\n… (CONTINUITY.md truncated — read it in full before acting)'; break; }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

function renderHandoff(h) {
  const L = [`A compaction happened in this session. Recovered handoff (written ${h.writtenAt}${h.unverified ? ', ⚠️ READ-BACK WAS NOT VERIFIED — treat as unreliable' : ', read-back verified'}):`];
  if (h.head) L.push(`- revision at compaction: ${String(h.head).slice(0, 7)}`);
  if (h.atomicTask) L.push(`- atomic task in flight: ${typeof h.atomicTask === 'string' ? h.atomicTask : JSON.stringify(h.atomicTask)}`);
  if (h.uncommittedFiles && h.uncommittedFiles.length) {
    L.push(`- uncommitted at compaction (${h.uncommittedFiles.length}${h.uncommittedTruncated ? '+, truncated' : ''}): ${h.uncommittedFiles.slice(0, 12).join(', ')}`);
  }
  if (h.ledgerBehindHead) L.push('- ⚠️ .respawnpack/wave-ledger.md was BEHIND HEAD — a completed wave may be unrecorded');
  return clip(L.join('\n'), 900);
}

/**
 * v0.3 · Render a v2 rollover-handoff (core/state/handoff.js), OR a v1 record migrated through
 * `core.handoff.fromV1` — both share the v2 field shape, so one renderer covers both. Detects an
 * unverified v1 migration from `fromV1`'s own `unresolvedQuestions` note rather than re-deriving the
 * check, so the warning text stays in sync with whatever that shim decides is unresolved.
 */
function renderRolloverHandoff(h) {
  const unverifiedV1 = Array.isArray(h.unresolvedQuestions) && h.unresolvedQuestions.some((q) => /never read back/i.test(q));
  const L = [`A compaction happened in this session. Recovered handoff (written ${h.writtenAt}` +
    `${unverifiedV1 ? ', ⚠️ READ-BACK WAS NOT VERIFIED — treat as unreliable' : ', read-back verified'}):`];
  if (h.git && h.git.head) L.push(`- revision at compaction: ${String(h.git.head).slice(0, 7)}`);
  if (h.exactNextAction) L.push(`- atomic task in flight: ${h.exactNextAction}`);
  else if (h.atomicActionId) L.push(`- atomic task in flight: ${h.atomicActionId}`);
  if (h.git && Array.isArray(h.git.uncommittedFiles) && h.git.uncommittedFiles.length) {
    L.push(`- uncommitted at compaction (${h.git.uncommittedFiles.length}${h.git.uncommittedTruncated ? '+, truncated' : ''}): ${h.git.uncommittedFiles.slice(0, 12).join(', ')}`);
  }
  if (h.migratedFrom) L.push(`- migrated from a v${h.migratedFrom} handoff record`);
  return clip(L.join('\n'), 900);
}

/**
 * v0.3 · The most recent handoffId this machine has EVER associated with a verified handoff, even after
 * `verify-identity` has since CLEARED the live pointer. `m.verifiedHandoff()` answers "what is pending
 * RIGHT NOW"; a REDELIVERED SessionStart(compact) asks a different question — "what did the rollover
 * THAT JUST COMPLETED consume" — because by the time the redelivery's own process opens the machine, the
 * first delivery has already cleared the live pointer durably in the journal. The journal itself still
 * carries it: every transition row from `verify-handoff` through `observe-completion` repeats
 * `verifiedHandoff` unchanged, and only the `verify-identity` row's OWN entry is null. Scanning backward
 * for the last TRUTHY one finds exactly that value without assuming which row kind carried it.
 */
function lastKnownHandoffId(m) {
  const current = m.verifiedHandoff();
  if (current) return current.handoffId;
  const rows = m.rows();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'transition' && r.verifiedHandoff && r.verifiedHandoff.handoffId) return r.verifiedHandoff.handoffId;
  }
  return null;
}

/**
 * A machine failure, verbatim — both halves. `detail` is what happened THIS time; `recovery` is the
 * fixed instruction for that failure code (core/policy/failures.js). Neither substitutes for the other:
 * a code with detail and no recovery tells an operator what broke but not what to do about it.
 */
function describeFailure(f) {
  if (!f) return 'no further detail';
  return `${f.code}: ${f.detail || 'no detail recorded'} — ${f.recovery}`;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* minimal/absent stdin — routing is static, inject anyway */ }

  // The installed project root (rt.projectRoot), never the shell's cwd: a session resumed from a linked
  // worktree, a nested repository or a subdirectory must baseline and read its contract under the ONE
  // runtime tree, so a subagent and its orchestrator share one contract rather than resolving two.
  const dir = rt.projectRoot(input);

  // Record the baseline the Stop hook subtracts. Best-effort: a non-git target simply has no baseline,
  // and the Stop hook stays quiet rather than guessing. The return value doubles below as the answer to
  // "did the runtime a task session leans on actually get established" — captured, never re-derived.
  let baseline = null;
  try { baseline = rt.captureBaseline(dir, input.session_id); } catch { /* never let bookkeeping break the boot */ }

  /*
   * ⛔ TASK-SESSION SHORT FORM (P5-T-16c; the hooks-and-install audit §6; anti-drift item 18).
   *
   * `RESPAWNPACK_TASK_ID` is set by adapters/claude-code/task-runner/runner.js on the child session's
   * OWN environment — never written by this hook. That runner already composed ITS turn's prompt from
   * the same STATE.json / CONTINUITY.md / contract sources the full boot block below reads, so injecting
   * the whole block again here would double the boot budget and, worse, risks a second and slightly
   * different account of the same facts. Only a short reminder is injected instead.
   *
   * ⛔ THE BASELINE ABOVE IS NOT PART OF WHAT THIS SKIPS — it already ran, unconditionally, on the same
   * line and in the same position whether or not this variable is set. Anti-drift item 18 is that no
   * profile may turn the baseline off; this is narrower than a profile (a bare environment variable) and
   * gets no more leverage over it. The Stop-side detection in stop-savepoint.js depends on this baseline
   * existing even when — especially when — a task session downgrades the block itself (this task's other
   * half).
   *
   * ⛔ A SPOOFED VALUE NARROWS PRINTED OUTPUT, NEVER SAFETY. Nothing here authenticates the variable —
   * any process may set it. That is acceptable only because this branch decides exclusively what gets
   * PRINTED here; the baseline capture above and stop-savepoint's detection run exactly the same either
   * way, so a spoofed value cannot hide a session's work, only how this one hook narrates its own boot.
   *
   * ⛔ WHEN THE RUNTIME COULD NOT BE ESTABLISHED, THE SHORT FORM IS WITHDRAWN, NOT KEPT. A null
   * `baseline` means captureBaseline could not do its job (today: not a git repository, so treeState has
   * nothing to snapshot) — so the one guarantee this short form leans on, item 18's baseline existing for
   * Stop to diff against, did not hold. Printing the short form anyway would rest a narrower boot on a
   * promise that was just broken. Falling through to the ordinary boot block below is exactly what every
   * non-task session already gets, so that is what an unestablished runtime gets too, with one line added
   * saying why — on the same channel (additionalContext) every other best-effort step in this hook
   * already uses to report what it could not do, never a crash and never a silent narrowing.
   */
  const taskId = process.env.RESPAWNPACK_TASK_ID && String(process.env.RESPAWNPACK_TASK_ID).trim();
  if (taskId && baseline) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `RespawnPack task session ${taskId}: the task runner already composed this turn's prompt from the ` +
          'same STATE.json / CONTINUITY.md / contract sources this hook would otherwise inject here, so the ' +
          'full boot block is skipped — printing it again would double the boot budget and could disagree ' +
          'with what the runner already sent. The session tree baseline was still recorded for the Stop hook ' +
          'to diff against.',
      },
    }));
    process.exit(0);
  }

  const parts = [];
  if (taskId && !baseline) {
    parts.push(
      `⚠️ RespawnPack task session ${taskId}: the session tree baseline could not be recorded (the project ` +
      'is not a git repository, or its working tree could not be read), so the short task-scope reminder ' +
      'this variable normally injects was withdrawn. Falling back to the ordinary boot block below.',
    );
  }

  // 1. Durable state — validated, then injected.
  let read = { status: 'ABSENT' };
  try { read = rt.readDurableState(dir); } catch { /* fall through to the legacy path */ }
  if (read.status !== 'ABSENT') {
    parts.push(`📊 CURRENT PROJECT STATE (generated, from docs/derived/STATE.json):\n${renderState(read, dir)}`);
  } else {
    const legacy = extractLegacy(dir);
    if (legacy) {
      parts.push(
        '⚠️ CURRENT PROJECT STATE (docs/derived/CONTINUITY.md — prose, not generated; no docs/derived/STATE.json ' +
        `in this project, so these are unverified assertions rather than derived facts):\n${legacy}`,
      );
    }
  }

  // A freshness withhold is a catch worth recording: renderState() above suppressed every volatile
  // figure because STATE.json could not be trusted (STALE, or CANNOT_DETERMINE treated as stale). ABSENT
  // is not a withhold — there is no figure to suppress — and CURRENT is a pass. Best-effort and
  // machine-local: the withhold already happened whether or not this line lands. The counter is keyed on
  // `projectRoot(input)`, the canonical project root doctor and aar read, so a session booted in a
  // subdirectory does not split the counter from where it is reported (the Scenario-M split).
  if (read.status === 'STALE' || read.status === 'CANNOT_DETERMINE') {
    try { rt.recordCatch(rt.projectRoot(input), { guard: 'freshness', event: 'withhold', reason: `${read.status}: ${read.detail || 'volatile figures withheld'}`, sessionId: input.session_id }); }
    catch { /* a counter that cannot be written never changes what this hook injects */ }
  }

  /*
   * 2. A compaction handoff, consumed exactly once.
   *
   * ⛔ v0.3 · SOURCE-AWARE — see the file header. `source === 'compact'` is the only case that touches
   * the rollover machine; every other source keeps the ORIGINAL v0.2 behavior in the else branch,
   * UNCHANGED, because that unconditional check predates this branch and nothing here narrows it.
   */
  if (input.source === 'compact' && core) {
    const sidC = String(input.session_id || 'unknown');
    let pendingHandoffId = null, cycleBefore = null, m = null;
    try {
      const opened = core.machine.open({ projectDir: dir, host: core.evidence.HOSTS.CLAUDE_CODE, conversationId: sidC });
      if (!opened.ok) {
        parts.push(`⚠️ rollover bookkeeping unavailable: ${describeFailure(opened.failure)}`);
      } else {
        m = opened.machine;
        cycleBefore = m.cycleId();
        pendingHandoffId = lastKnownHandoffId(m);
        // A STABLE tag across a redelivered SessionStart(compact): cycleBefore itself changes the moment
        // verify-identity succeeds, so it cannot be the dedup key — the handoffId (or its absence) is the
        // one thing that stays the same between the first delivery and a redelivery of the same event.
        const eventTag = pendingHandoffId ? `handoff:${pendingHandoffId}` : `nohandoff:${sidC}`;

        const completedEvidence = core.evidence.make(core.evidence.KINDS.COMPACT_COMPLETED, {
          signal: 'session_start_compact', raw: input,
        });
        const obs = m.apply({ transition: 'observe-completion', eventId: eventTag, evidence: [completedEvidence] });

        if (obs.status !== 'APPLIED' && obs.status !== 'NOOP') {
          parts.push(`⚠️ rollover machine: observe-completion ${obs.status} — ${describeFailure(obs.failure)}. This compaction is not tracked as an in-place rollover.`);
        } else if (obs.status === 'NOOP') {
          parts.push('rollover machine: observe-completion already recorded for this compaction (redelivery).');
        } else {
          const persisted = core.cycle.readPersisted(m.dir);
          const expectedId = (persisted.status === 'OK' && persisted.cycle && persisted.cycle.conversationId) || sidC;
          const identityEvidence = core.evidence.make(core.evidence.KINDS.IDENTITY_VERIFICATION, {
            expectedId, observedId: sidC, equal: expectedId === sidC, raw: input,
          });
          const idApplied = m.apply({ transition: 'verify-identity', eventId: eventTag, evidence: [identityEvidence] });
          if (idApplied.status !== 'APPLIED' && idApplied.status !== 'NOOP') {
            parts.push(`⚠️ rollover machine: verify-identity ${idApplied.status} — ${describeFailure(idApplied.failure)}. Do not treat this as a proven in-place rollover.`);
          } else if (idApplied.status === 'APPLIED' && idApplied.cycleAdvanced) {
            parts.push(`In-place rollover: same session ${sidC}, context cycle ${cycleBefore} -> ${m.cycleId()}.`);
          }
        }
      }
    } catch (e) {
      parts.push(`⚠️ rollover machine threw: ${e && e.message}`);
    }

    let injected = false;
    if (pendingHandoffId && m) {
      try {
        const consumed = core.handoff.consume(m.dir, pendingHandoffId, { consumerId: `session-start:${sidC}` });
        if (consumed.status === 'CONSUMED') {
          parts.push(`♻️ ${renderRolloverHandoff(consumed.handoff)}`);
          injected = true;
        } else if (consumed.status === 'ALREADY_CONSUMED') {
          parts.push(`♻️ compaction handoff already consumed (by ${consumed.firstConsumption.consumerId} at ` +
            `${consumed.firstConsumption.consumedAt}) — not injected a second time.`);
          injected = true;
        } else {
          parts.push(`⚠️ compaction handoff could not be consumed: ${describeFailure(consumed.failure)}`);
        }
      } catch (e) { parts.push(`⚠️ handoff consumption threw: ${e && e.message}`); }
    }

    if (!injected) {
      // No v2 handoff was ever recorded for this conversation (an older install, or a machine that never
      // reached COMPACTING) — fall back to the v1 record, migrated through core.handoff.fromV1.
      try {
        const h = rt.takePrecompactHandoff(dir, input.session_id);
        if (h) {
          let rendered = renderHandoff(h); // the plain v1 render always works, even if the shim throws
          try {
            const shim = core.handoff.fromV1(h, {
              host: core.evidence.HOSTS.CLAUDE_CODE,
              contextCycleId: cycleBefore || `claude-code:${sidC}:0:unestablished`,
            });
            if (shim.ok) rendered = `${renderRolloverHandoff(shim.handoff)} (migrated v1)`;
          } catch { /* the plain v1 render above already covers this */ }
          parts.push(`♻️ ${rendered}`);
        }
      } catch { /* a handoff we cannot read must not break the boot */ }
    }

    // The v1 record and the v2 handoff describe the SAME compaction — mark v1 consumed regardless of
    // which path actually delivered the content, so an old reader never sees a pending v1 record for a
    // compaction this hook already handled. A no-op when there is no v1 record at all.
    try { rt.markPrecompactConsumed(dir, input.session_id); } catch { /* best-effort bookkeeping */ }
  } else if (input.source === 'compact' && !core) {
    // core/ failed to load — degrade to the v1-only path (same as v0.2) and say why v2 is silent.
    parts.push('⚠️ rollover core unavailable — falling back to the v1 handoff only.');
    try {
      const h = rt.takePrecompactHandoff(dir, input.session_id);
      if (h) { parts.push(`♻️ ${renderHandoff(h)}`); rt.markPrecompactConsumed(dir, input.session_id); }
    } catch { /* a handoff we cannot read must not break the boot */ }
  } else {
    // Every other source: the ORIGINAL v0.2 behavior, unconditional and unchanged.
    try {
      const h = rt.takePrecompactHandoff(dir, input.session_id);
      if (h) { parts.push(`♻️ ${renderHandoff(h)}`); rt.markPrecompactConsumed(dir, input.session_id); }
    } catch { /* a handoff we cannot read must not break the boot */ }
  }

  // A7 · ONE bounded head read of CONTINUITY serves both the human note (3) and the readiness scan (3b).
  // The NOTE block and the GEN/seed markers all sit at the top of the document by construction, so this
  // never opens the whole file for either consumer.
  const continuityHead = readHead(path.join(dir, 'docs', 'derived', 'CONTINUITY.md'), CONTINUITY_HEAD);

  // 3. The human note — the one thing CONTINUITY is uniquely good for.
  if (read.status !== 'ABSENT') {
    const n = humanNote(continuityHead);
    if (n.note) parts.push(`📝 Human note (docs/derived/CONTINUITY.md):\n${n.note}`);
    else if (n.beyondBound) {
      parts.push(
        `📝 Human note: the docs/derived/CONTINUITY.md NOTE block was not found within the first ` +
        `${CONTINUITY_HEAD / 1024} KB this hook reads at boot. A kernel-rendered CONTINUITY keeps that ` +
        'block at the top of the file, so a hand edit may have moved it below the read bound; open the ' +
        'file to read the note rather than treating this as "no note".',
      );
    }
  }

  /*
   * 3b. Whether the derived docs are usable as a handoff AT ALL — said now, at boot, because both
   * failures below are invisible until closeout and unfixable at closeout. See derivedDocReadiness().
   */
  const ready = derivedDocReadiness(dir, continuityHead);
  if (ready.unmigrated.length) {
    parts.push(
      `⚠️ NOT YET MIGRATED: ${ready.unmigrated.join(' and ')} ${ready.unmigrated.length > 1 ? 'are' : 'is'} hand-authored — ` +
      'no kernel-generated block. Until this runs, `savepoint --verify` CANNOT return 0 in this project: ' +
      `${ready.unmigrated.length > 1 ? 'those checks report' : 'that check reports'} CANNOT_DETERMINE forever, and every ` +
      'closeout is honestly "blocked".\n' +
      '  Fix (safe, and reversible — that is new): `node .claude/respawnpack/respawnpack.js savepoint --verify --write`\n' +
      '  It archives each original VERBATIM to docs/derived/_archive/<name>.pre-kernel.md and imports its prose into a ' +
      'protected NOTE block that survives every later regeneration. To undo it: ' +
      '`node .claude/respawnpack/respawnpack.js restore-derived <name> --write` (preview without --write; the archive is ' +
      'never deleted, so this goes both ways as often as you like).\n' +
      '  Do this at the START of a session, not at closeout — it rewrites two documents, which is not a thing to ' +
      'discover while wrapping up.',
    );
  }
  if (ready.seeded.length) {
    parts.push(
      `⚠️ STILL THE SEED TEMPLATE: ${ready.seeded.join(' and ')} still ${ready.seeded.length > 1 ? 'carry' : 'carries'} the ` +
      `installer's literal \`<…>\` placeholders. Whatever this project actually uses to track its state, it is NOT ` +
      `${ready.seeded.length > 1 ? 'these files' : 'this file'} — do not read ${ready.seeded.length > 1 ? 'them' : 'it'} as a ` +
      'handoff, and do not treat the emptiness as "nothing in flight". Ask where the real state lives (a PROJECT-STATUS.md, ' +
      'an issue tracker, the git log) and say plainly that the pack\'s handoff document has never been filled in.',
    );
  }
  if (ready.unscanned.length) {
    parts.push(
      `⚠️ COULD NOT FULLY CHECK: ${ready.unscanned.join(' and ')} ${ready.unscanned.length > 1 ? 'carry' : 'carries'} the ` +
      `installer's "(Seeded …)" stamp but no \`<placeholder>\` was found in the first ${GAPS_HEAD / 1024} KB, and the ` +
      `${ready.unscanned.length > 1 ? 'files run' : 'file runs'} past that bound, so whether ` +
      `${ready.unscanned.length > 1 ? 'they are' : 'it is'} still the seed template or has been filled in cannot be told ` +
      `from the bounded boot read. Open ${ready.unscanned.length > 1 ? 'them' : 'it'} to confirm before trusting it as a handoff.`,
    );
  }

  /*
   * 4. COMPOSE the session's runtime contract with the durable state — at injection time, never by
   * persisting runtime facts back into STATE.json. This is the seam: the project's ongoing goal came
   * from the tracked file above; whether THIS machine is currently driving it autonomously comes from
   * gitignored runtime state and stops at the edge of this string.
   */
  const contract = rt.readContract(dir);
  const ongoing = read.state && read.state.ongoingGoalId;
  /*
   * ⛔ A REFUSED GOAL CONTRACT IS ANNOUNCED, NEVER SILENTLY EMPTIED. The reader used to assign nothing
   * when goal.json could not be accepted, so a session entered GOAL mode carrying no constraints and
   * no forbidden actions and had no way to tell that from a goal that genuinely has none. Losing a
   * prohibition costs more than losing a schedule, so this line goes FIRST and says what to do.
   */
  if (contract.goalContractRefused) {
    parts.push(
      `⛔ THE GOAL CONTRACT COULD NOT BE READ — ${clip(String(contract.goalContractRefused), 400)}\n`
      + 'Its constraints, authority and FORBIDDEN ACTIONS are therefore UNKNOWN, not empty. Do not treat this as a '
      + 'goal without restrictions: repair docs/derived/state/goal.json, or run '
      + '`node .claude/respawnpack/respawnpack.js contract collaborate` and proceed by proposing rather than self-dispatching.',
    );
  }
  /*
   * ⛔ ALL THREE SAFETY FIELDS, NOT TWO — AND THIS LINE CARRIED ONE.
   *
   * Reproduced on a real disposable installed target at d6ea9e8 while writing the dogfood acceptance.
   * A goal opened with `--constraints`, `--forbidden` AND `--authority`:
   *
   *   with STATE.json compiled     constraint ✅ (safety block)  forbidden ✅ (twice)  authority ❌
   *   in the pre-compile window    constraint ❌                 forbidden ✅          authority ❌
   *
   * `rt.readContract()` RESOLVES all three, `state.js` carries all three, `goal.json` stores all three.
   * Every layer had them; the last one printed one. And the pre-compile window is not a corner case —
   * it is every session between `contract goal` and the next `state` run, which is exactly when an
   * agent is most likely to act on a fresh goal.
   *
   * That is DF-RA-01's shape, one field over: the pause was correctly recorded and simply never
   * arrived, and an agent that never volunteers to read the file proposed prohibited work.
   *
   * ⭐ AUTHORITY BELONGS **HERE** AND NOT IN THE STALE-TOLERANT SAFETY BLOCK ABOVE. That block
   * deliberately surfaces prohibitions even from a stale projection, because acting on a superseded
   * prohibition costs a wasted question while acting on a superseded schedule costs wrong work.
   * Authority is asymmetric the other way: a stale grant that is too WIDE authorises work nobody
   * approved. So it travels with the runtime contract, which is current by construction, and is
   * withheld rather than shown stale. The constraint is repeated here for the same reason it is shown
   * stale above — a prohibition is cheap to over-deliver and expensive to miss.
   */
  if (contract.mode !== 'collaborate') {
    const list = (v) => [].concat(v || []).filter(Boolean);
    parts.push(
      `Active interaction contract (this session, this machine): ${contract.mode.toUpperCase()}` +
      (contract.goal ? ` — driving the ongoing goal: ${clip(String(contract.goal), 300)}` : '') +
      (contract.task ? ` — bounded task: ${clip(String(contract.task), 300)}` : '') +
      (contract.acceptance && contract.acceptance.length ? ` · acceptance: ${list(contract.acceptance).join('; ').slice(0, 300)}` : '') +
      (list(contract.constraints).length ? ` · constraints: ${list(contract.constraints).join(', ').slice(0, 300)}` : '') +
      (list(contract.authority).length ? ` · authority (this contract may touch ONLY this; anything wider is out of scope): ${list(contract.authority).join(', ').slice(0, 300)}` : '') +
      (contract.forbidden && contract.forbidden.length ? ` · forbidden: ${list(contract.forbidden).join(', ').slice(0, 300)}` : ''),
    );
  } else if (contract.suspendedGoalId || ongoing) {
    const id = contract.suspendedGoalId || ongoing;
    parts.push(
      `Interaction contract: COLLABORATE. The project has an ONGOING goal (${id}); autonomy on this machine is ` +
      'SUSPENDED — the goal is not cancelled and is still assessed in durable state. Resume autonomy with ' +
      '`node .claude/respawnpack/respawnpack.js contract goal --resume`. Until then, propose and wait rather than self-dispatching.',
    );
  }

  // 5. What this project has already learned — see lessonsLine above for why this needs no freshness
  // caveat and why an unreadable store costs this line and nothing else. This is the LAST section of the
  // boot block (A7 retired the routing paragraph that used to follow it; the routing map lives in the
  // skills layer now; see the file header).
  parts.push(lessonsLine(dir));

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }));
  process.exit(0);
});

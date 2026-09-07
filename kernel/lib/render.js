/*
 * RespawnPack · kernel/lib/render.js — render the derived docs FROM state, then verify the rendering.
 *
 * ⛔ DF-011, THE HIGHEST-VALUE FINDING IN THE DOGFOOD LOG. A savepoint reported success and passed all
 * five of its drift checks while `GOAL.md` called four gates "not started" that were passing, and
 * `GAPS.md` reported 50/110/66 against an actual 48/112/62. Its root cause generalises:
 *
 *   "/savepoint edits what the session BELIEVES it changed. It has no step that re-derives the numbers
 *    from the artifacts they come from. Every one of those counts exists in machine-readable form; not
 *    one was compared against it. The five drift checks that DID pass check artifact-vs-source
 *    consistency — nothing checks PROSE-vs-artifact, which is precisely the gap the derived docs live in."
 *
 * And the reason a careful human re-read did not catch it either: "re-reading is a JUDGEMENT check and
 * stale-but-plausible integers are exactly what judgement skims past."
 *
 * So this module does two things and treats them as different jobs:
 *   render()  — generate the live sections from STATE.json, so no model ever hand-writes a count;
 *   verify()  — parse every numeric claim back out of the rendered prose and compare it to the rows it
 *               came from. Disagreement is a FAIL. Zero claims parsed is CANNOT_DETERMINE.
 *
 * The bounded human note survives regeneration: a derived doc that cannot carry one sentence of human
 * context gets hand-edited anyway, and then the generator and the human fight over the file forever.
 * Bounded VISIBLY: a note over NOTE_BUDGET ends in a marker, its full text is archived, and savepoint
 * carries a `note:budget` row for it — a cut nobody is told about would be this module breaking its own
 * "nothing is silently lost" rule (see planNote below).
 */
const crypto = require('crypto');
const { OUTCOME, result, verdictFromCount } = require('./outcome.js');
const { numericClaims, liveClause, normalise } = require('./assert.js');
// Bare handle, not destructured — the file component of a check id is normalised to forward slashes at
// construction (BUG-2 / K-02) with the SAME posix() removals.js already exports for its own ids, rather
// than a second copy growing here. `file` is left untouched everywhere else in this module (detail text,
// archive paths): only the four id template literals below are wrapped.
const removalsLib = require('./removals.js');

const GEN_OPEN = '<!-- RESPAWNPACK:GENERATED — do not hand-edit below this line -->';
const GEN_CLOSE = '<!-- /RESPAWNPACK:GENERATED -->';
const NOTE_OPEN = '<!-- RESPAWNPACK:NOTE — hand-written, preserved across regeneration -->';
const NOTE_CLOSE = '<!-- /RESPAWNPACK:NOTE -->';
const NOTE_BUDGET = 1200; // a note, not a second handoff document — UTF-16 units, i.e. String.length

/*
 * The label→value map. These are the words the renderer uses AND the words the verifier looks for, so
 * the two cannot drift apart: a count that gets rendered under a label the verifier does not know would
 * be unverifiable, and the verifier reports exactly that rather than passing it.
 */
function countMap(state) {
  const c = state.counts || {};
  return {
    'mandatory requirements': c.mandatory, 'conformant': c.conformant, 'candidate': c.candidate,
    'unevidenced': c.unevidenced, 'waived': c.waived, 'blocked': c.blocked,
    'requirements total': c.total, 'stale evidence artifacts': c.staleEvidence,
    'open p0/p1': (state.openP0P1 || []).length,
    'next unblocked': (state.nextUnblockedWork || []).length,
  };
}

/*
 * ⛔ THE BUDGET IS A CUT, AND A CUT NOBODY IS TOLD ABOUT IS A DELETION.
 *
 * `extractNote` used to `.slice(0, NOTE_BUDGET)` and return the result, full stop. On a real target
 * (2026-08-16) a ~4,500-char note written into the NOTE block came back from `savepoint --write` at exactly
 * 1,200 chars, ending mid-word, five bullets gone — no ellipsis, no console line, no `checks[]` row, and
 * the savepoint reported PASS. That is this header's own rule ("nothing is silently lost") broken by the
 * one function that carries the human's words, and it is DF-011's shape again: the document said less
 * than the source and every check agreed with the document.
 *
 * The budget itself stays — a note is not a second handoff document. What changes is that overflow is now
 * VISIBLE in three places, none of which can be skipped:
 *   1. the rendered block ends in a marker naming the budget, the number of chars dropped and the archive
 *      that holds the full text — INSIDE the budget, so a re-render of the bounded note is stable and
 *      does not truncate itself again;
 *   2. planNote() reports the overflow to the caller, which archives the FULL note verbatim to
 *      docs/derived/_archive/<name>.note-overflow-<day>-<digest>.md BEFORE writing the bounded doc
 *      (archive-never-delete; content-addressed, so a re-run finds its own archive and clobbers nothing);
 *   3. noteBudgetCheck() is a `note:budget:<file>` row in savepoint's checks — FAIL whenever the note is
 *      over budget, in --verify (before anything is cut) and in --write (after it was cut and archived).
 *
 * IT REPORTS, IT DOES NOT WRITE — the same discipline as planMigration/planRestore below: the caller owns
 * the filesystem, so the plan previews for free and the archive write is an explicit act.
 */

/** The note exactly as it sits in the file (trimmed), before any budget — the text a caller archives. */
function rawNote(existing) {
  if (!existing) return '';
  const m = new RegExp(`${NOTE_OPEN}([\\s\\S]*?)${NOTE_CLOSE}`).exec(existing);
  return m ? m[1].trim() : '';
}

/*
 * Cut at `n` UTF-16 units WITHOUT splitting a surrogate pair. The budget is String.length, so a cut can
 * land between the two halves of an astral character (an emoji, a supplementary-plane ideograph); the
 * lone high surrogate becomes U+FFFD the moment the file is written as UTF-8, and the doc-vs-archive
 * arithmetic stops being honest. Backing off one unit keeps every character whole.
 */
function cutAt(text, n) {
  const s = String(text);
  if (s.length <= n) return s;
  let end = Math.max(0, n);
  const code = end > 0 ? s.charCodeAt(end - 1) : 0;
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Where the full text of an over-budget note goes. Content-addressed, so a re-run archives nothing new. */
function noteArchiveRel(name, full, generatedAt) {
  const base = String(name).replace(/\.md$/, '');
  const day = String(generatedAt || '').slice(0, 10).replace(/[^0-9A-Za-z-]/g, '-') || 'undated';
  const digest = crypto.createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 12);
  return `docs/derived/_archive/${base}.note-overflow-${day}-${digest}.md`;
}

function overflowMarker(dropped, archiveRel) {
  return `…[note truncated at ${NOTE_BUDGET} chars — ${dropped} chars dropped; full text archived to ${archiveRel}]`;
}

/**
 * planNote — bound the NOTE block to NOTE_BUDGET and REPORT the cut, never perform it silently.
 * Returns { full, text, overflow, length, budget, kept, dropped, archiveRel }: `text` is what the renderer
 * writes into the block (the note itself when it fits; the kept prefix plus the marker when it does not),
 * `full` is what the caller archives to `archiveRel` before writing the bounded doc.
 */
function planNote(existing, name, state) {
  const full = rawNote(existing);
  const budget = NOTE_BUDGET;
  if (full.length <= budget) {
    return { full, text: full, overflow: false, length: full.length, budget, kept: full.length, dropped: 0, archiveRel: null };
  }
  const archiveRel = noteArchiveRel(name, full, state && state.generatedAt);
  // Reserve room for the marker using the widest count it could carry (`length`, since dropped ≤ length),
  // then state the exact number — so kept + marker never exceeds the budget, and the next run reads the
  // bounded note back as within budget rather than truncating it again.
  const kept = cutAt(full, budget - overflowMarker(full.length, archiveRel).length);
  const dropped = full.length - kept.length;
  return { full, text: `${kept}${overflowMarker(dropped, archiveRel)}`, overflow: true, length: full.length, budget, kept: kept.length, dropped, archiveRel };
}

/**
 * The `note:budget:<file>` row. PASS only when the note fits; over budget is FAIL in both modes.
 * Marked `ephemeral: true`: whenever it overflows, the full note is already archived verbatim (see
 * planNote above), so auto-capturing this row as a candidate memory would duplicate that archive
 * rather than record a new lead. kernel/respawnpack.js's runCandidateCapture() skips ephemeral rows.
 */
function noteBudgetCheck(plan, { file = 'derived doc', write = false } = {}) {
  // BUG-2 / K-02: id only — `file` itself is untouched, and nothing below this line reads it again.
  const check = `note:budget:${removalsLib.posix(file)}`;
  if (!plan.overflow) {
    return result(OUTCOME.PASS, check, `NOTE block is ${plan.length}/${plan.budget} chars — within budget, nothing cut`, { checked: 1, ephemeral: true });
  }
  const over = plan.length - plan.budget;
  return result(OUTCOME.FAIL, check, write
    ? `NOTE block was ${plan.length} chars, ${over} over the ${plan.budget}-char budget — kept ${plan.kept} chars behind a visible truncation marker and archived the full note verbatim to ${plan.archiveRel}. Trim the note (or accept the archive); the next run passes once the block fits.`
    : `NOTE block is ${plan.length} chars, ${over} over the ${plan.budget}-char budget. --write would keep the first ${plan.kept} chars, end them with a visible truncation marker, and archive the full note verbatim to ${plan.archiveRel}. Trim the note before writing, or accept the archive — nothing is cut silently.`,
  { checked: 1, ephemeral: true });
}

/*
 * ⛔ MIGRATION: THE FIRST --write MUST NOT DESTROY A HAND-AUTHORED DOC.
 *
 * Every project that adopts this kernel already has a CONTINUITY.md and a GAPS.md someone wrote by
 * hand, and the pack's own rule is archive-never-delete. Overwriting them on first render would be the
 * pack breaking its own rule at exactly the moment a user is deciding whether to trust it.
 *
 * So a legacy file (one with no generated block) is:
 *   1. archived verbatim to docs/derived/_archive/<name>.pre-kernel.md,
 *   2. summarised into the protected NOTE block, which regeneration preserves,
 *   3. pointed at from that note, so nothing is silently lost.
 *
 * IDEMPOTENT by construction: the trigger is the ABSENCE of a generated block, so a second run sees a
 * migrated file, takes the existing note, and archives nothing. The archive write is skipped if the
 * target already exists, so a re-run can never clobber the original either.
 */
function planMigration(existing, name) {
  if (existing === null || existing === undefined) return { needed: false, reason: 'no existing file' };
  if (generatedBlockOf(existing) !== null) return { needed: false, reason: 'already kernel-rendered' };

  // Strip headings and HTML comments; keep the prose a human actually wrote.
  const prose = String(existing).split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^<!--/.test(l.trim()))
    .join('\n').trim();

  const archiveRel = `docs/derived/_archive/${name.replace(/\.md$/, '')}.pre-kernel.md`;
  const trailer = `\n\n_(Migrated from the hand-authored ${name} when the state kernel first rendered it. ` +
    `Full original preserved verbatim at \`${archiveRel}\` — archive, never delete. Edit this NOTE block; ` +
    'everything below the GENERATED marker is rewritten from `docs/derived/STATE.json`.)_';
  /*
   * ⛔ THE SEEDED NOTE MUST FIT THE BUDGET WITH ITS TRAILER. This reserved a flat 200 chars for a trailer
   * that is ~300, so a long legacy doc seeded a 1,308-char note and the very first render cut it to 1,200
   * — through the sentence that names the archive, i.e. the one line that makes the migration reversible.
   * Sized from the trailer itself now: `…` marks the cut and the trailer says where the rest is, so the
   * excerpt is the migration's own overflow marker and planNote has nothing left to cut.
   */
  const room = NOTE_BUDGET - trailer.length - 1; // 1 for the ellipsis
  const excerpt = prose.length > room ? `${cutAt(prose, room)}…` : prose;

  return {
    needed: true,
    archiveRel,
    note: `${excerpt}${trailer}`,
    originalBytes: existing.length,
    proseLines: prose.split('\n').length,
  };
}

/*
 * ⛔ THE INVERSE, BECAUSE A ONE-WAY DOOR DOES NOT GET WALKED THROUGH.
 *
 * planMigration above is correct and careful — it archives verbatim, never clobbers, and is idempotent.
 * It was also, in practice, never run. The the 2026-08-07 field run (§1) recorded why: `--write`
 * archives CONTINUITY.md and GAPS.md and REWRITES them, "not something an agent should do unprompted at
 * session end, so it never happens, so exit 2 persists forever." A migration nobody dares run is
 * indistinguishable from a migration that does not exist, and the check it gates stays red for the life
 * of the project.
 *
 * The archive is what makes the reverse possible, and it was already being written — it just had no
 * reader. `planRestore` is that reader: it names the archived original for a file and reports whether
 * restoring is possible, so the operator's question changes from "is this irreversible?" (it was) to
 * "can I undo this?" (yes, and here is the command).
 *
 * ⛔ IT REPORTS, IT DOES NOT WRITE. Same discipline as planMigration: the caller owns the filesystem, so
 * a preview costs nothing and a restore is always an explicit act. And the archive is NEVER deleted by
 * restoring — archive-never-delete is the pack's rule in both directions, so a restore followed by a
 * re-migration finds the same original still sitting there.
 */
function planRestore(name, archiveText, currentText) {
  const archiveRel = `docs/derived/_archive/${name.replace(/\.md$/, '')}.pre-kernel.md`;
  if (archiveText === null || archiveText === undefined) {
    return { possible: false, archiveRel, reason: `no archived original at ${archiveRel} — this file was never migrated by the kernel, so there is nothing to restore` };
  }
  if (!String(archiveText).trim()) {
    return { possible: false, archiveRel, reason: `${archiveRel} is empty — restoring it would replace the current file with nothing` };
  }
  const currentIsRendered = currentText !== null && currentText !== undefined && generatedBlockOf(currentText) !== null;
  return {
    possible: true,
    archiveRel,
    text: String(archiveText),
    restoredBytes: String(archiveText).length,
    replacedBytes: currentText === null || currentText === undefined ? 0 : String(currentText).length,
    // Stated so the caller can warn rather than surprise: restoring a file nobody migrated (no generated
    // block) still works, but it is overwriting something the kernel does not own.
    currentIsRendered,
    note: currentIsRendered
      ? `${name} is currently kernel-rendered; restoring puts the pre-kernel original back and the NOTE block's edits are lost (the archive itself is kept either way).`
      : `${name} carries no generated block, so it is not kernel-rendered — restoring overwrites whatever is there now with the archived original.`,
  };
}

function renderContinuity(state, existing) {
  const c = state.counts || {};
  const note = planNote(existing, 'CONTINUITY.md', state).text;
  const L = [];
  L.push('# CONTINUITY');
  L.push('');
  L.push('> ⚙️ **GENERATED from `docs/derived/STATE.json`.** The block below is rendered; every number in');
  L.push('> it is recomputed from rows on each run and verified back against its source. Hand-edits there');
  L.push('> are overwritten and flagged. Write prose in the NOTE block instead — that survives.');
  L.push('');
  L.push(NOTE_OPEN);
  L.push(note || '_(no human note)_');
  L.push(NOTE_CLOSE);
  L.push('');
  // ⛔ The generation TIMESTAMP lives outside the generated block, deliberately. It changes on every
  // run, so including it would make the block differ from a fresh render every single time and turn the
  // stale-block check into a permanent false alarm — a check that always fires is ignored within a day,
  // which is the same way a check that never fires becomes decoration. The REVISION stays inside: it is
  // a property of the state being described, not of when the description was printed.
  L.push(`_Generated ${state.generatedAt}._`);
  L.push('');
  L.push(GEN_OPEN);
  L.push('');
  L.push(`**Source revision:** \`${state.sourceRevision || 'unknown'}\``);
  L.push('');

  if (state.constraints && state.constraints.length) {
    L.push('## 🛑 Active constraints — honor before proposing any work');
    for (const x of state.constraints) L.push(`- ${x}`);
    L.push('');
  }
  if (state.killedFeatures && state.killedFeatures.length) {
    /*
     * ⛔ P4-N-10: THIS HEADING IS THE FENCE, NOT DECORATION. Each bullet below names a retired
     * feature by putting it in an ordinary sentence — `- \`id\` — feature name` — with no retirement
     * vocabulary of its own. Without a heading `removals.js`'s HISTORY_HEADING recognises, that bullet
     * is a LIVE assertion of the very thing it retires, and once docs/derived is itself a scanned
     * live-content directory (as this repo's own respawnpack.config.json makes it), the scan fails on
     * its own generated output — reproduced against three real rows here (R-003, R-004, R-006).
     * "(negative knowledge)" is not decoration: it is the exact phrase spine/PRODUCT.md's own "Killed
     * features (negative knowledge)" section already uses, and the one HISTORY_HEADING already
     * recognises — so the fix is this heading, not a change to the scanner's vocabulary or rules.
     */
    L.push('## ⛔ Killed features (negative knowledge) — do not reintroduce');
    for (const k of state.killedFeatures) L.push(`- \`${k.id || k}\`${k.feature ? ` — ${k.feature}` : ''}`);
    L.push('');
  }

  // Goal and milestone are rendered as SEPARATE lines. Collapsing them is how a corrective milestone
  // got reported as the project goal in field run B.
  L.push('## Goal');
  L.push(`- **Project goal:** ${state.goal || '_none recorded_'} — ${state.goalComplete ? '✅ complete' : '⏳ not complete'}`);
  L.push(`- **Active milestone:** ${state.milestone || '_none recorded_'} — ${state.milestoneComplete ? '✅ complete' : '⏳ not complete'}`);
  L.push(`- **Project blocked:** ${state.projectBlocked ? 'yes — every mandatory requirement is blocked' : 'no'}`);
  L.push('');

  if (state.tracksRequirements) {
    L.push('## Status');
    L.push(`- ${c.mandatory} mandatory requirements, of which ${c.conformant} conformant`);
    L.push(`- ${c.candidate} candidate (evidence exists but has not been independently qualified)`);
    L.push(`- ${c.unevidenced} unevidenced, ${c.waived} waived, ${c.blocked} blocked`);
    L.push(`- ${(state.openP0P1 || []).length} open p0/p1`);
    L.push(`- ${c.staleEvidence} stale evidence artifacts (bound to a superseded revision — contributing nothing)`);
    L.push('');
    L.push('## Next');
    L.push(`- **Current atomic task:** ${state.currentAtomicTask || '_none recorded_'}`);
    L.push(`- ${(state.nextUnblockedWork || []).length} next unblocked items of mandatory work`);
    for (const n of (state.nextUnblockedWork || []).slice(0, 5)) L.push(`  - \`${n.id}\` ${n.title} (${n.status})`);
    L.push('');
    if ((state.blockers || []).length) {
      L.push('## Blocked — these and their dependents only');
      for (const b of state.blockers) L.push(`- \`${b.id}\` ← ${b.blockedBy.join(', ')}${b.missingAuthority ? ` · missing: ${b.missingAuthority}` : ''}`);
      L.push('');
    }
  }

  if ((state.cannotDetermine || []).length) {
    L.push('## Could not be determined');
    for (const x of state.cannotDetermine) L.push(`- ${x}`);
    L.push('');
  }
  L.push(GEN_CLOSE);
  L.push('');
  return L.join('\n');
}

function renderGaps(state, existing) {
  const note = planNote(existing, 'GAPS.md', state).text;
  const L = ['# GAPS', '', '> ⚙️ **GENERATED from `docs/derived/STATE.json`.** Rows below are derived from the approved requirement source.', ''];
  L.push(NOTE_OPEN); L.push(note || '_(no human note)_'); L.push(NOTE_CLOSE); L.push('');
  L.push(GEN_OPEN); L.push('');

  if (!state.tracksRequirements) {
    L.push('_This project tracks no requirement denominator (`docs/derived/state/requirements.json` absent)._');
    L.push(''); L.push(GEN_CLOSE); L.push('');
    return L.join('\n');
  }

  const c = state.counts;
  L.push(`${c.total} requirements total · ${c.mandatory} mandatory requirements · ${c.conformant} conformant · ${c.candidate} candidate · ${c.unevidenced} unevidenced · ${c.waived} waived`);
  L.push('');
  L.push('| id | status | risk | gate | why |');
  L.push('|---|---|---|---|---|');
  for (const r of state.requirements || []) {
    L.push(`| \`${r.id}\` | ${r.status} | ${r.risk} | ${r.gate || '—'} | ${String(r.why).replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  if ((state.gates || []).length) {
    L.push('## Gates');
    L.push('| gate | conformant / denominator | status |');
    L.push('|---|---|---|');
    for (const g of state.gates) L.push(`| \`${g.id}\` | ${g.conformant} / ${g.denominator} | ${g.status}${g.note ? ` — ${g.note}` : ''} |`);
    L.push('');
  }
  const rejected = (state.evidence && state.evidence.rejected) || [];
  if (rejected.length) {
    L.push('## Evidence rejected by the shared loader');
    for (const r of rejected) L.push(`- \`${r.file}\` — ${r.reason}`);
    L.push('');
  }
  L.push(GEN_CLOSE); L.push('');
  return L.join('\n');
}

/*
 * ⭐ THE LESSONS REGISTER (P2-O-3) — THE THIRD RENDERED DOCUMENT, AND THE FIRST ONE WHOSE NUMBERS DO
 * NOT COME FROM STATE.json.
 *
 * The pack captures candidate memories mechanically and promotes them, with a stated verification, into
 * `memory/graph/<type>/<slug>.md`. Until this existed, nothing rendered that set as something a person
 * reads: the promoted lessons were a directory of markdown files and the unreviewed leads were a
 * directory of JSON records, and the measured cost was thirteen candidates accumulating across sessions
 * because nobody was ever shown that they were there.
 *
 * ⛔ IT IS THE SAME CONTRACT AS THE OTHER TWO, EXTENDED — NEVER A SECOND, LOOSER ONE. Same GEN/NOTE
 * markers, same NOTE budget, same generated-block drift check, and — the part that matters — the same
 * DF-011 pair: every count is RENDERED from rows and then PARSED BACK OUT and compared against those
 * rows. Because the rows live in the memory store rather than in STATE.json, `verifyRendered` cannot be
 * the verifier (its map is `countMap(state)`), so `verifyLessons` is the same function over the same
 * labels with the store as its source. Extending the pair is what anti-drift item 7 requires; writing a
 * renderer WITHOUT its verifier would have been a third document full of unchecked integers.
 *
 * ⛔ THIS MODULE STILL OPENS NO FILE, AND THAT IS A FENCE, NOT A STYLE — kernel/schema.test.mjs asserts
 * this source contains no synchronous file read at all, so the assertion below is itself written to
 * carry no such token. So the STORE IS AN ARGUMENT: the caller reads
 * `memory/graph/**` and `memory/candidates/*.json` through its own classified boundary and hands the
 * rows here. That also makes the three-state discipline the caller's to establish and this module's to
 * RESPECT: `ABSENT` (no directory) is a real zero and says so, `UNREADABLE` withholds the number
 * entirely rather than printing a zero nobody counted — anti-drift item 5, one file over.
 *
 * ⛔ AND A CANDIDATE IS RENDERED AS A LEAD, NEVER AS A LESSON (anti-drift item 11). The register's rows
 * are promoted entities only. The candidate queue is a COUNT plus the review command, under the store's
 * own `UNVERIFIED LEAD` vocabulary — there is no path here that prints a candidate's claim as a fact.
 */
const LESSONS_LABELS = { verified: 'verified lessons', candidate: 'candidate leads', rejected: 'rejected leads' };
const REVIEW_COMMAND = 'node .claude/respawnpack/respawnpack.js memory candidates';
/*
 * ⛔ THE MARKER IS HANDED IN, NOT SPELLED HERE. `core/memory/candidates.js` owns the word an unverified
 * lead is labelled with and says outright that a second implementation is how the label drifts. The
 * caller passes that module's own constant on the store snapshot; this fallback is prose, deliberately
 * NOT a second copy of the token, and it is only ever reached when the store could not be read at all.
 */
const unverifiedWord = (store) => (store && store.unverifiedMarker) || 'unverified lead';

/** A store half that could not be read yields no count at all. `ABSENT` is a counted zero; `UNREADABLE` is not. */
const readable = (half) => Boolean(half) && (half.status === 'OK' || half.status === 'ABSENT');

/**
 * The label→value map for the register, derived from the store's ROWS on every call — the same shape and
 * the same purpose as `countMap(state)` above, and the words the renderer writes are the words
 * `verifyLessons` looks for. A half that could not be read contributes `null`, which drops its label out
 * of the verifiable set instead of contributing a zero.
 */
function lessonsCounts(store) {
  const g = (store && store.graph) || {};
  const c = (store && store.candidates) || {};
  const records = Array.isArray(c.records) ? c.records : [];
  return {
    [LESSONS_LABELS.verified]: readable(g) ? (Array.isArray(g.entities) ? g.entities.length : 0) : null,
    [LESSONS_LABELS.candidate]: readable(c) ? records.filter((r) => r.verificationState === 'candidate').length : null,
    [LESSONS_LABELS.rejected]: readable(c) ? records.filter((r) => r.verificationState === 'rejected').length : null,
  };
}

/** One table cell: pipes escaped, newlines flattened, bounded — a register row is a pointer, not the entity. */
function cell(text, max = 160) {
  const s = String(text === null || text === undefined || text === '' ? '—' : text)
    .replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
  return s.length > max ? `${cutAt(s, max - 1)}…` : s;
}

/** The count line, or the withheld line naming why. Withheld, never caveated (anti-drift item 5). */
function countLine(label, value, half) {
  return Number.isFinite(value)
    ? `- **${label}:** ${value}`
    : `- **${label}:** _withheld — ${(half && half.reason) || 'the store could not be read'}_`;
}

function renderLessons(existing, store) {
  const s = store || {};
  const graph = s.graph || { status: 'UNREADABLE', entities: [], reason: 'no memory graph was handed to the renderer' };
  const cands = s.candidates || { status: 'UNREADABLE', records: [], reason: 'no candidate store was handed to the renderer' };
  const counts = lessonsCounts(s);
  const note = planNote(existing, 'LESSONS.md', s).text;

  const L = [];
  L.push('# LESSONS');
  L.push('');
  L.push('> ⚙️ **GENERATED from the memory store** (`memory/graph/**` for the promoted entities,');
  L.push('> `memory/candidates/` for the leads). Every number below is recounted from those rows on each');
  L.push('> run and verified back against them. Hand-edits inside the generated block are overwritten and');
  L.push('> flagged. Write prose in the NOTE block instead — that survives.');
  L.push('');
  L.push(NOTE_OPEN);
  L.push(note || '_(no human note)_');
  L.push(NOTE_CLOSE);
  L.push('');
  // Outside the block, for the reason renderContinuity states: a timestamp inside it would make every
  // run differ from a fresh render and turn the stale-block check into a permanent false alarm.
  L.push(`_Generated ${s.generatedAt || 'at an unrecorded time'}._`);
  L.push('');
  L.push(GEN_OPEN);
  L.push('');
  /*
   * ⛔ NO `Source revision:` LINE HERE, UNLIKE CONTINUITY, AND DELIBERATELY. This document is a
   * projection of the memory store, not of a source revision: binding it to HEAD would make its
   * generated block differ from a fresh render after every unrelated commit, which is the false alarm
   * the equivalence normalisation upstairs exists to suppress. The block changes when the store does.
   */
  L.push('## Promoted lessons');
  L.push('');
  L.push(countLine(LESSONS_LABELS.verified, counts[LESSONS_LABELS.verified], graph));
  L.push('');
  if (!readable(graph)) {
    L.push(`_The graph at \`memory/graph/\` could not be read (${graph.reason || 'no reason recorded'}), so no row below is a complete list. This is not "no lessons": it is "nobody could look"._`);
    L.push('');
  } else if (!(graph.entities || []).length) {
    L.push(`_Nothing has been promoted into \`memory/graph/\` yet${graph.status === 'ABSENT' ? ` (${graph.reason || 'the directory does not exist'})` : ''}. Promotion is the only door into the graph: \`${REVIEW_COMMAND} promote <id> --as <type>/<slug> --verified-by "<what proved it>"\`._`);
    L.push('');
  } else {
    L.push('| lesson | observation | promoted | verified by | applies to |');
    L.push('|---|---|---|---|---|');
    for (const e of graph.entities) {
      const skills = (e.skills || []).length ? (e.skills || []).map((k) => `\`/${k}\``).join(', ') : '—';
      L.push(`| \`${cell(e.id, 80)}\` | ${cell(e.observation)} | ${cell(e.promotedAt, 40)} | ${cell(e.verifiedBy)} | ${skills} |`);
    }
    L.push('');
  }

  L.push('## Leads awaiting review');
  L.push('');
  L.push(`⛔ A lead is not a lesson. Every record counted here is an **${unverifiedWord(s)}** — captured mechanically, NOT established, and never to be repeated as project truth until an explicit, audited promotion with a stated verification has moved it into the graph above.`);
  L.push('');
  L.push(countLine(LESSONS_LABELS.candidate, counts[LESSONS_LABELS.candidate], cands));
  L.push(countLine(LESSONS_LABELS.rejected, counts[LESSONS_LABELS.rejected], cands));
  L.push('');
  L.push(`Review them — promote, reject, or defer, but never silently — with \`${REVIEW_COMMAND}\`.`);
  if (!readable(cands)) {
    L.push('');
    L.push(`_The candidate store at \`memory/candidates/\` could not be read (${cands.reason || 'no reason recorded'}). The counts above are withheld rather than printed as zero._`);
  } else if (cands.status === 'ABSENT') {
    L.push('');
    L.push(`_${cands.reason || 'The store does not exist in this project'}, so nothing has been captured here yet._`);
  }
  L.push('');
  L.push(GEN_CLOSE);
  L.push('');
  return L.join('\n');
}

/**
 * ⭐ `verifyRendered`'s twin, over the memory store instead of STATE.json. Same three verdicts, same
 * reasons: disagreement is FAIL naming the label, zero parseable claims is CANNOT_DETERMINE, and a
 * store nothing could be counted from is CANNOT_DETERMINE rather than a pass over an empty document.
 *
 * ⛔ THERE IS NO NOT_APPLICABLE ESCAPE HERE, UNLIKE `verifyRendered`. That branch exists upstairs because
 * a project with no requirement denominator renders NO count at all and would otherwise be permanently
 * blocked. This renderer always states its three counts — an empty register prints three explicit zeros
 * — so "the document made no claim" can only mean the renderer and this verifier have drifted apart,
 * which is exactly the case that must never read as a pass.
 */
function verifyLessons(text, store, { file = 'docs/derived/LESSONS.md' } = {}) {
  const map = lessonsCounts(store);
  const check = `rendered-claims:${removalsLib.posix(file)}`;
  const known = Object.keys(map).filter((k) => Number.isFinite(map[k]));
  if (!known.length) {
    const why = [(store && store.graph && store.graph.reason) || null, (store && store.candidates && store.candidates.reason) || null]
      .filter(Boolean).join(' · ') || 'no reason recorded';
    return result(OUTCOME.CANNOT_DETERMINE, check,
      `no count could be established from the memory store (${why}), so nothing in ${file} could be checked against it. This is CANNOT_DETERMINE, never a pass: the document may be perfectly correct and there is no way to tell.`,
      { checked: 0 });
  }
  const claims = numericClaims(text, { labels: known });
  const failures = claims
    .filter((cl) => map[cl.label] !== cl.number)
    .map((cl) => ({ line: cl.line, label: cl.label, prose: cl.number, source: map[cl.label], text: cl.text }));
  const verdict = verdictFromCount({ check, checked: claims.length, failures, subject: file });
  if (verdict.outcome === OUTCOME.FAIL) {
    verdict.detail = failures
      .map((f) => `${file}:${f.line} says ${f.prose} ${f.label}, the memory store says ${f.source}`)
      .join(' · ');
    // A PROVEN DISAGREEMENT OUTRANKS AN UNESTABLISHED COUNT, so a FAIL is returned as a FAIL even when
    // the other half of the store could not be read: "this number is wrong" is a stronger and more
    // actionable statement than "one of these could not be checked".
    return verdict;
  }
  /*
   * ⛔ A PARTIALLY-VERIFIABLE REGISTER IS NOT A VERIFIED ONE. When one half of the store is unreadable
   * its labels drop out of `known`, so the claims that DID parse can all agree and this would otherwise
   * return PASS — a row reading "the register checks out" over a document that states two counts nobody
   * could establish. That is the silent-green shape the whole outcome vocabulary exists to refuse
   * (anti-drift item 13, and item 5's "withheld, never caveated" one layer up): the label is withheld in
   * the document AND the verdict says the check could not be completed. The claims that did agree are
   * still reported, so an operator can tell this from a disagreement.
   */
  const unreadable = [['the promoted-entity graph', store && store.graph], ['the candidate store', store && store.candidates]]
    .filter(([, half]) => !readable(half))
    .map(([what, half]) => `${what} (${(half && half.reason) || 'no reason recorded'})`);
  if (unreadable.length) {
    return result(OUTCOME.CANNOT_DETERMINE, check,
      `${claims.length} claim(s) in ${file} agree with the memory store, but ${unreadable.join(' and ')} could not be read, so ${Object.keys(map).length - known.length} of the register's ${Object.keys(map).length} counts were neither rendered nor checked. Nothing here disagrees; the register is simply not fully established.`,
      { checked: claims.length });
  }
  return verdict;
}

/*
 * ⭐ THE CHECK DF-011 ASKED FOR. Parse every numeric claim back out of the rendered prose and compare it
 * against the rows it was derived from.
 *
 * Two properties it must have, both learned the hard way:
 *   • It reads LIVE CLAUSES only (assert.js liveClause), so a document may quote the count it retires.
 *     DF-011's first implementation flagged three already-corrected rows for exactly this reason.
 *   • Zero claims parsed is CANNOT_DETERMINE, never MATCH.
 */
function verifyRendered(text, state, { file = 'derived doc' } = {}) {
  const map = countMap(state);
  const known = Object.keys(map).filter((k) => Number.isFinite(map[k]));
  if (!known.length) {
    // BUG-2 / K-02: id only, here and at every `rendered-claims:` row below — `file` itself, and every
    // detail string that names it, is untouched.
    return result(OUTCOME.CANNOT_DETERMINE, `rendered-claims:${removalsLib.posix(file)}`,
      'state carries no numeric counts to verify against', { checked: 0 });
  }

  const claims = numericClaims(text, { labels: known });

  /*
   * ⛔ NOTHING TO VERIFY, VERIFIABLY — AND ONLY IN THAT ONE CASE.
   *
   * A project with no requirements denominator compiles a state whose every count is a legitimate ZERO,
   * and the renderer omits zero-valued lines, so the document truthfully contains no numeric claims. The
   * verifier then reported "parsed 0 claims — a check that matched nothing" and CANNOT_DETERMINE, which
   * left `savepoint --verify` unable to return 0 for a documentation-only repository no matter what its
   * owner did. That is the 2026-08-07 field run §1's complaint surviving every other fix in this commit: "the project
   * ships in a state where success is unreachable, so the honest outcome of every savepoint is blocked.
   * That trains the operator to ignore it."
   *
   * ⛔ THE GUARD IS `every count is zero`, NOT `no claims were parsed`, AND THE DIFFERENCE IS THE WHOLE
   * SAFETY ARGUMENT. If the state carries a NON-ZERO count and the document parsed nothing, something is
   * genuinely wrong — the renderer's labels and the verifier's labels have drifted, and a document full of
   * unchecked numbers would sail through. That case still reports CANNOT_DETERMINE, exactly as before.
   * Only when there is provably nothing to state is "no claims" a complete answer rather than a failure to
   * look, and the detail says which of the two it is so the verdict can never be read as a silent pass.
   */
  if (!claims.length && known.every((k) => map[k] === 0)) {
    return result(OUTCOME.NOT_APPLICABLE, `rendered-claims:${removalsLib.posix(file)}`,
      `${file} renders no numeric claims, and every count in the compiled state is zero — there is nothing ` +
      'to disagree with. This is NOT_APPLICABLE rather than a pass: no claim was checked, because none was ' +
      'made. A state carrying any non-zero count with a document that parsed no claims stays ' +
      'CANNOT_DETERMINE, since that would mean the renderer and this verifier disagree about the labels.',
      { checked: 0 });
  }
  const failures = claims
    .filter((cl) => map[cl.label] !== cl.number)
    .map((cl) => ({ line: cl.line, label: cl.label, prose: cl.number, source: map[cl.label], text: cl.text }));

  const verdict = verdictFromCount({ check: `rendered-claims:${removalsLib.posix(file)}`, checked: claims.length, failures, subject: file });
  if (verdict.outcome === OUTCOME.FAIL) {
    verdict.detail = failures
      .map((f) => `${file}:${f.line} says ${f.prose} ${f.label}, source says ${f.source}`)
      .join(' · ');
  }
  return verdict;
}

/** Did someone hand-edit inside the generated block? Cheap, and it answers RA-4 directly. */
function generatedBlockOf(text) {
  const m = new RegExp(`${GEN_OPEN}([\\s\\S]*?)${GEN_CLOSE}`).exec(String(text || ''));
  return m ? m[1] : null;
}

/*
 * ⛔ THE ONE DIFFERENCE A SAVEPOINT COMMIT IS ALLOWED TO MAKE, AND ONLY WITHIN ITS OWN EQUIVALENCE.
 *
 * The rendered block carries the source revision on purpose (see renderContinuity). After the
 * documented closeout — commit work W, savepoint, commit the docs as S — a verify-only run at S used to
 * FAIL this check with the block's numbers all correct and the revision line its only difference,
 * because the fresh render was bound to S. The compiler now binds to W at S, so the two lines agree
 * again; this normalisation covers the remaining case, a block rendered by a kernel that bound to S.
 *
 * It is bounded by `equivalentRevisions` — the savepoint-only chain above HEAD that the caller obtained
 * from the same walk the compiler used. A revision line naming a commit OUTSIDE that chain is a real
 * disagreement and still FAILs: a document rendered at a superseded source is stale even when every
 * count in it happens to still be right, and "the numbers match" is the exact judgement that skims
 * past a stale-but-plausible document.
 */
const REVISION_LINE = /^\*\*Source revision:\*\* `([0-9a-f]{40}|unknown)`\r?$/m;

// BUG-2 / K-02: id only, at all four returns below — `file` itself, and the two detail strings that
// name it (`${file} has no generated block...`, `${file}'s generated block differs...`), are untouched.
function driftFromGenerated(existing, regenerated, file, { equivalentRevisions = [] } = {}) {
  const idFile = removalsLib.posix(file);
  const a = generatedBlockOf(existing), b = generatedBlockOf(regenerated);
  if (a === null) return result(OUTCOME.CANNOT_DETERMINE, `generated-block:${idFile}`, `${file} has no generated block — it has never been rendered by the state compiler`, { checked: 0 });
  if (normalise(a) === normalise(b)) return result(OUTCOME.PASS, `generated-block:${idFile}`, 'generated block matches a fresh render', { checked: 1 });

  const ra = REVISION_LINE.exec(a), rb = REVISION_LINE.exec(b);
  const equivalent = Array.isArray(equivalentRevisions) ? equivalentRevisions : [];
  if (ra && rb && ra[1] !== rb[1] && equivalent.includes(ra[1]) && equivalent.includes(rb[1])) {
    const withoutRevision = (t) => t.replace(REVISION_LINE, '**Source revision:** `<same source>`');
    if (normalise(withoutRevision(a)) === normalise(withoutRevision(b))) {
      return result(OUTCOME.PASS, `generated-block:${idFile}`,
        `generated block matches a fresh render — its revision line names ${ra[1].slice(0, 7)} and the fresh render ${rb[1].slice(0, 7)}, which describe the same source (savepoint-only commits between them)`, { checked: 1 });
    }
  }
  return result(OUTCOME.FAIL, `generated-block:${idFile}`, `${file}'s generated block differs from a fresh render — it is stale or was hand-edited`, { checked: 1 });
}

module.exports = { renderContinuity, renderGaps, renderLessons, verifyRendered, verifyLessons, driftFromGenerated, planMigration, planRestore, planNote, noteBudgetCheck, rawNote, countMap, lessonsCounts, LESSONS_LABELS, NOTE_BUDGET, GEN_OPEN, GEN_CLOSE, NOTE_OPEN, NOTE_CLOSE, liveClause };

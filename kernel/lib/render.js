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
const NOTE_BUDGET = 700; // a note, not a second handoff document — counted in whitespace-separated words
/*
 * ⛔ THE GENERATED BLOCKS ARE BOUNDED TOO, NOT ONLY THE NOTE. At 200 requirements GAPS rendered every row
 * and ran to 42 KB on a live target; the document a reader actually loads must stay small. GAPS carries
 * the GENERATED_ROW_CAP highest-priority requirement rows and a line naming how many more sit in
 * STATE.json; CONTINUITY carries the nextUnblockedWork list STATE.json already caps. Neither count is
 * lost: the FULL requirement set stays in STATE.json (a row that is not rendered is still counted), and
 * the true next-unblocked total travels in counts.nextUnblocked, which is the number the verifier checks.
 */
const GENERATED_ROW_CAP = 40;

/*
 * ⛔ ONE DEFINITION OF A WORD, STATED ONCE AND SHARED. The budget, the overflow marker, the migration
 * excerpt and kernel/README.md all count the same way: whitespace-separated tokens. Counting any other
 * way in any one of them is how the number a human is shown stops matching the number the check enforced.
 */
const countWords = (text) => { const t = String(text).trim(); return t ? t.split(/\s+/).length : 0; };

/** The prefix of `text` holding its first `n` words, with the original spacing up to the nth word kept. */
function firstWords(text, n) {
  if (n <= 0) return '';
  const s = String(text);
  let end = 0;
  let count = 0;
  for (const m of s.matchAll(/\S+/g)) { end = m.index + m[0].length; count += 1; if (count >= n) break; }
  return s.slice(0, end);
}

/*
 * ⛔ FAILING MANDATORY FIRST, THEN BLOCKED, THEN THE REST. The rows GAPS shows are the ones a reader
 * needs: a mandatory requirement that is not yet conformant or waived outranks a blocked one, which
 * outranks everything already settled. A stable sort keeps the source order inside each rank, so the
 * rendered prefix is deterministic and a fresh render reproduces it byte-for-byte.
 */
function rowPriority(r) {
  const failing = r.status !== 'conformant' && r.status !== 'waived';
  const blocked = (r.blockedBy || []).length > 0;
  if (r.mandatory && failing && !blocked) return 0;
  if (blocked) return 1;
  return 2;
}

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
    // The TRUE next-unblocked total, not the length of the bounded list in STATE.json: CONTINUITY renders
    // this number and lists only the first NEXT_UNBLOCKED_CAP, so the verifier must check the number the
    // reader sees. `counts.nextUnblocked` is the compiler's full count; the fallback keeps a hand-built
    // state (no counts.nextUnblocked) verifying against its own list length.
    'next unblocked': Number.isFinite(c.nextUnblocked) ? c.nextUnblocked : (state.nextUnblockedWork || []).length,
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
 * ⛔ THE BUDGET IS WORDS, NOT CHARACTERS (B3). The field (its 2026-10-05 report) hit the old
 * 1,200-UTF-16-unit budget 11 times on a document project and 15 on an infrastructure one — operators
 * kept real handoff state in the note and had it cut. The budget is now 700 WORDS (countWords above),
 * the owner's number: generous enough for a genuine note, still a note and not a second handoff document.
 *
 * The budget itself stays — a note is not a second handoff document. What changes is that overflow is now
 * VISIBLE in three places, none of which can be skipped:
 *   1. the rendered block ends in a marker naming the budget, the number of words dropped and the archive
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
  return `…[note truncated at ${NOTE_BUDGET} words — ${dropped} words dropped; full text archived to ${archiveRel}]`;
}

/**
 * planNote — bound the NOTE block to NOTE_BUDGET WORDS and REPORT the cut, never perform it silently.
 * Returns { full, text, overflow, length, budget, kept, dropped, archiveRel }: `length`, `kept` and
 * `dropped` are WORD counts; `text` is what the renderer writes into the block (the note itself when it
 * fits; the kept prefix plus the marker when it does not), `full` is what the caller archives verbatim to
 * `archiveRel` before writing the bounded doc.
 */
function planNote(existing, name, state) {
  const full = rawNote(existing);
  const budget = NOTE_BUDGET;
  const words = countWords(full);
  if (words <= budget) {
    return { full, text: full, overflow: false, length: words, budget, kept: words, dropped: 0, archiveRel: null };
  }
  const archiveRel = noteArchiveRel(name, full, state && state.generatedAt);
  // Reserve room for the marker's own words using the widest count it could carry (`words`, since dropped
  // ≤ words), then state the exact number — so kept + marker never exceeds the budget in words, and the
  // next run reads the bounded note back as within budget rather than truncating it again.
  const markerWords = countWords(overflowMarker(words, archiveRel));
  const keep = Math.max(0, budget - markerWords);
  const kept = firstWords(full, keep);
  const dropped = words - keep;
  return { full, text: `${kept}${kept ? ' ' : ''}${overflowMarker(dropped, archiveRel)}`, overflow: true, length: words, budget, kept: keep, dropped, archiveRel };
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
    return result(OUTCOME.PASS, check, `NOTE block is ${plan.length}/${plan.budget} words — within budget, nothing cut`, { checked: 1, ephemeral: true });
  }
  const over = plan.length - plan.budget;
  return result(OUTCOME.FAIL, check, write
    ? `NOTE block was ${plan.length} words, ${over} over the ${plan.budget}-word budget — kept ${plan.kept} words behind a visible truncation marker and archived the full note verbatim to ${plan.archiveRel}. Trim the note (or accept the archive); the next run passes once the block fits.`
    : `NOTE block is ${plan.length} words, ${over} over the ${plan.budget}-word budget. --write would keep the first ${plan.kept} words, end them with a visible truncation marker, and archive the full note verbatim to ${plan.archiveRel}. Trim the note before writing, or accept the archive — nothing is cut silently.`,
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
   * ⛔ THE SEEDED NOTE MUST FIT THE BUDGET WITH ITS TRAILER. The seeded note is excerpt + trailer, and
   * both are counted in the same words the budget is, so a long legacy doc cannot seed a note the very
   * first render would cut through the sentence that names the archive — the one line that makes the
   * migration reversible. Sized from the trailer's own word count: `…` marks the cut and the trailer says
   * where the rest is, so the excerpt is the migration's own overflow marker and planNote has nothing left
   * to cut.
   */
  const room = Math.max(0, NOTE_BUDGET - countWords(trailer)); // the trailer's words plus the excerpt's must fit
  const excerpt = countWords(prose) > room ? `${firstWords(prose, room)}…` : prose;

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
    // The TRUE total (counts.nextUnblocked), then the bounded list STATE.json already caps. The number the
    // reader sees is what verifyRendered checks; the items below it are a pointer, and the full set is
    // always derivable from the requirement rows in STATE.json, so nothing here is lost by bounding.
    const nextList = state.nextUnblockedWork || [];
    const nextTotal = Number.isFinite(c.nextUnblocked) ? c.nextUnblocked : nextList.length;
    L.push(`- ${nextTotal} next unblocked items of mandatory work`);
    for (const n of nextList) L.push(`  - \`${n.id}\` ${n.title} (${n.status})`);
    if (nextTotal > nextList.length) {
      L.push(`  - _…and ${nextTotal - nextList.length} more, derivable from the requirement rows in \`docs/derived/STATE.json\`_`);
    }
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
  // ⛔ TOP N BY PRIORITY, NOT EVERY ROW. The full set stays in STATE.json (a row that is not rendered is
  // still counted, and the count line above is over the whole set); GAPS shows only what a reader acts on.
  // The sort is stable, so a fresh render reproduces this prefix exactly and `generated-block` stays bound.
  const all = state.requirements || [];
  const shown = all.map((r, i) => [r, i]).sort((a, b) => (rowPriority(a[0]) - rowPriority(b[0])) || (a[1] - b[1])).slice(0, GENERATED_ROW_CAP).map(([r]) => r);
  for (const r of shown) {
    L.push(`| \`${r.id}\` | ${r.status} | ${r.risk} | ${r.gate || '—'} | ${String(r.why).replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  if (all.length > shown.length) {
    // Inside the generated block on purpose: a hand edit to this count differs from a fresh render and
    // FAILs `generated-block`. "more" names the exact number left in STATE.json, which is the whole set.
    L.push(`_… ${all.length - shown.length} more in \`docs/derived/STATE.json\` (the ${shown.length} highest-priority of ${all.length} shown above)._`);
    L.push('');
  }
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
const LESSONS_LABELS = { verified: 'verified lessons', candidate: 'candidate leads', rejected: 'rejected leads', unvouched: 'unvouched entities', stale: 'stale lessons' };
const REVIEW_COMMAND = 'node .claude/respawnpack/respawnpack.js memory candidates';
// G7 · the horizon a lesson is judged stale against, in days. Default when the project declares none;
// 0 disables the stale list (a NOTE line says so, never an empty section). B3 bounds the register with
// render.js CONSTANTS (NOTE_BUDGET, GENERATED_ROW_CAP); the horizon is PROJECT-configurable instead,
// because what counts as stale is a project's call, so the kernel reads it from respawnpack.config.json
// (memory.staleHorizonDays) and hands it in on the store, the same way it hands in generatedAt — this
// module still opens no file.
const DEFAULT_STALE_HORIZON_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const horizonOf = (store) => {
  const v = store && store.staleHorizonDays;
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_STALE_HORIZON_DAYS;
};
/** A YYYY-MM-DD or ISO date as epoch ms, or null when there is nothing parseable to compare. */
const dayMs = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? t : null; };
/** asOf first, promotedAt as the fallback the brief names; null when the entity carries neither. */
const effectiveDateMs = (e) => dayMs(e && e.asOf) ?? dayMs(e && e.promotedAt);
/** An entity is vouched when it carries a stated verifiedBy — the promotion that earned it, or a hand edit. */
const isVouched = (e) => Boolean(e && e.verifiedBy);

/*
 * ⛔ G7 · SUPERSESSION IS DERIVED FROM RELATIONS, NOT STORED ON THE SUPERSEDED FILE. An entity X is
 * superseded when ANY entity (promoted or hand-authored) carries `supersedes|X`; X's own file is never
 * rewritten by the superseding promotion. So the marker is computed here from every entity's `relations`,
 * and a chain A→B→C leaves only C current while a cycle (A supersedes B supersedes A) marks BOTH and
 * names the cycle — the walk carries a visited set, so a cycle terminates instead of looping forever.
 */
// ⛔ G7 · The target id is NORMALISED to an entity's canonical `type:slug` before the lookup — lower-cased,
// `/` to `:`, any trailing separator stripped — so a hand-authored `supersedes|Gotcha:Old`, `gotcha/old`
// or `gotcha:old/` still marks `gotcha:old`. A promotion already normalises its relations (parseRelations),
// so this only ever tightens the hand-authored path the brief says "works the same way"; it never loosens
// a promoted one.
const normalizeTargetId = (s) => String(s).trim().toLowerCase().replace(/\//g, ':').replace(/[:/]+$/, '');
function supersessionMarks(entities) {
  const superseders = new Map(); // target id -> [superseder ids]
  for (const e of entities) {
    for (const rel of (e.relations || [])) {
      const m = /^supersedes\s*\|\s*(.+)$/.exec(String(rel).trim());
      if (!m) continue;
      const target = normalizeTargetId(m[1]);
      if (!target) continue;
      if (!superseders.has(target)) superseders.set(target, []);
      superseders.get(target).push(e.id);
    }
  }
  const marks = new Map(); // id -> { by:[ids], cycle:bool }
  for (const [target, bys] of superseders) {
    let cycle = false;
    const seen = new Set();
    const stack = [...bys];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) { cycle = true; break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of (superseders.get(cur) || [])) stack.push(nxt);
    }
    marks.set(target, { by: [...new Set(bys)].sort(), cycle });
  }
  return marks;
}

/*
 * ⛔ G7 · THE ONE SPLIT EVERY REGISTER COUNT IS DERIVED FROM. The graph is partitioned into VOUCHED
 * entities (a stated verifiedBy — the verified table and its count) and UNVOUCHED ones (none — their own
 * section, excluded from the verified table and count). Staleness is a DATE COMPARISON with no clock:
 * the reference is the newest effective date (asOf, else promotedAt) across the vouched set, minus a
 * future outlier (G14) — the project's own latest recorded knowledge — so a verify re-reading the same
 * files gets the same answer and the
 * generated block never drifts on a timestamp (the trap G4 closed). An entity older than the horizon is
 * stale; one with no date at all is never counted stale. lessonsCounts and renderLessons share this, so a
 * number the register prints is the number the verifier checks.
 */
// G6 · a RETRACTED entity lives under memory/graph/_retracted/ and is not part of the register: it was
// deliberately withdrawn, and a withdrawn lesson a fresh lead may raise again is not a current one. The
// reader still SEES it (the ledger counts it); every count and derived view in this module excludes it.
const RETRACTED_RE = /(^|\/)_retracted\//;
function analyzeGraph(store) {
  const graph = (store && store.graph) || {};
  const entities = (readable(graph) && Array.isArray(graph.entities) ? graph.entities : [])
    .filter((e) => !RETRACTED_RE.test(String((e && e.file) || '')));
  const vouched = entities.filter(isVouched);
  const unvouched = entities.filter((e) => !isVouched(e));
  const marks = supersessionMarks(entities);
  const horizon = horizonOf(store);
  // G14 · the reference EXCLUDES FUTURE OUTLIERS before it is taken. The field defect: a hand-authored
  // `asOf` in the future becomes the newest vouched date, so every sibling renders tens of thousands of
  // days old. Promotion already refuses a future --as-of (G7); this closes the direct-file-edit path.
  //
  // The test is store-relative and clock-free (a clock here would reopen G4). The exclusion REPEATS, newest
  // first: a chain of forged future dates (asOf 2098 behind asOf 2099, each a hand edit) is dropped one by
  // one so the reference cannot settle on the second-newest forgery. The newest remaining dated vouched
  // entity is dropped, and the next-newest becomes the reference, when its date stands more than the
  // threshold (the horizon, or 180 days when the horizon is 0) beyond the next-newest REMAINING vouched
  // date, so dropping it genuinely moves the reference, AND it has no alibi. Its alibi is a parseable
  // `promotedAt` within the threshold of the asOf: a real lesson's asOf sits at its own promotedAt (a
  // lesson cannot be true far after it was recorded), so a legitimately recent lesson in an older set stays
  // the reference and the store-relative staleness decision 46 preserves is untouched. An ABSENT or
  // unparseable promotedAt is no alibi at all (promotion always writes promotedAt; its absence means a
  // hand-authored file), so the gap condition alone drops that entity. The loop terminates because the
  // remaining set shrinks by one each pass; with one dated vouched entity there is no "rest of the set" and
  // nothing is excluded. A forged PAIR (asOf and promotedAt both future) has a valid alibi and, without a
  // clock, is indistinguishable from a legitimately recent lesson, so it evades the clamp and ages its
  // siblings: the documented clock-free limit, not a bug (README, memory/knowledge-graph).
  const aheadThreshold = horizon > 0 ? horizon : DEFAULT_STALE_HORIZON_DAYS;
  const aheadDays = (later, earlier) => Math.floor((later - earlier) / DAY_MS);
  const datedVouched = vouched
    .map((e) => ({ entity: e, date: effectiveDateMs(e) }))
    .filter((d) => d.date !== null)
    .sort((a, b) => b.date - a.date || String(a.entity.id).localeCompare(String(b.entity.id)));
  const excluded = [];
  let inReference = datedVouched.slice();
  while (inReference.length >= 2) {
    const cand = inReference[0];
    const promoted = dayMs(cand.entity.promotedAt);
    const noAlibi = promoted === null || aheadDays(cand.date, promoted) > aheadThreshold;
    if (aheadDays(cand.date, inReference[1].date) > aheadThreshold && noAlibi) {
      excluded.push(cand);
      inReference = inReference.slice(1);
    } else break;
  }
  const reference = inReference.length ? inReference[0].date : null;
  const stale = [];
  if (horizon > 0 && reference !== null) {
    for (const { entity, date } of inReference) {
      const ageDays = Math.floor((reference - date) / DAY_MS);
      if (ageDays > horizon) stale.push({ entity, ageDays });
    }
    stale.sort((a, b) => b.ageDays - a.ageDays || String(a.entity.id).localeCompare(String(b.entity.id)));
  }
  return { entities, vouched, unvouched, marks, horizon, reference, stale, excluded, aheadThreshold };
}
/*
 * ⛔ G8 · THE REVISION A LESSON WAS TRUE IN, AND WHETHER THE WORLD HAS MOVED PAST IT. A promoted lesson
 * states the world held a shape; a binding ties it to the revision it held then — a commit, a document
 * digest, or an estate serial — and this compares that to the CURRENT revision the kernel resolved WITHOUT
 * NETWORK and handed in on the store (currentRevisions). "Behind" is binary and advisory, never a verdict
 * on the lesson: a behind lesson is a re-verify trigger. The comparison is a LIVE reading, so the behind
 * count lives OUTSIDE the generated block (the line below the stamp) and the `bound to` column INSIDE the
 * block is derived only from the entity's own frozen fields — a property of the state, never of the render
 * clock, the same reasoning renderContinuity's Source revision line follows (the G4 rule).
 *
 * ⛔ ABSENT, EMPTY AND MALFORMED STAY DISTINCT. No binding fields is `unbound`; a kind outside the three,
 * an empty value or a non-hex commit is `malformed` and named; a valid binding whose current value could
 * not be read is `undeterminable` and counted neither current nor behind — the honest infra degrade: the
 * pack cannot see a live estate, so a missing source reads UNDETERMINABLE, never a silent "current".
 */
const WORLD_KINDS = new Set(['commit', 'docDigest', 'estateRevision']);
const COMMIT_SHA = /^[0-9a-f]{40}$/;
function classifyBinding(e, cr) {
  const kind = (e && e.worldRevisionKind) || null;
  const value = (e && e.worldRevision) || null;
  const locator = (e && e.worldRevisionLocator) || null;
  const base = { entity: e, kind, value, locator };
  if (!kind && !value) return { ...base, state: 'unbound', boundTo: 'unbound', current: null, reason: null };
  if (!WORLD_KINDS.has(kind) || !value) {
    return { ...base, state: 'malformed', boundTo: 'malformed', current: null,
      reason: `binding fields present but malformed (kind ${kind || 'absent'}, value ${value || 'empty'})` };
  }
  if (kind === 'commit') {
    if (!COMMIT_SHA.test(value)) return { ...base, state: 'malformed', boundTo: 'malformed', current: null, reason: 'a commit binding value is not a 40-hex sha' };
    const boundTo = `commit ${value.slice(0, 7)}`;
    // `cr.commit` is the EFFECTIVE source revision (not raw HEAD), and `cr.commitChain` is the equivalence
    // class [HEAD … effective] the kernel resolved: a binding is CURRENT when its sha is in that chain, so a
    // savepoint-only commit above the work the lesson was true in does not read it behind (the rule
    // stateFreshness uses). The equality fallback covers a store that carried no chain (a render-unit store).
    const cur = (cr && cr.commit) || null;
    if (cur === null) return { ...base, state: 'undeterminable', boundTo, current: null, reason: 'no commit revision could be read (not a git repository, or no commits yet)' };
    const chain = (cr && cr.commitChain) || [];
    const isCurrent = chain.length ? chain.includes(value) : value === cur;
    return { ...base, state: isCurrent ? 'current' : 'behind', boundTo, current: cur };
  }
  if (kind === 'docDigest') {
    if (!locator) return { ...base, state: 'malformed', boundTo: 'malformed', current: null, reason: 'a document binding carries no locator path' };
    const boundTo = `doc ${locator}@${value.slice(0, 7)}`;
    const cur = (cr && cr.docs && locator in cr.docs) ? cr.docs[locator] : null;
    if (cur === null) return { ...base, state: 'undeterminable', boundTo, current: null, reason: `the bound document ${locator} could not be read` };
    return { ...base, state: value === cur ? 'current' : 'behind', boundTo, current: cur };
  }
  // estateRevision: the pack cannot read the live estate, only the serial the project committed to a file.
  if (!locator) return { ...base, state: 'malformed', boundTo: 'malformed', current: null, reason: 'an estate binding carries no source locator' };
  const boundTo = `estate ${value}`;
  const cur = (cr && cr.estates && locator in cr.estates) ? cr.estates[locator] : null;
  if (cur === null) return { ...base, state: 'undeterminable', boundTo, current: null, reason: `the estate source ${locator} is absent or empty` };
  return { ...base, state: value === cur ? 'current' : 'behind', boundTo, current: cur };
}

/** Every VOUCHED entity's binding, partitioned by state — shared by renderLessons and `doctor`. */
function analyzeBindings(store) {
  const a = analyzeGraph(store);
  const cr = (store && store.currentRevisions) || { commit: null, docs: {}, estates: {} };
  const out = { current: [], behind: [], undeterminable: [], unbound: [], malformed: [] };
  for (const e of a.vouched) { const b = classifyBinding(e, cr); out[b.state].push(b); }
  return out;
}

/** The distinct "why" reasons an undeterminable set carries, for the behind line's clause. */
const undetReasons = (undet) => [...new Set(undet.map((b) => b.reason))].join('; ');

/*
 * The UNVERIFIED behind line that sits beside the stamp (G8). It is a LIVE reading (the current tree at
 * render time), so it lives OUTSIDE the generated block and is stripped from the corpus digest exactly as
 * G14's age line is — a HEAD or a file that moved between a --write and a bare --verify must not fail the
 * register. Bounded at eight ids with an exact "N more"; a clause names how many could not be compared.
 */
function behindLineOf(bindings) {
  const behind = bindings.behind, undet = bindings.undeterminable;
  const unver = 'unverified: compared against the live tree at render time, outside the verified block';
  let body;
  if (behind.length) {
    const ids = behind.slice(0, 8).map((b) => `\`${b.entity.id}\``).join(', ');
    const more = behind.length > 8 ? ` and ${behind.length - 8} more` : '';
    body = `${behind.length} vouched lesson(s) bound to a revision behind the current one (${unver}): ${ids}${more}`;
    if (undet.length) body += `; ${undet.length} could not be compared (${undetReasons(undet)})`;
    body += '; re-verify before acting';
  } else {
    body = 'No vouched lesson is bound to a revision behind the current one';
    if (undet.length) body += `; ${undet.length} could not be compared (${undetReasons(undet)})`;
  }
  return `_${body}._`;
}

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
  const a = analyzeGraph(store);
  // verified lessons are the VOUCHED entities only (G7): a hand-authored entity with no verifiedBy is
  // excluded here and counted under unvouched instead. The stale count is withheld (null, so the verifier
  // does not look for it) when the horizon is disabled — there is no stale set to render or check then.
  return {
    [LESSONS_LABELS.verified]: readable(g) ? a.vouched.length : null,
    [LESSONS_LABELS.unvouched]: readable(g) ? a.unvouched.length : null,
    [LESSONS_LABELS.stale]: readable(g) && a.horizon > 0 ? a.stale.length : null,
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
  const a = analyzeGraph(s);
  const note = planNote(existing, 'LESSONS.md', s).text;
  // G14 · an UNVERIFIED reading of how long ago the project's newest vouched knowledge is dated, from the
  // same render clock the stamp uses (generatedAt). It sits beside the stamp, OUTSIDE the generated block,
  // is stripped from the corpus digest exactly as the stamp is (hooks/_manifest.js) and is never compared
  // by verifyLessons — so a dormant project shows its dormancy without a clock inside the verified block,
  // the trap G4 closed. Undated or empty vouched set says so rather than printing "NaN days".
  const renderMs = dayMs(s.generatedAt);
  const ageLine = (a.reference === null || renderMs === null)
    ? '_No vouched lesson carries a date._'
    : `_Newest vouched lesson dated ${Math.max(0, Math.floor((renderMs - a.reference) / DAY_MS))} day(s) before this render (unverified: computed from the clock at render time, outside the verified block)._`;
  // G8 · each vouched entity's binding, and the UNVERIFIED behind line that reports how many are bound to a
  // revision the current tree has moved past. The binding classification drives the `bound to` column too.
  const bindings = analyzeBindings(s);
  const boundToById = new Map();
  for (const list of Object.values(bindings)) for (const b of list) boundToById.set(b.entity.id, b.boundTo);
  const behindLine = behindLineOf(bindings);

  // G19 · a SECOND unverified line beside the stamp, rendered only when a vouched entity's effective date
  // lies AFTER the render clock. G14's clamp is clock-free by decision 53, so it cannot tell a forged pair
  // (asOf and promotedAt both set to a future date) from a legitimately recent lesson; this line reads the
  // same render clock the age line reads and names any such entity, so the forged pair is visible without a
  // clock entering the verified block (the trap G4 closed). It is never a claim: verifyLessons never
  // compares it and the corpus digest strips it exactly as it strips the stamp and the age line. A single
  // future asOf over a past promotedAt, which the clamp already excludes INSIDE the block, is named here too
  // because this reads the clock and the clamp does not. No future-dated vouched entity means no line, so a
  // plain register is byte-identical to the pre-G19 render. The ids are newest first, bounded at eight.
  const FUTURE_NAMED_CAP = 8;
  const futureDated = renderMs === null ? [] : a.vouched
    .map((e) => ({ entity: e, date: effectiveDateMs(e) }))
    .filter((d) => d.date !== null && d.date > renderMs)
    .sort((x, y) => y.date - x.date || String(x.entity.id).localeCompare(String(y.entity.id)));
  const futureLine = futureDated.length ? (() => {
    const shown = futureDated.slice(0, FUTURE_NAMED_CAP);
    const named = shown.map(({ entity }) => `\`${cell(entity.id, 80)}\` (${cell(dayMs(entity.asOf) !== null ? entity.asOf : entity.promotedAt, 40)})`);
    if (futureDated.length > shown.length) named.push(`and ${futureDated.length - shown.length} more`);
    return `_${futureDated.length} vouched lesson(s) dated AFTER this render (unverified: compared against the clock at render time, outside the verified block): ${named.join(', ')}; a date after the clock is a hand edit or a wrong clock, never a verified claim._`;
  })() : null;

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
  // run differ from a fresh render and turn the stale-block check into a permanent false alarm. The G14
  // age line sits here too, beside the stamp and for the same reason: a clock reading, never a claim. The
  // G19 future-dated line, when any vouched entity is dated after the clock, follows it for the same reason.
  L.push(`_Generated ${s.generatedAt || 'at an unrecorded time'}._`);
  L.push(ageLine);
  // G8 · the behind line sits here too, beside the stamp and after the age line, OUTSIDE the block: a live
  // reading of what the current tree moved past, never a verified claim and stripped from the corpus digest.
  L.push(behindLine);
  if (futureLine) L.push(futureLine);
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
  // G7 · the split every count rests on, stated so a reader knows what "verified lessons" excludes.
  L.push('> **verified lessons** counts entities with a stated `verifiedBy`; any without one are listed under **Unvouched** below and are not in that count.');
  L.push('');
  if (!readable(graph)) {
    L.push(`_The graph at \`memory/graph/\` could not be read (${graph.reason || 'no reason recorded'}), so no row below is a complete list. This is not "no lessons": it is "nobody could look"._`);
    L.push('');
  } else if (!a.entities.length) {
    L.push(`_Nothing has been promoted into \`memory/graph/\` yet${graph.status === 'ABSENT' ? ` (${graph.reason || 'the directory does not exist'})` : ''}. Promotion is the only door into the graph: \`${REVIEW_COMMAND} promote <id> --as <type>/<slug> --verified-by "<what proved it>"\`._`);
    L.push('');
  } else if (!a.vouched.length) {
    L.push('_Every entity in `memory/graph/` is unvouched (none carries a stated `verifiedBy`); they are listed under Unvouched below, not here._');
    L.push('');
  } else {
    // G8 · the `bound to` column names each lesson's world binding (commit/doc/estate, or unbound/malformed),
    // derived from the entity's own frozen fields — a verified claim inside the block, so a hand edit FAILs.
    L.push('| lesson | observation | promoted | verified by | applies to | bound to |');
    L.push('|---|---|---|---|---|---|');
    for (const e of a.vouched) {
      const skills = (e.skills || []).length ? (e.skills || []).map((k) => `\`/${k}\``).join(', ') : '—';
      const mark = a.marks.get(e.id);
      const obs = mark
        ? `${cell(e.observation)} (superseded by ${mark.by.map((id) => `\`${id}\``).join(', ')}${mark.cycle ? ', supersession cycle' : ''})`
        : cell(e.observation);
      L.push(`| \`${cell(e.id, 80)}\` | ${obs} | ${cell(e.promotedAt, 40)} | ${cell(e.verifiedBy)} | ${skills} | ${cell(boundToById.get(e.id) || 'unbound')} |`);
    }
    L.push('');
  }

  // G7 · entities with no stated verifiedBy — their own section, excluded from the verified table and its
  // count. Only rendered when there are any (the count is in lessonsCounts regardless, so a hand-added
  // false unvouched line still FAILs the register's rendered-claims check).
  if (readable(graph) && a.unvouched.length) {
    L.push('## Unvouched');
    L.push('');
    L.push(countLine(LESSONS_LABELS.unvouched, counts[LESSONS_LABELS.unvouched], graph));
    L.push('');
    L.push('⛔ These entities carry no stated `verifiedBy` — hand-authored or legacy, never promoted through the gate above — so they are NOT in the verified table or its count. Promote a claim with a stated verification, or edit the file to add a `verifiedBy`, to vouch for one.');
    L.push('');
    for (const e of a.unvouched) {
      const mark = a.marks.get(e.id);
      const sup = mark ? ` (superseded by ${mark.by.map((id) => `\`${id}\``).join(', ')}${mark.cycle ? ', supersession cycle' : ''})` : '';
      L.push(`- \`${cell(e.id, 80)}\` (\`${e.file}\`) — never verified through a promotion${sup}`);
    }
    L.push('');
  }

  // G7 · lessons aged past the project's horizon (memory.staleHorizonDays, default 180). A date comparison
  // against the newest vouched date in the store, never the wall clock, so a verify is stable. A horizon of
  // 0 disables the list with a NOTE line rather than printing an empty section.
  // G14 · the section also names each excluded future outlier as a line of its own (newest first), a
  // rendered claim inside the block, derived from the rows, so a hand edit of any one FAILs the
  // generated-block check, even when the horizon is disabled or no lesson is stale. A single exclusion
  // renders byte-identical to the pre-chain output.
  if (readable(graph) && (a.horizon === 0 || a.stale.length || a.excluded.length)) {
    L.push('## Stale by horizon');
    L.push('');
    if (a.excluded.length) {
      for (const ex of a.excluded) {
        L.push(`_Excluded from the reference: \`${cell(ex.entity.id, 80)}\` carries an asOf of ${cell(ex.entity.asOf || ex.entity.promotedAt, 40)}, more than ${a.aheadThreshold} days ahead of the rest of the set._`);
      }
      L.push('');
    }
    if (a.horizon === 0) {
      L.push('_Stale-by-horizon is disabled for this project (`memory.staleHorizonDays` is 0). No lesson is flagged as aged; set a positive horizon to enable the list._');
      L.push('');
    } else if (a.stale.length) {
      L.push(countLine(LESSONS_LABELS.stale, counts[LESSONS_LABELS.stale], graph));
      L.push('');
      L.push(`These vouched lessons carry an \`asOf\` (or \`promotedAt\`) more than ${a.horizon} days older than the project's newest recorded lesson. A date comparison, not a judgement: re-verify before relying on one.`);
      L.push('');
      for (const { entity, ageDays } of a.stale) {
        L.push(`- \`${cell(entity.id, 80)}\` is ${ageDays} days old (asOf ${cell(entity.asOf || entity.promotedAt, 40)})`);
      }
      L.push('');
    }
  }

  L.push('## Leads awaiting review');
  L.push('');
  L.push(`⛔ A lead is not a lesson. Every record counted here is an **${unverifiedWord(s)}** — captured mechanically, NOT established, and never to be repeated as project truth until an explicit, audited promotion with a stated verification has moved it into the graph above.`);
  L.push('');
  L.push(countLine(LESSONS_LABELS.candidate, counts[LESSONS_LABELS.candidate], cands));
  L.push(countLine(LESSONS_LABELS.rejected, counts[LESSONS_LABELS.rejected], cands));
  L.push('');
  L.push(`Review them — promote, reject, or defer, but never silently — with \`${REVIEW_COMMAND}\`.`);
  /*
   * ⛔ G6 · EACH OPEN LEAD IS A VISIBLE POINTER ROW, NEVER HIDDEN BEHIND THE COUNT. The field saw 18 open
   * leads disappear behind an "83 promoted + 28 rejected" headline, so the backlog renders as one row per
   * lead — its id, klass, capture cycle, age and claim — under the same unverified-lead discipline as the
   * count above. Age is in DAYS against the store's NEWEST capture, not the wall clock, so a fresh render
   * reproduces it byte for byte and the generated block never drifts on time (the rule the stale-lesson
   * list follows). Bounded by B3's GENERATED_ROW_CAP with an exact "N more" line; a store with zero open
   * leads renders no table at all (the explicit zero count above is the honest answer, not an empty table).
   * These rows are POINTERS — only the counts above are verified claims.
   */
  const leadRecords = readable(cands) && Array.isArray(cands.records) ? cands.records : [];
  const openLeads = leadRecords.filter((r) => r.verificationState === 'candidate');
  if (openLeads.length) {
    const capturedMs = (r) => dayMs(r && r.provenance && r.provenance.at);
    const dated = leadRecords.map(capturedMs).filter((d) => d !== null);
    const reference = dated.length ? Math.max(...dated) : null;
    const sorted = openLeads.slice().sort((a, b) => ((capturedMs(a) ?? 0) - (capturedMs(b) ?? 0)) || String(a.id).localeCompare(String(b.id)));
    const shown = sorted.slice(0, GENERATED_ROW_CAP);
    L.push('');
    L.push(`Each ${unverifiedWord(s)} awaiting review, oldest first (age in days against the store's newest capture, never the clock):`);
    L.push('');
    L.push('| lead | klass | captured cycle | age | claim |');
    L.push('|---|---|---|---|---|');
    for (const r of shown) {
      const ms = capturedMs(r);
      const age = (reference !== null && ms !== null) ? `${Math.max(0, Math.floor((reference - ms) / DAY_MS))} days` : '—';
      L.push(`| \`${cell(r.id, 60)}\` | ${cell(r.klass, 24)} | \`${cell((r.provenance && r.provenance.cycleId) || '—', 40)}\` | ${age} | ${cell(r.claim, 60)} |`);
    }
    if (sorted.length > shown.length) {
      L.push(`_… and ${sorted.length - shown.length} more open lead(s) in \`memory/candidates/\` (the ${shown.length} oldest of ${sorted.length} shown above)._`);
    }
  }
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
 * ⭐ B2 · THE DECISION INDEX — A FOURTH RENDERED DOCUMENT, WHOSE SOURCE IS THE SHARD DIRECTORY, NOT
 * STATE.json. `docs/DECISIONS.md` grew without bound (230 KB on a live target) and the boot read it
 * whole; it is now a rendered, verified INDEX over one file per decision under `docs/decisions/`.
 *
 * ⛔ SAME CONTRACT AS THE LESSONS REGISTER, EXTENDED, NEVER A LOOSER ONE. Same GEN/NOTE markers, same NOTE
 * budget, the same DF-011 pair (every count is rendered from the shard and parsed back out and checked),
 * and the store is an ARGUMENT — the caller reads `docs/decisions/` through decisions.js and hands the
 * snapshot here, so this module still opens no file (the schema fence asserts that). The verifier FAILs a
 * shard whose frontmatter contradicts its own heading: the index is rendered from the frontmatter, so a
 * frontmatter the body does not back is exactly the stale-but-plausible surface DF-011 exists to catch.
 */
const DECISIONS_INDEX_BUDGET = 8192; // B3 · the generated block a reader loads stays under 8 KB; over it, top rows + an "N more" line
const idNumOf = (id) => { const m = /(\d+)/.exec(String(id || '')); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };
function decisionsCounts(store) {
  const records = (store && Array.isArray(store.records)) ? store.records : [];
  return { 'decision entries': records.length, 'removal entries': records.filter((r) => r.removal).length };
}

function renderDecisions(existing, store) {
  const s = store || { status: 'UNREADABLE', records: [], reason: 'no decision shard was handed to the renderer' };
  const records = Array.isArray(s.records) ? s.records : [];
  const readable = s.status === 'OK' || s.status === 'ABSENT';
  const counts = decisionsCounts(s);
  const note = planNote(existing, 'DECISIONS.md', s).text;

  const L = [];
  L.push('# Decisions & Removals');
  L.push('');
  L.push('> ⚙️ **GENERATED index of `docs/decisions/`.** One row per decision file; a ⛔ row is a removal');
  L.push('> (negative knowledge: do not reintroduce it). Every count below is recounted from the shard on');
  L.push('> each run and verified back against it. Hand-edits inside the generated block are overwritten and');
  L.push('> flagged. Author a decision as a new file under `docs/decisions/`, and write prose in the NOTE');
  L.push('> block instead (it survives).');
  L.push('');
  L.push(NOTE_OPEN);
  L.push(note || '_(no human note)_');
  L.push(NOTE_CLOSE);
  L.push('');
  // Outside the block, for the reason renderContinuity states: a timestamp inside it would make every run
  // differ from a fresh render and turn the stale-block check into a permanent false alarm.
  L.push(`_Generated ${s.generatedAt || 'at an unrecorded time'}._`);
  L.push('');
  L.push(GEN_OPEN);
  L.push('');
  if (!readable) {
    L.push(`_The decision shard at \`docs/decisions/\` could not be read (${s.reason || 'no reason recorded'}), so no index below is a complete list. This is not "no decisions": it is "nobody could look"._`);
    L.push(''); L.push(GEN_CLOSE); L.push('');
    return L.join('\n');
  }
  // The count line always renders (even at zero) so the verifier always has a claim to check — an empty
  // index that rendered no number would read to verifyDecisions as "the renderer and I have drifted".
  L.push(`**${counts['decision entries']} decision entries · ${counts['removal entries']} removal entries (⛔).**`);
  L.push('');
  if (!records.length) {
    // ⛔ NO VOLATILE REASON IN THE BLOCK. An empty render must be deterministic regardless of WHY the
    // shard is empty (an install-time seed, an absent directory, a readShard reason that varies by host),
    // or the generated block would differ between the shipped seed and a fresh render and FAIL its own
    // drift check. The count line above already states "0 decision entries".
    L.push('_Nothing under `docs/decisions/` yet. Author one as `docs/decisions/D-001-<slug>.md`, or split an existing `docs/DECISIONS.md` monolith with `respawnpack migrate decisions --write`._');
    L.push(''); L.push(GEN_CLOSE); L.push('');
    return L.join('\n');
  }
  /*
   * ⛔ ORDER IS REMOVALS FIRST, THEN MOST RECENT — AND IT IS WHAT THE CAP KEEPS. A reader needs the
   * negative knowledge (a ⛔ row) and the latest decisions before an old settled one; a stable sort
   * (removal desc, id desc, source order) makes a fresh render reproduce this prefix byte-for-byte, so
   * `generated-block` stays bound. The FULL set stays in the shard; a row not shown is still counted.
   */
  const ordered = records.map((r, i) => [r, i])
    .sort((a, b) => (Number(b[0].removal) - Number(a[0].removal)) || (idNumOf(b[0].id) - idNumOf(a[0].id)) || (a[1] - b[1]))
    .map(([r]) => r);
  const header = ['| id | date | title | status | ⛔ |', '|---|---|---|---|---|'];
  // The index lives at docs/DECISIONS.md, so a shard link is relative to docs/, not to the project root.
  // r.file is stored project-root-relative (docs/decisions/<file>), which is where the shard is written;
  // emitting it verbatim as the href makes a reader resolve docs/docs/decisions/<file> and find nothing,
  // dead for every reader, GitHub included. The link must start at the decisions/ segment beside this
  // index. Found by release/build-public.sh's dead-link sweep on examples/todo-app.
  const shardHref = (file) => { const f = String(file); const i = f.indexOf('decisions/'); return i > 0 && f[i - 1] === '/' ? f.slice(i) : f; };
  const rowOf = (r) => `| [\`${cell(r.id, 40)}\`](${shardHref(r.file)}) | ${cell(r.date, 20)} | ${cell(r.title, 80)} | ${cell(r.status, 24)} | ${r.removal ? '⛔' : ''} |`;
  const rows = ordered.map(rowOf);
  // Byte-aware cap: keep as many high-priority rows as fit, reserving overhead for the count line, the
  // markers, the blank lines and the "N more" line — so the whole generated block stays under the budget,
  // not just the rows. Always keep at least one row so the table is never a bare header.
  const ceiling = DECISIONS_INDEX_BUDGET - 320;
  const headerLen = header.join('\n').length;
  let shown = rows.length;
  let used = headerLen + rows.reduce((n, r) => n + r.length + 1, 0);
  if (used > ceiling) {
    shown = 0; used = headerLen;
    for (const r of rows) { if (used + r.length + 1 > ceiling && shown >= 1) break; used += r.length + 1; shown += 1; }
  }
  L.push(...header);
  for (const r of rows.slice(0, shown)) L.push(r);
  L.push('');
  if (shown < rows.length) {
    L.push(`_… ${rows.length - shown} more in \`docs/decisions/\` (the ${shown} highest-priority of ${rows.length} shown above — removals first, then most recent)._`);
    L.push('');
  }
  L.push(GEN_CLOSE);
  L.push('');
  return L.join('\n');
}

/**
 * ⭐ `verifyRendered`'s twin over the decision shard. Same three verdicts, plus the shard-specific FAIL:
 * a frontmatter that contradicts its body heading. A proven contradiction outranks a count match, so it
 * FAILs even when the counts agree — the index was rendered from a frontmatter the body does not back.
 */
function verifyDecisions(text, store, { file = 'docs/DECISIONS.md' } = {}) {
  const s = store || {};
  const check = `rendered-claims:${removalsLib.posix(file)}`;
  const readable = s.status === 'OK' || s.status === 'ABSENT';
  if (!readable) {
    return result(OUTCOME.CANNOT_DETERMINE, check,
      `the decision shard at docs/decisions/ could not be read (${s.reason || 'no reason recorded'}), so nothing in ${file} could be checked against it. This is CANNOT_DETERMINE, never a pass.`, { checked: 0 });
  }
  const records = Array.isArray(s.records) ? s.records : [];
  // Two files claiming one decision id: each passes its own frontmatter check, so this is caught here,
  // by id and both files, and outranks a count match the same way a contradiction does.
  const dups = Array.isArray(s.duplicates) ? s.duplicates : [];
  if (dups.length) {
    return result(OUTCOME.FAIL, check,
      `${dups.length} decision id(s) under docs/decisions/ are claimed by more than one file, so the index cannot say which one is the decision: ${dups.map((d) => `duplicate id ${d.id} in ${d.files.join(' and ')}`).join(' · ')}. Keep one file per id.`,
      { checked: records.length });
  }
  const mism = records.filter((r) => r.mismatch);
  if (mism.length) {
    return result(OUTCOME.FAIL, check,
      `${mism.length} shard file(s) under docs/decisions/ have a frontmatter that contradicts their own heading, so the index rendered from the frontmatter cannot be trusted: ${mism.map((r) => r.mismatch).join(' · ')}`,
      { checked: records.length });
  }
  const map = decisionsCounts(s);
  const claims = numericClaims(text, { labels: Object.keys(map) });
  const failures = claims
    .filter((cl) => map[cl.label] !== cl.number)
    .map((cl) => ({ line: cl.line, label: cl.label, prose: cl.number, source: map[cl.label], text: cl.text }));
  const verdict = verdictFromCount({ check, checked: claims.length, failures, subject: file });
  if (verdict.outcome === OUTCOME.FAIL) {
    verdict.detail = failures.map((f) => `${file}:${f.line} says ${f.prose} ${f.label}, the shard holds ${f.source}`).join(' · ');
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

/*
 * ⭐ D3 · THE HANDOFF BUNDLE — THE FOURTH RENDERED DOCUMENT, A POINTER-FIRST PROJECTION.
 *
 * The field kept its real handoff state in CONTINUITY's human note and had it cut (B3's finding). A
 * fresh session's first need, in order, is: what was I doing, what is next, what is blocked, what did I
 * touch, how do I check it. `docs/derived/HANDOFF.md` answers exactly those five, each section opening
 * with WHERE the complete record lives and carrying only what the next session needs to pick its first
 * action. It is read FIRST at boot, before CONTINUITY.
 *
 * ⛔ IT IS A PROJECTION, NEVER A THIRD RECORD. The pack already writes two machine handoffs (the
 * precompact record and the rollover handoff) and the durable state in STATE.json/goal.json; this
 * renders from what the kernel already knows at `--write` and POINTS at those records rather than
 * copying them. Its generated block is verified like the others (verifyRendered binds the "next
 * unblocked" count; driftFromGenerated FAILs a hand edit), and the volatile `_Generated` stamp lives
 * outside the block for the same reason it does in CONTINUITY.
 *
 * ⛔ ONE NOTE, NOT TWO. HANDOFF carries no NOTE block of its own: its generated block POINTS at
 * CONTINUITY's note, so the operator's prose has a single home and the two cannot drift apart.
 *
 * ⛔ IT STILL OPENS NO FILE (the module-wide fence). The caller computes the volatile facts — the mode,
 * the files-touched delta and the project's verify commands — and hands them here as `handoff`, exactly
 * as the lessons store is handed to renderLessons.
 */
const HANDOFF_WORD_BUDGET = 1500; // a pointer-first summary, not a second handoff document — whitespace-separated words

/*
 * One trimmable list: the available items, a current cap, and the TRUE total the list is a prefix of.
 * Renders a "…and N more in <where>" pointer when the shown prefix is short of the true total — whether
 * that is because the word-budget loop cut the cap, or because the caller already bounded the list
 * (the compiler caps nextUnblockedWork; the savepoint caps the files list), so both truncations surface
 * the same way and neither is silent.
 */
function handoffList(items, cap, trueTotal, moreWhere) {
  const shown = items.slice(0, Math.max(0, cap));
  const lines = shown.slice();
  const total = Number.isFinite(trueTotal) ? trueTotal : items.length;
  const hidden = Math.max(0, total - shown.length);
  if (hidden > 0) lines.push(`  - _…and ${hidden} more in ${moreWhere}_`);
  return lines;
}

/*
 * Build the whole document from the compiled state and the caller-computed `handoff` facts, with a cap
 * per trimmable list. The fixed pointer lines and the true `next unblocked` count are never cut; only
 * the lists shrink (renderHandoff's budget loop reduces the LONGEST list one item at a time), so the
 * document stays under HANDOFF_WORD_BUDGET without ever losing a pointer — B3's cap pattern.
 */
function buildHandoff(state, handoff, caps) {
  const h = handoff || {};
  const c = state.counts || {};
  const nextList = (state.nextUnblockedWork || []).map((n) => `  - \`${n.id}\` ${n.title} (${n.status})`);
  const nextTotal = Number.isFinite(c.nextUnblocked) ? c.nextUnblocked : nextList.length;
  const blockerList = (state.blockers || []).map((b) => `- \`${b.id}\` ← ${(b.blockedBy || []).join(', ')}${b.missingAuthority ? ` · missing: ${b.missingAuthority}` : ''}`);
  const files = (h.filesTouched && h.filesTouched.shown) || [];
  const fileList = files.map((f) => `  - \`${f}\``);
  const verifyList = ((h.verifyCommands || []).map((cmd) => `- \`${cmd}\``));
  const STATE_JSON = '`docs/derived/STATE.json`';

  const L = [];
  L.push('# HANDOFF');
  L.push('');
  L.push('> ⚙️ **GENERATED pointer-first handoff — read first, before CONTINUITY.** Hand-edits inside the block are flagged.');
  L.push('');
  // Outside the generated block, exactly as renderContinuity does it: a stamp inside the block would make
  // every run differ from a fresh render and turn the stale-block check into a permanent false alarm.
  L.push(`_Generated ${state.generatedAt || 'at an unrecorded time'}._`);
  L.push('');
  L.push(GEN_OPEN);
  L.push('');

  // 1 · what was I doing
  L.push('## Current task');
  L.push('> Full record: `docs/derived/state/goal.json`; prose: the `RESPAWNPACK:NOTE` block in `docs/derived/CONTINUITY.md`.');
  if (h.mode) L.push(`- **Contract mode:** ${h.mode}`);
  L.push(`- **Project goal:** ${state.goal || '_none recorded_'} — ${state.goalComplete ? '✅ complete' : '⏳ not complete'}`);
  if (state.milestone) L.push(`- **Active milestone:** ${state.milestone} — ${state.milestoneComplete ? '✅ complete' : '⏳ not complete'}`);
  L.push(`- **Current atomic task:** ${state.currentAtomicTask || '_none recorded_'}`);
  L.push('');

  // 2 · what is next
  L.push('## Next unblocked');
  L.push(`> Full list: ${STATE_JSON} \`nextUnblockedWork\`.`);
  L.push(`- ${nextTotal} next unblocked items of mandatory work`);
  for (const line of handoffList(nextList, caps.next, nextTotal, STATE_JSON)) L.push(line);
  L.push('');

  // 3 · what is blocked
  L.push('## Blockers');
  L.push(`> Full set: ${STATE_JSON} \`blockers\`.`);
  if (blockerList.length) for (const line of handoffList(blockerList, caps.blockers, blockerList.length, STATE_JSON)) L.push(line);
  else L.push('- _none — no mandatory requirement is blocked_');
  L.push('');

  // 4 · what did I touch. Frozen at the last --write (its cycle id in the heading) and rendered from that
  // snapshot on every verify, so the live tree moving does not make a verify disagree with a fresh render.
  L.push(h.writeCycle ? `## Files touched (at the last write, cycle ${h.writeCycle})` : '## Files touched');
  L.push('> Full delta: the session baseline under `.respawnpack/runtime/`; frozen at the last write.');
  const ft = h.filesTouched || { source: 'unavailable' };
  if (ft.source === 'session-delta') {
    L.push(`- ${ft.total} file(s) changed since this session started${ft.headMoved ? ' (HEAD also moved)' : ''}`);
  } else if (ft.source === 'uncommitted') {
    L.push(`- no session baseline for this run, so this lists the ${ft.total} uncommitted file(s) in the working tree instead of a session delta`);
  } else {
    L.push('- the working tree could not be read, so no file list is available');
  }
  for (const line of handoffList(fileList, caps.files, ft.total, STATE_JSON)) L.push(line);
  L.push('');

  // 5 · how do I check it
  L.push('## Verify commands');
  L.push('> Declared in `respawnpack.config.json`; listed here, never run.');
  if (verifyList.length) for (const line of handoffList(verifyList, caps.verify, verifyList.length, STATE_JSON)) L.push(line);
  else L.push('- _none declared_');
  L.push('');

  // 6 · what has been done, and what is still broken (G17). The log count is a FROZEN snapshot (so the
  // savepoint's own row, appended after this render, and operator rows between writes never make a verify
  // disagree); the open incidents are read LIVE by the caller (the file moves only by a verb). Both are
  // POINTERS, never a second copy of a result or a fix body - HANDOFF stays a projection.
  L.push('## Operations');
  L.push('> Full log: `.respawnpack/ops-log.jsonl` (machine-local); incidents: `memory/incidents/`.');
  const ops = h.opsLog || null;
  if (ops && ops.rows > 0 && ops.last) {
    const when = String(ops.last.at || '').slice(0, 10) || 'undated';
    L.push(`- ${ops.rows} log row(s) at the last write; last: ${ops.last.action} (${ops.last.result}, ${when})`);
  } else {
    L.push('- no ops log on this machine');
  }
  const inc = h.openIncidents || { ids: [], total: 0 };
  const incTotal = Number.isFinite(inc.total) ? inc.total : (inc.ids || []).length;
  L.push(`- ${incTotal} open incident(s)`);
  if (incTotal > 0) {
    const incList = (inc.ids || []).map((id) => `  - \`${id}\``);
    for (const line of handoffList(incList, caps.incidents, incTotal, '`memory/incidents/`')) L.push(line);
  } else {
    L.push('  - _none_');
  }
  L.push('');
  L.push(GEN_CLOSE);
  L.push('');
  return L.join('\n');
}

// D3: the byte ceiling the renderer enforces as the INNER bound (the 1,500-word budget is the outer one),
// so a busy project cannot quietly bust the boot budget. The caller passes its configured value; this is
// the fallback when none is handed in. 1,600 B keeps the worst case (HANDOFF at its cap) under the boot
// ceiling with margin on the merged tree, proven at the cap by skills/respawn/boot-set.test.mjs.
const HANDOFF_BYTE_CAP = 1600;

/**
 * renderHandoff — the pointer-first handoff, bounded to BOTH HANDOFF_WORD_BUDGET and a byte cap
 * (handoff.byteCap, default HANDOFF_BYTE_CAP) by cutting the LONGEST list one item at a time (never a
 * pointer, never the true next-unblocked count). Deterministic: the same state and handoff facts
 * reproduce the same bytes, so driftFromGenerated keeps comparing equal.
 */
function renderHandoff(handoff, state) {
  const byteCap = (handoff && Number.isFinite(handoff.byteCap) && handoff.byteCap > 0) ? handoff.byteCap : HANDOFF_BYTE_CAP;
  const full = {
    next: (state.nextUnblockedWork || []).length,
    blockers: (state.blockers || []).length,
    files: ((handoff && handoff.filesTouched && handoff.filesTouched.shown) || []).length,
    verify: ((handoff && handoff.verifyCommands) || []).length,
    // G17 · the open-incident list is trimmable too, and it is cut FIRST (see the order below): a busy
    // handoff that cannot fit drops the incident ids (the pointer and the count stay) before any other list.
    incidents: ((handoff && handoff.openIncidents && handoff.openIncidents.ids) || []).length,
  };
  const caps = { ...full };
  let doc = buildHandoff(state, handoff, caps);
  // Trim the currently-longest list by one item until the whole document fits BOTH bounds; a fixed key
  // order breaks ties so a fresh render reproduces the same cut. The fixed pointer lines never enter this
  // loop, so the byte cap can shrink the lists to nothing but never drop a section's pointer.
  const over = (d) => countWords(d) > HANDOFF_WORD_BUDGET || Buffer.byteLength(d, 'utf8') > byteCap;
  const order = ['incidents', 'blockers', 'files', 'next', 'verify'];
  while (over(doc)) {
    let pick = null;
    for (const k of order) if (caps[k] > 0 && (pick === null || caps[k] > caps[pick])) pick = k;
    if (pick === null) break; // only pointers and the fixed counts remain — nothing left to cut
    caps[pick] -= 1;
    doc = buildHandoff(state, handoff, caps);
  }
  return doc;
}

module.exports = { renderContinuity, renderGaps, renderLessons, renderDecisions, renderHandoff, verifyRendered, verifyLessons, verifyDecisions, driftFromGenerated, generatedBlockOf, planMigration, planRestore, planNote, noteBudgetCheck, rawNote, countMap, countWords, decisionsCounts, lessonsCounts, analyzeGraph, analyzeBindings, classifyBinding, LESSONS_LABELS, NOTE_BUDGET, GENERATED_ROW_CAP, HANDOFF_WORD_BUDGET, HANDOFF_BYTE_CAP, DEFAULT_STALE_HORIZON_DAYS, DECISIONS_INDEX_BUDGET, GEN_OPEN, GEN_CLOSE, NOTE_OPEN, NOTE_CLOSE, liveClause };

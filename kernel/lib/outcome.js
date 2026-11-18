/*
 * RespawnPack · kernel/lib/outcome.js — the four-outcome contract.
 *
 * ⛔ THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE. Two dogfood runs produced the same shape twice:
 *   • field run A: `validating 9 file(s) under data/ (0 content object(s)) … clean: 0 errors`.
 *     A validator reported clean while asserting against nothing.
 *   • field run B (DF-007 #6, #7): a grep whose `cd` had not persisted returned 0 for every subsystem, and a
 *     symbol check returned 0 for the VALID names too. Both read as confirmation.
 * DOGFOOD.md states the rule outright: **"A count-checker that parses zero claims returns
 * CANNOT_DETERMINE, never MATCH. One that matches nothing agrees with everything, which is how a
 * checker becomes decoration."**
 *
 * So there is no boolean here. Two-valued results force a checker that could not look into the same
 * bucket as one that looked and found nothing wrong — and that collapse is the bug.
 *
 *   PASS              the check ran, had something to check, and it held
 *   FAIL              the check ran and found a real disagreement
 *   CANNOT_DETERMINE  the check could not do its job: nothing parsed, a source was missing, a control
 *                     failed to discriminate. NOT a pass. NOT a warning.
 *   NOT_APPLICABLE    the check has no subject here (no compliance dir in a project with no compliance
 *                     obligation). Genuinely neutral, and the only outcome that is.
 */
const OUTCOME = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  CANNOT_DETERMINE: 'CANNOT_DETERMINE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

// Severity for rollup. NOT_APPLICABLE is below PASS because it never makes an aggregate worse.
const RANK = { NOT_APPLICABLE: 0, PASS: 1, CANNOT_DETERMINE: 2, FAIL: 3 };

/*
 * WHICH QUESTION A ROW ANSWERS. Not a severity and never a softener — `domain` says what KIND of
 * question was asked, so a reader can tell "the projection disagrees with the source" from "nobody has
 * decided whether this contract applies here" without either one changing what its outcome means.
 *
 *   integrity   the projection, the render or the writeback disagrees with its source
 *   coverage    has anybody DECIDED whether this contract applies to this project
 *   install     what the installer placed, and whether the target still carries it
 *   gate        the project's own quality gate — kernel/lib/gate.js
 *
 * Declared as a set rather than left free-form because a misspelled tag is invisible: it groups a row
 * under a domain nothing reads, which is the same silence a missing row would produce.
 */
const DOMAIN = { integrity: 'integrity', coverage: 'coverage', install: 'install', gate: 'gate' };

/**
 * One check's verdict.
 *
 *   outcome   one of the four above, and the only field an exit code is ever derived from
 *   check     the stable parameterised id — `gate:backend:test`, `rendered-claims:docs/x.md`
 *   detail    what a human needs to read to act on it
 *   checked   HOW MANY things it looked at; a PASS that supplies zero here is a programming error
 *   domain    which question it answers, from DOMAIN above
 *   subject   WHAT it looked at — the file, the command, the declaration
 *   label     the emitting subsystem's own richer word for the same verdict (NOT_CONFIGURED,
 *             COULD_NOT_RUN, SILENTLY INACTIVE). A DISPLAY field: it keeps the diagnostic precision
 *             that made doctor and gate grow private vocabularies, without giving the pack a second
 *             exit vocabulary. Nothing routes an exit code, a rollup or a refusal through `label`.
 *
 * Only `outcome`, `check`, `detail` and `checked` are always present; the other three ride along when
 * the caller supplies them, so a row's key set stays exactly what its emitter chose to say.
 */
function result(outcome, check, detail, extra = {}) {
  if (!(outcome in OUTCOME)) throw new Error(`unknown outcome: ${outcome}`);
  if (Object.prototype.hasOwnProperty.call(extra, 'domain') && !(extra.domain in DOMAIN)) {
    throw new Error(`${check}: unknown domain: ${JSON.stringify(extra.domain)} — expected one of ${Object.keys(DOMAIN).join(' | ')}`);
  }
  /*
   * ⛔ A PASS THAT ADMITS IT CHECKED ZERO SUBJECTS IS A PROGRAMMING ERROR, NOT A VERDICT.
   * Keep this at the shared constructor so a future checker cannot re-create the silent-green shape
   * by forgetting a local guard. Omit `checked` when a check has no subject count; once a checker
   * supplies the key, PASS requires a positive finite number (`null` is not a count).
   */
  if (outcome === OUTCOME.PASS && Object.prototype.hasOwnProperty.call(extra, 'checked')
      && (!Number.isFinite(extra.checked) || extra.checked <= 0)) {
    throw new Error(`${check}: PASS requires checked > 0, got ${JSON.stringify(extra.checked)} — zero work cannot pass`);
  }
  return { outcome, check, detail, checked: extra.checked ?? null, ...extra };
}

/**
 * The guard that turns the dogfood rule into a mechanism rather than a habit. Every check that counts
 * things routes its verdict through here, so "I examined zero items" can never be spelled PASS.
 */
function verdictFromCount({ check, checked, failures, subject }) {
  if (!Number.isFinite(checked) || checked <= 0) {
    return result(OUTCOME.CANNOT_DETERMINE, check,
      `parsed 0 claims from ${subject} — a check that matches nothing agrees with everything`, { checked: 0 });
  }
  if (failures && failures.length) {
    return result(OUTCOME.FAIL, check, `${failures.length} of ${checked} claim(s) disagree with source`, { checked, failures });
  }
  return result(OUTCOME.PASS, check, `${checked} claim(s) verified against source`, { checked });
}

/** Roll many verdicts into one. The worst outcome wins; there is no averaging. */
function rollup(results) {
  if (!results.length) return OUTCOME.CANNOT_DETERMINE; // ran nothing ⇒ determined nothing
  return results.reduce((worst, r) => (RANK[r.outcome] > RANK[worst] ? r.outcome : worst), OUTCOME.NOT_APPLICABLE);
}

/**
 * Process exit code. CANNOT_DETERMINE gets its OWN code: a caller that cannot tell "the check failed"
 * from "the check could not run" will eventually treat the second as the first, or worse, as success.
 */
function exitCodeFor(outcome) {
  return { PASS: 0, NOT_APPLICABLE: 0, FAIL: 1, CANNOT_DETERMINE: 2 }[outcome] ?? 1;
}

module.exports = { OUTCOME, RANK, DOMAIN, result, verdictFromCount, rollup, exitCodeFor };

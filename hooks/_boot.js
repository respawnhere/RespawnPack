/*
 * RespawnPack · hooks/_boot.js — THE IRREDUCIBLE HOOK BOOTSTRAP BOUNDARY.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHAT THIS EXISTS TO END, REPRODUCED ON A REAL INSTALLED TARGET AT 30a6ec5.
 *
 * The previous round gave every shared module a typed contract, so `doctor` correctly reported a
 * module that LOADS but has lost an export. It did nothing about a module that cannot load at all,
 * because every hook reached its dependencies through a bare top-level `require`:
 *
 *     .claude/hooks/_artifact.js made syntactically invalid
 *       doctor                       → _artifact.js, _runtime.js and every dependent hook BROKEN ✅
 *       session-routing-nudge.js     → exit 1, raw SyntaxError out of _runtime.js's hard require,
 *                                      NO stdout, NO additionalContext, no warning of any kind
 *       index-guard.js (PreToolUse)  → exit 1, no decision at all
 *
 * A nonzero exit from a PreToolUse hook is a NON-BLOCKING error: the host reports it and RUNS THE TOOL
 * ANYWAY. So the index guard did not fail closed, it failed OPEN — the one direction a guard may never
 * fail — and it did so at exactly the moment its own machinery was broken. And the SessionStart hook
 * did not degrade conservatively, it VANISHED, taking the session's constraints and forbidden actions
 * with it. Doctor being honest does not help a hook that dies before it can speak.
 *
 * ⭐ THE BOUNDARY, STATED — AND IT IS THIS FILE ALONE. This file plus Node's own builtins is the
 * irreducible bootstrap: a defect HERE is a raw crash, exactly as `respawnpack.js`, `outcome.js` and
 * `modhealth.js` are for the kernel. Everything a hook reaches beyond this file — every module in
 * `modhealth.SHARED`, INCLUDING `_contracts.js` — is loaded through `need()` and cannot take the hook
 * down with it. That boundary is named and bounded rather than implied, and a fence asserts every hook
 * with shared dependencies actually enters through it.
 *
 * ⛔ `_contracts.js` IS NOT PART OF IT, AND SAYING OTHERWISE OVERSTATED ITS BLAST RADIUS. Both files
 * used to call the pair "the bootstrap", implying a broken contract source kills a hook. It does not:
 * `need()` requires it inside a `try`, and on a real disposable installed target at de7a87a all five
 * load-and-interface damage modes produced the SessionStart warning at native exit 0 and an index-guard
 * DENY at native exit 0. `_contracts.js` is a PROTECTED, LOAD-BEARING CONTRACT SOURCE; the ordinary
 * shared modules are PROTECTED DEPENDENCIES; only this file is irreducible.
 *
 * ⭐ FIVE DAMAGE MODES, ONE GATE, ONE POSTURE.
 *   missing file · invalid syntax · module-scope throw   →  `need()` cannot require it
 *   missing required export · wrong export type          →  `need()` VALIDATES the loaded module against
 *                                                           the same typed contract doctor uses, before
 *                                                           returning it to policy logic
 * All five land in the same `degrade()`, so a hook cannot have one posture for the failures somebody
 * thought of and another for the rest.
 *
 * ⛔ AND THE PREVIOUS VERSION OF THIS COMMENT WAS FALSE, WHICH IS WHY IT IS SPELLED OUT. It claimed the
 * process-level net caught missing and wrong-typed exports "because that is when a contract violation
 * becomes a TypeError". A contract violation does not have to become anything. Reproduced at c398416:
 * `_shell.HIDDEN_PROGRAM` retyped to an object threw nothing, made
 * `parsed.unsupportedKind === shell.HIDDEN_PROGRAM` false, and dropped `bash -c "$CMD"` into the branch
 * that says "index-ownership checks were skipped" — a healthy DENY turned into an ALLOW, at native exit
 * 0, while doctor reported both the module and the hook BROKEN. An exception-based check can only see
 * the contract damage that happens to throw.
 *
 * The net in `arm()` REMAINS, and its job is now stated honestly: it is a last-resort catch for
 * arbitrary implementation errors anywhere in the hook. It is NOT a contract validator, and it must not
 * tell an operator that doctor will identify a broken module — because when the bug is in the hook's
 * own logic, doctor will correctly report every module ACTIVE.
 *
 * ⛔ WHAT THIS DOES **NOT** CLAIM. It does not diagnose arbitrary module-scope execution: `need()`
 * EVALUATES the module it loads, so a dependency that throws at module scope is caught here — but a
 * dependency that performs real side effects at module scope will have performed them, and nothing
 * here can undo that. It also does not classify WHY a module failed the way `kernel/lib/modhealth.js`
 * does; a hook needs the conservative answer and the reason in one line, and `doctor` is where the
 * five-state classification lives.
 */
const path = require('path');

/*
 * The posture a hook takes when its machinery is unavailable. Chosen by the hook at `arm()` time,
 * because it is a property of what the hook GUARDS, not of what broke.
 *
 *   deny           a safety-critical PreToolUse guard. Emits an explicit DENY decision at exit 0 —
 *                  never a nonzero exit, which the host treats as a non-blocking error and proceeds
 *                  through. A guard whose policy machinery will not load has not established that the
 *                  operation is safe, and "not established" is not "allowed".
 *   session-start  emits VALID SessionStart event output carrying an explicit state-unavailable /
 *                  claims-withheld warning. A session that is told nothing assumes nothing is wrong.
 *   advisory       a nudge or a bookkeeper. Says why on stderr and exits 0 without a stack: it had
 *                  nothing to enforce, and turning its own breakage into a failed turn helps no one.
 */
const POSTURES = new Set(['deny', 'session-start', 'advisory']);

let posture = 'advisory';
let event = null;
let degrading = false;

const firstLine = (e) => String((e && e.message) || e).split(/\r?\n/)[0].trim().slice(0, 300);
const nameOf = (e) => (e && e.constructor && e.constructor.name) || 'Error';

const DOCTOR = 'node .claude/respawnpack/respawnpack.js doctor';

/**
 * Emit this hook's conservative answer and leave. Never returns.
 * ⛔ ALWAYS exit 0. The host reads the DECISION, not the exit code, and a nonzero exit from a
 * PreToolUse hook runs the tool anyway — which is how the reported failure became a bypass.
 *
 * `attributable` says whether the cause is a named module doctor can actually report on. The
 * process-level net cannot know that — it catches implementation errors too — so it says so instead of
 * sending an operator to a report that will correctly show every module ACTIVE.
 */
function degrade(detail, attributable = true) {
  // A throw inside the degradation path must not re-enter it. Fail to the quietest safe answer.
  if (degrading) { try { process.stderr.write(`RespawnPack: degradation failed re-entrantly — ${detail}\n`); } catch { /* nothing left */ } process.exit(0); }
  degrading = true;

  const why = attributable
    ? `${detail} · run \`${DOCTOR}\`, which reports the broken module as a row rather than dying on it`
    : `${detail} · this was raised while the hook was RUNNING, so it may be a defect in the hook itself `
      + `rather than in a shared module. \`${DOCTOR}\` may therefore report every module ACTIVE; the message above is the evidence`;

  if (posture === 'session-start' || event === 'SessionStart') {
    const context = '⚠️ PROJECT STATE UNAVAILABLE — RespawnPack could not load its own machinery, so no project '
      + 'state was read. Every count, completion claim, constraint, forbidden action and blocker is WITHHELD: '
      + 'this is a FAULT, not a project with nothing to report, and the two must not be treated alike. Do not '
      + 'infer that there are no constraints in force.\n'
      + `Reason: ${why}.`;
    try { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })); }
    catch { /* stdout is gone; the exit below is all that is left */ }
    process.exit(0);
  }

  if (posture === 'deny' && (event === null || event === 'PreToolUse')) {
    const reason = '🔒 RespawnPack: this operation is DENIED because the guard that would have judged it could not '
      + `load. ${why}.\nA guard whose policy machinery is unavailable has not established that this is safe, and `
      + 'refusing on an unavailable check is the only direction that cannot cause the harm it exists to prevent. '
      + 'Repair the installation (or remove the hook) rather than retrying.';
    try {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }));
    } catch { /* stdout is gone */ }
    process.exit(0);
  }

  try { process.stderr.write(`RespawnPack hook degraded (${event || 'unknown event'}): ${why}\n`); } catch { /* nothing left */ }
  process.exit(0);
}

/**
 * Arm the boundary. Call this FIRST, before any other require in the hook, so the process-level net is
 * in place before anything can throw past it.
 */
function arm(p) {
  posture = POSTURES.has(p) ? p : 'advisory';
  /*
   * ⛔ A LAST-RESORT NET, AND NOTHING MORE THAN THAT. It exists so an unforeseen throw anywhere in the
   * hook — including inside the asynchronous stdin callback every hook uses — still produces this
   * hook's conservative answer instead of a bypass.
   *
   * It is NOT a contract validator and must never be described as one. `need()` establishes that a
   * module's API is usable; this catches what neither the contract nor anyone else predicted, and it
   * cannot distinguish a broken module from a bug in the hook. So it degrades UNATTRIBUTABLY: the
   * operator is told the fault may be in the hook itself and that doctor may show everything ACTIVE.
   */
  process.on('uncaughtException', (e) => degrade(`${nameOf(e)}: ${firstLine(e)}`, false));
  process.on('unhandledRejection', (e) => degrade(`unhandled rejection — ${nameOf(e)}: ${firstLine(e)}`, false));
}

/** Record the real event once stdin has been parsed, so the degraded output matches it. */
function observed(name) { if (typeof name === 'string' && name) event = name; }

/**
 * Load a shared module AND validate its declared contract, or degrade. Resolves against THIS directory,
 * so a hook cannot accidentally reach a different copy of the module the installer placed beside it.
 *
 * ⛔ THE VALIDATION IS NOT OPTIONAL AND IS NOT SKIPPED WHEN THE CONTRACT SOURCE IS MISSING. A hook that
 * cannot check its machinery has not established that the machinery is usable, and "not established"
 * is not "fine" — so an unreadable `_contracts.js` degrades exactly like an unreadable dependency.
 */
function need(spec) {
  const base = spec.replace(/^\.\//, '');
  const abs = path.join(__dirname, base);

  let contracts;
  try {
    /*
     * ⛔ THE PACK'S OWN SPELLING, `require('./x.js')`, NOT `require(path.join(__dirname, 'x.js'))`.
     * They resolve identically — but every dependency derivation in this repository (doctor's graph,
     * the counts fence's installer/uninstaller/docs reconciliation, the registry drift fence) reads the
     * literal form, and the path.join form made `_contracts.js` invisible to all three at once: no
     * doctor row, and a shared-module inventory that counted eight where the pack ships nine.
     */
    contracts = require('./_contracts.js');
  } catch (e) {
    degrade(`the contract source _contracts.js could not be loaded — ${nameOf(e)}: ${firstLine(e)}. `
      + 'Nothing can be validated against it, so no shared module can be trusted');
  }

  /*
   * ⛔ THE SMALLEST BOOTSTRAP-INTERFACE CHECK, AND THE REASON IT CANNOT BE DELEGATED. Everything else in
   * this directory is validated by `loadedContractViolations` below — including `_contracts.js` itself,
   * which is an ordinary entry in `CONTRACTS`. But that self-check RUNS ON these two members, so it
   * cannot be the thing that establishes them. A contract source cannot answer questions about the parts
   * of itself the answering machinery is made of.
   *
   * ⛔ AND THE WRONG-TYPE HALF IS THE ONE THAT MATTERED. Reproduced on a real disposable installed target
   * at de7a87a, `module.exports.CONTRACTS = ['not','an','object']` and nothing else:
   *
   *     `contracts.CONTRACTS[base]` returned undefined for every module → `if (!contract) continue` →
   *     loadedContractViolations returned [] → EVERY shared module was handed to policy logic UNVALIDATED,
   *     silently, with no degradation and no warning. Composed with the c398416 P0 (`_shell.HIDDEN_PROGRAM`
   *     retyped) the guard went from DENY back to no-decision, and `doctor` went from FAIL/BROKEN back to
   *     PASS/ACTIVE at exit 0 — a MORE damaged tree reported and behaved HEALTHIER than a less damaged one,
   *     because the check that would have caught the damage was itself the damage.
   *
   * A missing `validate` throws instead, which the process net catches — but it degrades UNATTRIBUTABLY,
   * telling an operator the fault may be in the hook and doctor may show everything ACTIVE, when in fact
   * the file is named and doctor reports it. Both directions are answered here so the message is true.
   *
   * Two members. Not the registry. Anything more here is the second list that drifts.
   */
  const badBootstrap = !contracts || typeof contracts !== 'object' ? 'it exported nothing usable'
    : contracts.CONTRACTS === null || typeof contracts.CONTRACTS !== 'object' || Array.isArray(contracts.CONTRACTS)
      ? `CONTRACTS is ${Array.isArray(contracts.CONTRACTS) ? 'an array' : `a ${contracts.CONTRACTS === null ? 'null' : typeof contracts.CONTRACTS}`}, not the declaration object every lookup indexes`
      : typeof contracts.validate !== 'function'
        ? `validate is a ${typeof contracts.validate}, not the function every check calls`
        : null;
  if (badBootstrap) {
    degrade(`the contract source _contracts.js loaded but is unusable — ${badBootstrap}. `
      + 'No shared module can be validated against it, so none of them can be trusted');
  }

  let mod;
  try {
    mod = require(abs);
  } catch (e) {
    degrade(`the shared module ${base} could not be loaded — ${nameOf(e)}: ${firstLine(e)}`);
  }

  /*
   * ⛔ THE WHOLE DECLARED CONTRACT, NOT THE MEMBERS THIS HOOK HAPPENS TO NAME. A module that does not
   * satisfy its declaration is not a module any consumer can reason about — and asking each hook to
   * list what it uses would put a second, drifting contract list in fifteen more places. It is also
   * exactly what doctor checks, so the report and the runtime cannot reach different verdicts.
   *
   * ⛔ AND EVERY SHARED MODULE THAT CAME WITH IT. A hook asks for `_runtime.js`; `_runtime.js` requires
   * `_artifact.js` with a bare require of its own. Validating only what was ASKED FOR would leave
   * `_artifact.REJECTED` — a Set whose `.has()` is called on the goal-contract path — completely
   * unchecked at runtime while doctor reported it BROKEN. The require cache is the exact, non-guessed
   * answer to "what did loading this actually bring in": no regex walk, no second dependency model.
   */
  for (const [file, detail] of loadedContractViolations(contracts)) {
    degrade(`the shared module ${file} loaded but does NOT satisfy its declared contract: ${detail}. `
      + 'A module whose API is not what its consumers rely on cannot be used to make a decision');
  }
  return mod;
}

/** Every contract-declared module currently loaded from this directory that fails its declaration. */
function loadedContractViolations(contracts) {
  const out = [];
  for (const loaded of Object.keys(require.cache)) {
    if (path.dirname(loaded) !== __dirname) continue;
    const base = path.basename(loaded);
    const contract = contracts.CONTRACTS[base];
    if (!contract) continue;
    const bad = contracts.validate(require.cache[loaded].exports, contract);
    if (bad.length) out.push([base, bad.join('; ')]);
  }
  return out;
}

module.exports = { arm, need, observed, degrade, POSTURES };

/*
 * RespawnPack pack tooling — NOT installed into any target (see the placement-inventory note at the
 * bottom). The ONE list of source trees and individually-read source files that install.js reads
 * UNGUARDED (no existsSync guard before the read). install/upgrade.js's preflight and install.js's
 * own preflight both require this module; neither declares its own copy.
 *
 * ⛔ THE FAILURE THIS PREVENTS. upgrade.js used to declare this list itself, typed out a second time,
 * independent of what install.js actually reads. It went stale for as long as it existed: `kernel/`
 * and `core/` were both absent. Reproduced twice on a disposable target, from a pack source torn the
 * way a shallow clone, a sparse checkout or a bad merge tears one:
 *   • one file missing from kernel/lib/ → preflight PASSED → phase 1 (uninstall --for-upgrade)
 *     stripped the target's kernel/core files, phase 2 (install.js) died on ENOENT trying to re-lay
 *     them, and the target went from 12 kernel libs + 13 core files to 3 and 0 — a kernel that would
 *     not start;
 *   • the whole core/ tree missing      → preflight PASSED → the same sequence took the target's 13
 *     core files to 0.
 * Both times the closing message said the script was "safe to repeat" — true only from an intact
 * source, which is exactly what the operator did not have.
 *
 * ⛔ WHY ONE LIST WITH TWO CONSUMERS BEATS TWO LISTS THAT AGREE TODAY. A second hand-written copy that
 * matches this one today is not a guarantee — it is a coincidence with no mechanism holding it true
 * tomorrow. dpkg (/var/lib/dpkg/info/*.list), rpm (%files in its own DB) and Homebrew
 * (INSTALL_RECEIPT.json) all keep exactly one record of what a package places; none of them
 * hand-maintains a second list for the uninstaller to check against. install.js and upgrade.js are
 * same-repo, same-commit, same-release-train, with no deployment boundary that would justify two —
 * Fowler's consumer-driven-contracts objection to a single generated source (that it recouples
 * release cycles deliberately kept independent) does not apply here. So this module is the single
 * declaration, and there is no second copy left to drift out of step with the first.
 *
 * This does not, by itself, prove the list is COMPLETE against everything install.js reads — nothing
 * here derives that from install.js's own source, so a future unguarded read of a new tree still
 * needs a human to add it here. What it closes is the narrower defect that actually shipped: two
 * hand-written lists silently disagreeing with EACH OTHER. See docs/derived/state/pairs.json P-002.
 *
 * No dependencies (module.exports only).
 */
module.exports = {
  // Top-level trees install.js reads unguarded, plus the sub-trees it names as units — the ops/*
  // skill dirs and memory/knowledge from install.js's skillDirs, templates/ci, and kernel/core's own
  // sub-trees (each placed as a unit). A missing entry here is a tree that can crash an install or
  // upgrade mid-run with no preflight to catch it first. agents/ is deliberately absent: install.js
  // itself treats a missing agents/ as a no-op, and a preflight must never be stricter than the
  // installer it fronts.
  //
  // library/compliance/requirements and library/compliance/references are ALSO deliberately absent,
  // for the identical agents/ reason (P2-T-12): install.js §4c now places library/ only when the
  // target's compliance.config.md declares a non-empty scope, and that conditional read is GUARDED
  // (existsSync — see install.js's libraryComplianceDir check) rather than unguarded, so a torn
  // library/compliance/ degrades to a warning instead of a crash. A tree read unconditionally on
  // every run belongs in this list; a tree read only sometimes, and safely even then, does not.
  SOURCE_TREES: [
    'spine', 'skills', 'memory', 'memory/knowledge', 'hooks', 'workflows', 'templates', 'templates/ci', 'catalog',
    'ops/mcp', 'ops/deploy-verify', 'ops/db-ops', 'ops/secrets-audit', 'ops/infra-status',
    // Host adapters install.js reads unguarded (see its section 3b). The Claude Code interactive
    // profile ships declaration/canary modules; sdk-supervisor (P5-CT-4, decision 2.7) adds the
    // managed-profile process surface beside it, and statusline adds the opt-in context-usage tee.
    // Each dir is named as a unit like skills/. Tree-level, not per-file: a missing adapter file is
    // an unproven capability, not a bricked install, so it does not earn KERNEL_FILES/CORE_FILES-grade
    // per-file preflight (ADAPTER_FILES below IS the per-file list, for placement, not for this gate).
    // A new host adapter that install.js places adds its dir here the same day (pairs.json: the
    // adapter-install obligation, sibling to P-002). NOTE: no apostrophes in this block — the
    // preflight sweep test scans it with a single-quote regex, so a possessive here silently
    // corrupts the parsed tree list.
    'adapters/claude-code/interactive', 'adapters/claude-code/sdk-supervisor', 'adapters/claude-code/statusline',
    // The state kernel and the host-neutral rollover core. Phase 1 deletes both from the target
    // (uninstall.js KERNEL_FILES / CORE_FILES), so a source missing either one strips a working
    // install and cannot restore it. Sub-trees are named because each is placed as a unit.
    'kernel', 'kernel/lib',
    'core', 'core/lifecycle', 'core/policy', 'core/state', 'core/memory',
  ],
  // Individually-read files outside every tree above, which no tree check can vouch for: repo-root
  // ATTRIBUTION.md, and templates/CLAUDE.md (the managed-block source). VERSION and
  // hooks/settings.snippet.json are deliberately NOT here — both need content-level validation
  // (non-empty after trim; valid JSON) one level more specific than the plain readability check
  // this list's callers give SOURCE_FILES, so upgrade.js's preflight keeps checking those two itself.
  SOURCE_FILES: ['ATTRIBUTION.md', 'templates/CLAUDE.md'],

  /*
   * ⛔ THE DIRECTORY-LEVEL GATE ABOVE STILL LEFT A REPRODUCED DESTRUCTION PATH OPEN, AND THIS CLOSES IT.
   *
   * The tree check answers "is `kernel/lib/` there", not "is every file in it there". Verified against
   * the fixed tree gate, not assumed: delete ONE file from `kernel/lib/` in the source, leave the tree
   * itself intact, and the preflight still passes — phase 1 strips the target and phase 2 dies on ENOENT.
   * Measured: 12 kernel libs and 13 core files became 3 and 0. Same outcome as before the tree fix, one
   * granularity down. "Per-file completeness stays install.js's own concern" was a defensible scope
   * boundary for a tree whose loss is recoverable; it is not one for the two trees the target cannot
   * function without and cannot restore from anywhere else.
   *
   * These two are singled out deliberately rather than generalised to every tree. They are the only ones
   * phase 1 deletes whose absence leaves the target with NO working kernel and NO rollover core — a
   * skills or catalog file lost the same way is a missing page, not a bricked install. The lists are
   * SOURCE-relative; install.js places them and uninstall.js removes them, so all three consumers now
   * read one declaration instead of three that agreed by coincidence.
   */
  KERNEL_FILES: [
    'respawnpack.js', 'lib/outcome.js', 'lib/assert.js', 'lib/modhealth.js', 'lib/state.js',
    'lib/render.js', 'lib/gate.js', 'lib/removals.js', 'lib/lineage.js', 'lib/reconcile.js',
    'lib/applicability.js', 'lib/closeout.js', 'lib/memory.js', 'lib/living.js',
    'lib/aar.js', 'lib/readiness.js', 'lib/site.js',
  ].map((f) => `kernel/${f}`),

  CORE_FILES: [
    'index.js', '_io.js',
    'lifecycle/machine.js', 'lifecycle/states.js', 'lifecycle/evidence.js', 'lifecycle/journal.js',
    'lifecycle/cycle.js', 'lifecycle/consumable.js',
    'policy/failures.js', 'policy/capabilities.js', 'policy/thresholds.js', 'policy/routing.js',
    'state/handoff.js', 'memory/candidates.js',
  ].map((f) => `core/${f}`),

  /*
   * ⛔ THE PER-FILE ADAPTER LIST — ONE DECLARATION, THREE CONSUMERS, NOT A LITERAL REPEATED IN EACH.
   *
   * The SOURCE_TREES entries above answer "is the directory there" (preflight); this answers "which
   * files inside it get placed, and where" — the same split KERNEL_FILES/CORE_FILES already draw, and
   * for the same reason: install.js's placement loop, uninstall.js's receipt-contained removal, and
   * doctor's host-adapters LOADS checks all need the identical file set, and a hand-typed copy in each
   * is exactly the class of drift install/_sources.js exists to end (see this file's own header).
   *
   * P5-CT-4 (the rework task list, decision 2.7) extends the wave that shipped `interactive/` alone: the
   * sdk-supervisor process surface and the opt-in statusline tee join it. Deliberately absent —
   * `adapters/claude-code/task-runner/`, out of scope for this wave by the same decision; every
   * `*.test.mjs` file, since the pack's own test suites are never shipped to a target; every adapter
   * README, documentation that stays in the dev checkout the way KERNEL_FILES/CORE_FILES already omit
   * theirs; and `sdk-supervisor/fixtures/**`, captured/synthetic protocol bytes that only that
   * directory's own tests read, never the adapter code a target would run.
   *
   * Paths are relative to this file's own directory (the repo root), matching SOURCE_TREES above and
   * the KERNEL_FILES/CORE_FILES style, so install.js can place each one under `.claude/<path>` directly.
   */
  ADAPTER_FILES: [
    'interactive/profile.js', 'interactive/probe.js',
    'sdk-supervisor/cli.js', 'sdk-supervisor/capabilities.js', 'sdk-supervisor/measure.js',
    'sdk-supervisor/stream.js', 'sdk-supervisor/supervisor.js', 'sdk-supervisor/canary.js',
    'statusline/statusline.js',
  ].map((f) => `adapters/claude-code/${f}`),
};

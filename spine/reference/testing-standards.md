# Testing standards

How RespawnPack writes and judges tests. The through-line: **a test is a claim about behavior that can't drift silently** — it extends [coding-standards](coding-standards.md) rule 8 ("tests are executable intent") into a discipline. Tests exist to catch the change that breaks a promise, not to decorate a diff with green checkmarks.

`/build` writes to this standard on new logic; `/review` checks coverage against it; `/playtest` proves bugs dead with it.

## 1. Test first where the logic earns it
For non-trivial new logic — branching, arithmetic, parsing, state transitions, anything with an edge you had to think about — write the failing test before the implementation. Watching it fail is the point: a test you never saw red proves nothing about its own ability to catch the bug. Trivial glue (a passthrough, a rename, wiring) is exempt — ceremony scales with blast radius, same as everywhere else in this pack. When in doubt, ask: *"if this breaks in six months, what tells me?"* If the answer is "a user," write the test now.

## 2. A bug isn't fixed until a test fails without the fix
The regression contract (`/playtest` runs on it): reproduce the bug as a test, watch it fail on the broken code, watch it pass on the fix. A fix landed without its failing-first test is a fix that can silently un-land. Name the test after the bug's *behavior*, not its ticket: `rejects expired tokens even when clock skewed` outlives `fixes #482`.

## 3. Test behavior, not implementation
A test coupled to internals (call order, private state, exact query text) breaks on every refactor and passes on real bugs — the worst of both. Assert on what a caller can observe: outputs, state transitions, emitted effects. The refactor test: **a pure refactor should never turn a test red.** If yours does, the test was pinning mechanics, not behavior.

## 4. Mock at boundaries you don't own; prefer real things you do
Mock the network, the clock, the third-party API — boundaries that are slow, flaky, or paid. Don't mock your own modules to each other: a test where every collaborator is fake verifies your mocks agree with themselves (a tautology), not that the code works. If wiring real collaborators is too painful to test, that's a design signal (see coding-standards on module shape), not a reason for deeper mocking.

## 5. Assert something that can fail
A test with no meaningful assertion — or one asserting the mock returned what the mock was told to return — is a tautology: green by construction. Each test states one claim sharp enough that a plausible bug would break it. If you can't say which bug a test would catch, delete it; it's maintenance cost with no coverage.

## 6. Size tests like a pyramid, not an hourglass
Many fast unit tests on the logic; some integration tests on the seams (the DB really queried, the route really wired); few end-to-end flows for the promises users feel (`/walkthrough` covers the rendered ones). Inverting this — everything through the browser, nothing on the logic — makes the suite slow, flaky, and vague about *what* broke. Slice coverage vertically by behavior ("checkout applies the discount"), not horizontally by layer ("test all getters"). RespawnPack itself runs two suite tiers through `ops/suite-counts.mjs`: `--tier fast` for iterating on a task, `--tier full` as the mandatory release gate at every phase boundary.

## 7. Deterministic or deleted
A test that flakes trains everyone to re-run until green — at which point the suite catches nothing, because red stopped meaning broken. The usual culprits, with their fixes:
- **Time**: inject the clock; never assert "now."
- **Async**: poll for the actual condition with a deadline; never `sleep(n)` and hope. A fixed sleep is both too long (slow suite) and too short (flaky under load) — always, eventually, both.
- **Order**: each test builds and tears down its own state; a test that passes alone and fails in the suite has a pollution bug worth finding, not skipping.
- **Randomness**: seed it.

## 8. Readable over DRY
In test code, plain repetition beats clever indirection: a reader should see setup → action → assertion in one screen without chasing helpers. Extract a helper when duplication hides the *claim*; keep the duplication when the helper would. Test names are documentation — `describe`/name them so a failure message alone says what promise broke.

## 9. Safety checks have stricter proof obligations

A checker, installer, scanner, validator, freshness reader, or release gate can manufacture confidence, so these rules are mandatory:

1. **Zero work cannot pass.** `PASS` with an explicit count requires `checked > 0` after every filter, exclusion, size cap, symlink decision, and read. Empty work is `CANNOT_DETERMINE`.
2. **One verdict authority.** The returned outcome must equal the rollup of the checks callers consume. Never reconstruct a second verdict beside them.
3. **Skipped uncertainty is non-passing.** An unreadable file, unverified symlink, oversized input, unsupported format, or scanner limit prevents PASS. An explicit project-owned exclusion may be neutral, but it is still reported.
4. **No name-only inferred exclusions.** Names such as `build`, `dist`, `vendor`, `target`, `out`, `tmp`, `research`, and cache directories can hold authored content. Suggest them; do not exclude them from existence alone.
5. **Containment follows the filesystem.** Resolve configured authority, input, and output paths with `realpath`; for a missing output, resolve its nearest existing ancestor before creating it. Lexical `path.relative` checks do not stop symlink escapes.
6. **Freshness follows configuration.** If an input path is overridable, digest the active configured input. Test that editing a custom path makes the projection stale.
7. **Suppression scopes to the disputed claim.** A retirement marker about one subject cannot hide a live assertion about another subject in the same sentence. An attached historical clause also cannot hide a resumed live predicate (`X, which was removed, is enabled`).
8. **Schema and runtime are bidirectional.** Runtime-accepted documents validate against the declared schema, and schema-valid documents have defined runtime behavior.
9. **Configuration states remain distinct.** Absent, empty, malformed, unsupported, partial, and not-applicable are classified by key presence and type, never truthiness.
10. **Matching bytes are not ownership.** Rewriting founder-owned content requires provenance or explicit migration authorization. Otherwise preview the proposed change.
11. **Messages read effective state.** Rerun and upgrade summaries inspect the active config and active custom paths instead of repeating fresh-install defaults.
12. **Current evidence remains in scope.** An accepted ADR cited by a contract cannot be excluded wholesale as history.
13. **Push scope comes from Git's ref protocol.** Inspect every ref named on pre-push stdin, including non-HEAD refs, merge commits, and each intermediate commit (an endpoint diff can hide a secret added then deleted), relative to the target remote. Ignored durable artifacts remain omissions; truncated or failed range/status queries fail closed.
14. **"Nobody decided" is a state, and it is neither of the other two.** An optional contract is CONFIGURED, declared NOT_APPLICABLE with an authored reason, or UNDECIDED — and a fourth, INVALID, for an answer that was attempted and cannot be used (a blank opt-out, a leftover installer template, a malformed block). UNDECIDED is not a pass and not a failure; it blocks release readiness and is resolved only by a person answering. Report *why the check could not run* separately from *whether the machinery works*, so an unfinished setup does not read as a broken one — and keep the process exit at the worse of the two, because separating the report is the fix and separating the exit code is the same manufactured green one indirection out.
15. **A template is not a value.** A seeded placeholder (`<set X>`) that a reader consumes as configuration produces a check that matches nothing and therefore agrees with everything. Installers write no key rather than a placeholder value; readers classify an existing placeholder as INVALID with its remedy, never as data.

⛔ **A rule on this list and a rule with a test behind it are typographically identical, and that is the
open defect.** Audited 2026-08-12 against this pack's own suites: **14 of these rules are mechanized**
(a fence catches a fresh violation anywhere), **1 is instance-only** (rule 6 — freshness follows
configuration; only the one already-fixed path is covered), and **1 is unenforced** (rule 12 — current
evidence remains in scope). Coverage is far better than the list looks; what is missing is that nothing
*says* which test enforces which rule, so a reader cannot tell a rule that runs from one that hopes.
Rules 14 and 15 were added to this section and violated within the hour by the change that added them.
Until each rule carries its own `enforced-by`, treat this list as claims to verify rather than
guarantees to rely on — tracked as `P-021` in `docs/derived/state/pairs.json`, with the per-rule audit.

For every defect, prove three states: **the original defect fails, the corrected case passes, and the nearest bypass fails**. Bypass controls include empty post-filter corpora, null/malformed values, unrelated retirement vocabulary, conjunctions, wrapping, headings, quotations, and symlinks.

## The one-line test
Before keeping a test, ask: **"Which bug would make this fail?"** If you can't name one, it isn't a test — it's a rehearsal of the code agreeing with itself.

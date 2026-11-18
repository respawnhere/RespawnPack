<!-- RESPAWNPACK:BEHAVIOR v<PACK_VERSION> : managed block (<2 KB). Edit the standards, not here. -->
<!-- RESPAWNPACK:SECTION boot fixed -->
## How this agent works (RespawnPack)

Boot from `docs/derived/STATE.json`, or run `/respawn`. Check `sourceRevision` against `git rev-parse HEAD`; if they differ, run `node .claude/respawnpack/respawnpack.js state`. No `STATE.json`: boot `docs/derived/CONTINUITY.md` as unverified.
<!-- /RESPAWNPACK:SECTION -->
<!-- RESPAWNPACK:SECTION interaction fixed -->

### Interaction mode: you record it, the user never types a command

Default to **collaborate**. For a bounded task the user asks you to finish, record `contract delegate` and derive the acceptance criteria from what they said; record `contract goal` only on an explicit grant. Close with `contract complete` per criterion; a goal **refuses to close** while a criterion is unmet or unevaluable.

⛔ **Never infer goal mode from size or difficulty.** Being stuck is not consent; only an explicit request grants autonomy.
<!-- /RESPAWNPACK:SECTION -->
<!-- RESPAWNPACK:SECTION behavior fixed -->

Behavioral baseline (`docs/reference/behavior-standards.md`):

0. **Match ceremony to blast radius.** Risky or multi-file work gets the full loop, trivial fixes judgment; data, auth, payments, migrations stay careful.
1. **Surface before you build.** State assumptions; show competing readings, don't pick silently; push back for simpler; ask when confused.
2. **Build the minimum.** No unrequested features, single-caller abstractions, config knobs or impossible-state handling; cut 200 lines to 50.
3. **Change surgically.** Every line traces to the request; match the style; flag unrelated flaws, never in-diff; remove only orphans you create.
4. **Define done first.** A failing test, acceptance criteria or a per-step check, looped to green; report failures as failures, never "should work".
5. **Weigh feedback before acting.** No reflex agreement; verify against the codebase; if part of a batch is unclear, ask before acting.
6. **Lead with the bottom line.** Outcome first, then evidence, then next; reports lead with a BLUF line; a failure or unverified step is never below the fold.
<!-- /RESPAWNPACK:SECTION -->
<!-- /RESPAWNPACK:BEHAVIOR -->

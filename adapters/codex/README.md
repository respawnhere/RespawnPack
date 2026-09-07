# RespawnPack · Codex adapter — interactive hooks profile (W3a)

This is the Codex **hooks** profile of RespawnPack's v0.3 in-place rollover: hook scripts that speak
Codex's documented hook contract, a project-local packaging layout, activation/trust canaries, and a
capability declaration — all built on `core/` (host-neutral) and consuming nothing else. It does not build
or depend on the Codex **app-server** managed profile (`adapters/codex/app-server/` is reserved for that,
a separate later task — see that directory's own README).

The shared vocabulary (context cycle, in-place rollover, the four-outcome/four-support vocabularies)
comes from the multi-host rollover design, a development record whose product-facing summary is
`docs/vision/ARCHITECTURE.md`; this adapter builds on it without re-explaining it.

## What's here

```
adapters/codex/
  hooks/
    _shared.js                  internal helpers only — not a hook, never registered
    respawnpack-precompact.js   PreCompact: write+verify a handoff, or veto
    respawnpack-sessionstart.js SessionStart: rehydrate on source=="compact"; canary touch otherwise
    respawnpack-postcompact.js  PostCompact: observational corroboration only, no decisions
    respawnpack-stop.js         Stop: a settle marker for a future supervisor's safe-boundary logic
    respawnpack-canary.js       fires on any wired event; THE activation evidence
  hooks.json.template           best-effort registration payload, JSON form
  config.toml.snippet           best-effort registration payload, TOML [hooks] form
  skills/respawn-rollover/      SKILL.md — the manual /compact procedure, for the open agent skills standard
  profile.js                    capability declaration for 'codex-interactive-hooks'
  codex-hooks.test.mjs          the test suite for all of the above
  app-server/                   RESERVED for W3b — see its own README
```

## Install by hand (installer integration is deferred — see "What the installer wave must add")

1. Pick a registration file: `~/.codex/hooks.json` (user-wide) or `<repo>/.codex/hooks.json`
   (project-scoped) — or the TOML equivalents, `~/.codex/config.toml` / `<repo>/.codex/config.toml`.
2. Copy the entries from `hooks.json.template` or `config.toml.snippet` into it, replacing every
   `{{RESPAWNPACK_CODEX_HOOKS_DIR}}` with the **absolute** path to this adapter's `hooks/` directory. If
   using the JSON template, strip its `_comment_*` keys first — they document the template and are not
   hook registrations.
3. Confirm `features.hooks` is enabled (the TOML snippet sets it; the JSON path needs it set separately —
   Codex hooks are gated on this flag project- or user-wide, per the R4 documentation verification).
4. **Start (or resume) a Codex session in the target project, and run `/hooks`.** Approve the RespawnPack
   entries you want trusted. This step cannot be skipped or scripted — see "The trust model" below.
5. Verify activation: after any trusted hook fires (a Stop at the end of a turn is the easiest to trigger
   deliberately), confirm `.respawnpack/runtime/rollover/_codex-hooks-canary.json` exists and its `at` is
   recent. That file, not steps 1–4 having been performed, is the actual proof this is live.
6. Optional but recommended: copy `skills/respawn-rollover/` into `.agents/skills/respawn-rollover/`
   (discovered at `$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, or `$HOME/.agents/skills` per the
   open agent skills standard) so the agent knows the savepoint-note step exists before it ever needs it.

## The trust model, and why a canary is the only proof

Codex hooks are gated on **two** independent things this pack cannot fully observe from outside:
`features.hooks` (a feature flag) and a **per-hook** interactive trust decision made with `/hooks` inside
a live session. There is no scriptable "list my currently-trusted hooks" command. So:

- **Installed files are never claimed as activation.** Every capability in `profile.js` that depends on a
  hook actually running requires an activation canary (`core.policy.capabilities`'s own
  `REQUIRES_CANARY` rule) — a marker written by a hook that fired, not a file that merely exists on disk.
- **The canary proves a hook fired and was trusted.** It does not prove which specific hooks are trusted
  (trust is per-hook; a Stop canary firing says nothing about whether PreCompact is also trusted), and it
  does not prove Codex's model actually *read* whatever a hook injected — see `profile.js`'s
  `injectHandoff` limitations for that second gap specifically.
- **Freshness is checked, not just presence.** A canary from months ago in an abandoned experiment is not
  "currently active" just because the file exists — `profile.js`'s `CANARY_FRESHNESS_MS` (30 days,
  documented and changeable there) draws that line explicitly rather than leaving it implicit.
- **Installed-but-untrusted reads as `CANNOT_DETERMINE`, never as inactive-but-safe-to-assume-fine and
  never as active.** This is deliberate: an operator who has done steps 1–3 above but not step 4 should
  see an honest "unknown", not a false green light nor a false failure.

## What is verified vs. what is templated

R4's documentation verification plus a live app-server probe (in a scratch directory at probe time)
established, and this adapter trusts without re-deriving:

- the hook event names (`PreCompact`, `PostCompact`, `SessionStart`, `Stop`, and the rest of the eleven),
- `PreCompact`/`PostCompact`'s `manual|auto` trigger matcher,
- `SessionStart`'s `source` values (`startup|resume|clear|compact`) and that `source:"compact"` runs
  *before* the next model request and may carry `additionalContext`,
- that `PostCompact` is observational only (no `additionalContext`),
- that the `PreCompact` veto shape is `{continue:false, ...reason}`,
- registration file locations, and the two-part `features.hooks` + per-hook trust gate,
- that `thread.id == sessionId` was observed equal in one live app-server session (recorded, not treated
  as a hooks-layer guarantee — see "The hooks-vs-app-server id caveat" below).

**Not independently verified in this task**, and clearly marked wherever it appears:

- the exact JSON/TOML **key names** for a hook registration entry (`hooks.json.template` and
  `config.toml.snippet` both carry loud disclaimers — they model the same command-array convention
  Claude Code's own hooks.json uses, since the two hosts share the documented event vocabulary, but that
  is a reasoned guess, not a confirmed schema dump),
- the exact JSON envelope `respawnpack-sessionstart.js` uses to return `additionalContext`
  (`{hookSpecificOutput:{hookEventName,additionalContext}}`, mirroring Claude Code's documented shape —
  again a reasoned guess for Codex specifically),
- whether Codex's hook runtime tolerates unrecognized output fields or rejects them outright the way
  Claude Code's PreCompact hook was observed to (see `hooks/precompact-ledger-nudge.js`'s own header for
  that history) — which is exactly why every hook in this adapter emits **nothing** on stdout unless the
  ONE concretely-verified output shape applies (the PreCompact veto), rather than guessing at an
  operator-facing field on the success path too.

## The hooks-vs-app-server id caveat

The W3-probe observed `thread.id == sessionId` (the same value) in one live app-server `thread/start`
call, and that the thread id stayed stable across a compaction in that same session. Whether a **hook's**
`session_id` field is interchangeable with the app-server's `thread.id`/`sessionId` is `CANNOT_DETERMINE`
from documentation alone — recorded here, never asserted as fact. This matters concretely: when W3b's
app-server supervisor and this hooks profile are both active in the same project, they only share state
correctly (via `core.machine.conversationDir`, keyed on `host` + `conversationId`) if the id one profile
observes is the SAME string the other profile observes for the same real conversation. Confirming that (or
building an explicit reconciliation if it is not true) is W3b's work, not assumed here.

## What the canary marker proves, concretely, and what it cannot

`.respawnpack/runtime/rollover/_codex-hooks-canary.json` proves: at least one hook this adapter registers,
somewhere in this project, was trusted and fired, at the recorded `at` timestamp, and here is the exact
raw payload it received (`raw`, bounded to 64KiB with a truncation flag past that, the same discipline as
`core/lifecycle/evidence.js`'s own `withBoundedRaw`). It does **not** prove every hook is trusted (trust is
per-hook), does not prove the rollover protocol as a whole works end to end, and does not prove any
particular compaction was actually rescued — for that, look at whether
`.respawnpack/runtime/rollover/codex-<sid>/<handoffId>.consumed.json` exists for the conversation in
question.

## Two layers of value, and why only one of them is live today

`respawnpack-sessionstart.js` does two things on `source==="compact"`: it consumes the verified handoff
via `core.handoff.consume()` (exactly-once, independent of any state-machine transition — this is what
actually rehydrates context today), and it *attempts* the shared core rollover state machine's own
`observe-completion` / `verify-identity` transitions. The second attempt is honest, forward-compatible
plumbing that will almost always come back `REFUSED` under a hooks-only install, because nothing at this
layer can supply the `CONTEXT_MEASUREMENT` evidence the machine's `checkpoint` transition requires to ever
leave `ACTIVE` (no Codex hook payload field documents usage or context-window numbers — see `profile.js`,
`measureContext: NOT_SUPPORTED`). That refusal is surfaced to the operator/agent, never hidden. See
`respawnpack-sessionstart.js`'s own header for the full reasoning, and `adapters/codex/app-server/README.
md` for why this stops being "almost always refused" the moment W3b shares the same on-disk journal.

## What W3b (the app-server supervisor) should pick up

- The live-probe facts recorded at probe time (`app-server-summary.json`,
  `app-server-summary2-interrupt.json`, `app-server-raw.log`, and the JSON-RPC method/param schema dump
  under `schema/`) — not re-derived here, since this task's scope was the hooks profile only.
- The `thread.id == sessionId` observation above, and the reconciliation work it implies.
- `core/lifecycle/evidence.js`'s `codex_context_compaction` signal (already declared, `provisionalShape:
  true`, unused by this hooks-only adapter) is the one W3b should feed from `item/started` →
  `item/completed` on a `contextCompaction` item.
- Once an app-server-driven session shares this profile's on-disk journal (same `host`/`conversationId`
  pair) and drives it through `checkpoint` → `request-compact`, `respawnpack-sessionstart.js`'s existing
  `observe-completion`/`verify-identity` attempts start succeeding with **no code change on this side** —
  worth confirming with a real integration test once W3b exists, not assumed here.

## What the installer wave must add

Not built here — deferred per this task's scope — but the paths and merge points it needs are:

- **Copy** `adapters/codex/hooks/` to an installed location (or reference it in place — undecided; either
  way, `{{RESPAWNPACK_CODEX_HOOKS_DIR}}` in both templates must resolve to wherever the five hook scripts
  actually end up, since each hook resolves `core/` relative to its OWN `__dirname` three levels up).
- **Merge**, not overwrite, into `~/.codex/hooks.json` / `<repo>/.codex/hooks.json` (or the TOML
  equivalents) — a target may already have other hooks registered on the same events, and Codex's
  per-event value is (per this template's own best-effort model) an ARRAY hooks are appended to, not a
  single slot RespawnPack can claim exclusively.
- **Do not silently enable `features.hooks`** without telling the operator — it is a scope-widening change
  to what Codex will run, and this adapter's own trust-model section above treats loud disclosure as a
  first-class requirement, not a nice-to-have.
- **Package `skills/respawn-rollover/`** into `.agents/skills/respawn-rollover/` at whichever of the three
  discovery roots (`$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`) matches how
  the rest of RespawnPack installs project- vs. user-scoped content.
- **An uninstall path** that removes RespawnPack's specific entries from a shared hooks.json/config.toml
  without touching entries it did not add — the same non-destructive-merge discipline as the install side,
  in reverse.
- **A `doctor`-style check**, mirroring the Claude adapter's own, that reads
  `_codex-hooks-canary.json` and reports the same present/usable/fresh verdict `profile.js.readCanary`
  computes, so an operator does not have to inspect the file by hand to answer "is this actually working."

## Known limitations (today, honestly)

- No context measurement at this layer (`measureContext: NOT_SUPPORTED`) — this profile cannot proactively
  decide "checkpoint now," only react once a compaction is already underway.
- No programmatic compact request (`requestCompact: NOT_SUPPORTED`) — the operator runs `/compact`
  manually; see `skills/respawn-rollover/SKILL.md`.
- No SessionStart-time git baseline capture yet, so a written handoff's `git.sessionDelta` is honestly
  `CANNOT_DETERMINE` rather than an approximated since-session delta (head + uncommitted-files-at-
  compaction ARE captured; only the since-baseline delta is not, unlike the Claude adapter's
  `hooks/_runtime.js` equivalent). A future wave could add this without changing the handoff schema.
  Note the credit for the pattern this WOULD extend, not import: `hooks/precompact-ledger-nudge.js` and
  `hooks/session-routing-nudge.js`'s baseline-capture/session-delta approach, re-derived rather than
  imported per this task's "no dependency on hooks/*" constraint.
- The pending savepoint note (`_codex-pending-note.json`) is project-scoped, not conversation-scoped —
  documented as a known limitation in the skill itself, not silently accepted.
- The exact hook registration schema and the `additionalContext` output envelope are both best-effort,
  clearly marked, and unverified against a live trusted Codex install — see "What is verified vs. what is
  templated" above.

---
name: respawn-rollover
description: Procedure for a verified in-place rollover across a manual Codex /compact — write a savepoint note, run /compact yourself (RespawnPack cannot trigger it), then read the rehydrated handoff SessionStart(source=compact) injects. Use before running /compact, or when told context is getting full, or when asked to checkpoint, save progress, or prepare to compact.
---

# Respawn rollover (Codex, manual /compact)

RespawnPack's Codex hooks can save your state and hand it back to you across a compaction, but they
**cannot make Codex compact itself** — no documented Codex hook or config surface exposes a way to call
`/compact` programmatically from a hook. That step is yours. This skill is the three-step procedure:
write a savepoint note, run `/compact` yourself, then trust what comes back.

If you skip step 1 and just run `/compact`, nothing breaks — `respawnpack-precompact.js` still writes and
verifies a handoff — but it will carry no exact next action, because nothing told it one. Step 1 is what
makes the rehydrated context worth reading instead of an empty shell.

## Step 1 — write the savepoint note, before you run /compact

Using your normal file-write tool (no shell needed), create this file — create the parent directories if
they do not exist:

```
<repository root>/.respawnpack/runtime/rollover/_codex-pending-note.json
```

with this shape (every field optional; omit what you have nothing to say):

```json
{
  "exactNextAction": "the single next concrete step, specific enough to start from cold",
  "atomicActionId": "a short id for the task in flight, if you have one",
  "userConstraints": ["constraint the user stated this session, verbatim or close to it"],
  "unresolvedQuestions": ["anything you have not verified and should not be assumed answered"],
  "candidateMemories": ["ids only — never inline the claim text; see the note below"],
  "verificationEvidence": ["what you actually verified this session, as short factual notes"]
}
```

⛔ **`exactNextAction` is a next STEP, not a status report.** "continue the refactor" tells the rehydrated
session nothing it didn't already know; "rename `parseInput` to `parseHookInput` in
`adapters/codex/hooks/_shared.js` and update its three call sites" tells it exactly what to do first.

⛔ **`candidateMemories` holds IDs, never claim text.** RespawnPack's handoff schema (`core/state/
handoff.js`) deliberately carries only ids here — inlining the actual unverified claim would deliver it
into the next cycle looking exactly like an established fact next to it. If you have nothing with a real
id yet, leave this empty; do not invent one to fill the field.

⛔ **`verificationEvidence` is this session's own self-report, not host-checked proof.** It flows unchanged
into every handoff `respawnpack-precompact.js` writes (a missing note, or a non-array value here, leaves it
`[]`), but it is not one of the typed, host-corroborated evidence records that gate RespawnPack's own core
rollover state machine, and nothing screens its entries against the pack's forbidden-proof-token list.
Apply the same discipline anyway: a timeout, an elapsed delay, or "it exited cleanly" is not verification,
only what you actually confirmed is. It is also not yet echoed into the rehydrated message Step 3
describes; a later cycle can read it only by opening the handoff JSON file directly.

This file is consumed (read, then deleted) by the PreCompact hook the moment it successfully writes and
verifies a handoff — so it is safe to write it right before `/compact` and nowhere else; an older note
left over from a previous compaction is never silently reused.

**Known limitation:** this note is project-scoped, not conversation-scoped. If more than one Codex session
is active in the same project at once, the note may be picked up by whichever one compacts first. Do not
rely on it in that situation — say the next action out loud in your own message instead.

## Step 2 — run /compact yourself

RespawnPack does not, and cannot, do this for you. Tell the user you are about to compact if it matters to
them, then run `/compact`. If a `PreCompact` hook veto appears instead of compaction proceeding — a
message beginning "RespawnPack: VETOING compaction" — **do not retry blindly and do not set the escape
hatch without reading why.** It means your savepoint note (or the handoff RespawnPack tried to build
around it) could not be written and read back verified; the reason is in the veto text, and it is
specific. Fix that, then run `/compact` again. The escape hatch
(`RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1`, set before invoking Codex) exists for operators who have decided
the risk is acceptable — it is not something a skill should invoke on your own judgment mid-session.

## Step 3 — trust the rehydration, verify before you rely on the rest

If the PreCompact hook is trusted and fired, and `SessionStart(source=compact)` is trusted and fires next,
the context you see after compaction will open with a block starting `RespawnPack: rehydrated handoff
<id>`. That block carries: your exact next action, the atomic-action id, the git HEAD and uncommitted
files as of the moment before compaction, your stated constraints, and your unresolved questions — but
**not** a verified statement that this is the same conversation unless it explicitly says "Same
conversation confirmed". If it instead says the identity could not be cross-checked, or reports a
mismatch, treat continuity as unverified and re-establish context normally before proceeding.

If that block does not appear at all after a compaction you know happened: the SessionStart hook may not
be trusted yet (run `/hooks` and check), or `features.hooks` may not be enabled in this project's Codex
config, or the PreCompact hook was never trusted either (in which case no handoff exists to rehydrate in
the first place). None of this is silently fixed for you — see adapters/codex/README.md for the trust
model in full, and never assume RespawnPack's rollover is active just because these files are installed.

## What this skill is not

This is not a request to be more careful with context in general, and it is not a substitute for actually
finishing an atomic operation before compacting. If you are mid-edit with an inconsistent tree, finish or
cleanly stop first — a savepoint note describing an inconsistent state is still an inconsistent state on
the other side of the compaction.

<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/DECISIONS.md · a GENERATED, verified index over docs/decisions/ (one file per decision). Edit the NOTE block; author decisions as files under docs/decisions/. -->
# Decisions & Removals

> ⚙️ **GENERATED index of `docs/decisions/`.** One row per decision file; a ⛔ row is a removal
> (negative knowledge: do not reintroduce it). Every count below is recounted from the shard on
> each run and verified back against it. Hand-edits inside the generated block are overwritten and
> flagged. Author a decision as a new file under `docs/decisions/`, and write prose in the NOTE
> block instead (it survives).

<!-- RESPAWNPACK:NOTE — hand-written, preserved across regeneration -->
**CANONICAL: the decision log.** This file is a GENERATED index over `docs/decisions/`: one file per
decision, named `D-NNN-<slug>.md`. A decision (or a **removal**) is authored as a NEW file; the index
below is re-rendered and verified from those files at every `/savepoint`, so a hand edit inside the
generated block is overwritten and flagged. Write prose here in this NOTE block (it survives), not in the
generated block.

**Shard file shape** (frontmatter, then the entry body):
```
---
id: D-001
date: 2026-01-01
status: accepted
title: "<one line>"
removal: false
supersedes: ""
supersededBy: ""
---
### D-001 — <title> · 2026-01-01 · accepted
- Decision: <one line>
- Rationale: <why>
- Affects: <features / pages / files>
```

**Status vocab:** `accepted` · `proposed` · `deprecated` (no longer the way, kept for history) ·
`superseded` (replaced; name the replacement in `supersededBy`).

**Removals are first-class. Split, never delete.** When you kill a feature, add a decision file with
`removal: true` and a `⛔ Removal:` line stating what must NOT return. The index marks it ⛔; a row in
`docs/derived/state/removals.json` (optionally carrying `decision: D-NNN`) is what mechanically enforces
it. Already have a monolith `DECISIONS.md`? Split it once with `respawnpack migrate decisions --write`.
<!-- /RESPAWNPACK:NOTE -->

_Generated at install time._

<!-- RESPAWNPACK:GENERATED — do not hand-edit below this line -->

**0 decision entries · 0 removal entries (⛔).**

_Nothing under `docs/decisions/` yet. Author one as `docs/decisions/D-001-<slug>.md`, or split an existing `docs/DECISIONS.md` monolith with `respawnpack migrate decisions --write`._

<!-- /RESPAWNPACK:GENERATED -->

# Living skills: frozen baseline + adaptive overlay

How RespawnPack's **own** skills improve from lessons learned without losing a known-good fallback. The same anti-drift triad as the docs spine (WRITE-ONCE canonical + derived overlay + drift-check), applied to skills. **Reference doctrine: installs to `docs/reference/living-skills.md`.**

> ## ⛔ What actually ships, before the doctrine
>
> The lifecycle below is **implemented and behavior-tested for three canaries** — `debug`, `savepoint`
> and `knowledge` — and it is **opt-in per project**. A default install activates nothing.
>
> Every other RespawnPack skill is a **STATIC skill**. That is a complete, supported state, not a
> second-class one: a static skill is the authored skill, and nothing about it is missing.
>
> This page previously said *every* owned skill had two forms. It did not: the tree carried nine
> `SKILL.base.md` files, **zero** `.skill-meta.json`, and no code that generated an overlay, detected
> drift, or reset one. The doctrine was complete and the machinery was absent. Run
> `respawnpack living status` for the answer in **your** project, and `respawnpack doctor` for the
> one-line version.
>
> Expanding past the three canaries is a decision someone makes after dogfood shows adaptation actually
> improves a skill — never a side effect of a glob matching more files.

## The problem
A skill that never adapts goes stale; a skill that freely rewrites itself eventually drifts, contradicts its own rules, or breaks, with no way back. So a **living** RespawnPack skill has two forms: a **frozen baseline** you can always fall back to, and a **living form** that accrues lessons.

## The two-tier layout
```
<skill>/
  SKILL.base.md     CANONICAL · frozen · lockdown-protected · WRITE-ONCE. The known-good constitution.
  SKILL.md          LIVING · what the agent loads · == base + a "## Learned (living)" overlay.
  .skill-meta.json  { schemaVersion, skill, baseHash, enabledAt, lastReset, overlayBudgetLines, source }
                    (written by `living enable`; `schemaVersion` is REQUIRED — a meta missing it is
                     reported CANNOT_DETERMINE, never a clean bill of health)
```

- **`SKILL.base.md` is canonical.** Authored deliberately, edited only to change the skill's *intent*. Like a spine canonical doc, it is the one authored home for the skill's rules. The `lockdown` hook **can** protect it, but does not by default: `lockdown` is inert unless a founder arms it by listing path prefixes in `.respawnpack/lockdown.allow`, and it knows nothing about skills specifically. What actually detects a changed baseline is `living status`, which compares `sha256(SKILL.base.md)` against the hash recorded at enable time and FAILs on any difference.
- **`SKILL.md` is the living form** the agent actually runs. It starts identical to the base and carries a single appended section:
  ```
  ## Learned (living)
  <!-- regenerated from memory entities keyed `applies-to|skill:<name>`; do not hand-edit -->
  - [2026-06-22 · conf:high] <lesson, with a memory ref> …
  ```
  The overlay **references** the base body, never restates it. It is **regenerated** (like a derived doc), not hand-edited.

  ⛔ **From the markdown, not from the engine.** `kernel/lib/living.js` reads `memory/graph/**.md` directly — the markdown *is* the source of truth by the memory engine's own design, and reading it keeps the lifecycle working with the zero-setup default backend instead of putting an optional component on the critical path. A project whose lessons exist only inside an MCP-served index, with no `memory/graph/` tree, gets **CANNOT_DETERMINE** from `regenerate` — "we found nothing" and "we could not look" must not render the same overlay.

## How lessons flow in
`/debug` Step 5 and `/knowledge` capture a lesson as a `memory/graph/` entity whose frontmatter declares `relations: applies-to|skill:<name>`. That relation is the whole key: a line with no traceable entity cannot appear on an overlay. The living overlay is regenerated from those keyed lessons: curated, deduped, and **budgeted** (an overlay-line cap in `.skill-meta.json`). High-confidence, repeatedly-confirmed lessons promote; one-off or low-confidence ones stay in memory but off the overlay.

## The guard: `respawnpack living status`
The executable check. `kernel/lib/living.js` compares `SKILL.md` against `SKILL.base.md` and reports:
- the base **changed** since enable (hash mismatch) — the base is WRITE-ONCE canonical,
- the living form **no longer contains its base verbatim** (hand-edited outside the overlay),
- the overlay **exceeds its budget**,
- an **upgrade replaced the living form** — the pre-upgrade text is archived as `SKILL.superseded.md` and reported until you regenerate or reset,
- the metadata is missing or malformed → **CANNOT_DETERMINE**, never a pass.

⚠️ **Two flags this document used to promise are NOT implemented.** There is no invariant detection (no `<!-- invariant -->` marker is read anywhere in the kernel) and no smoke check. Do not rely on either. And `status` runs for the three canaries only — the nine skills that ship a `SKILL.base.md` on disk today are all non-canaries, so those baselines have no executable drift check at all.

It **flags, never silently fixes**, same as the spine drift-check.

## The fallback: `/skill-reset`
`/skill-reset <skill>` restores `SKILL.md` from `SKILL.base.md` and archives the overlay. The source lessons stay in the memory engine, so nothing is lost: the next regeneration can re-propose them, minus whatever caused the drift. This is the path for when the living form drifted too far or broke and you fall back to baseline.

## Scope: our skills only
This applies **only to RespawnPack-owned skills**: the `create-custom` skills and the thin RespawnPack overlay half of a `wrap-thin`.

**Vendor/developer-maintained skills are never touched.** Cloudflare's, Vercel's, Supabase's, Context7's, and Anthropic's skills are owned upstream and updated by their developers. RespawnPack does not fork, mutate, or wrap their internals. What we learn about *using* them is recorded as **lessons in the memory engine keyed to that vendor skill**, surfaced alongside it at use time. Lessons-learned alone are their adaptive layer; the vendor file stays pristine.

## Invariants
1. **`SKILL.base.md` is WRITE-ONCE canonical.** Change it to change intent, not to record a lesson.
2. **Never hand-edit the `## Learned (living)` overlay.** It is regenerated from memory (it's derived).
3. **Never mutate a vendor skill.** Its adaptive layer is a memory reference, not an edit.
4. **A reset is always available.** The baseline is the guaranteed-good floor.

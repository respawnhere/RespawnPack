<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/ARCHITECTURE-ROADMAP.md -->
# Architecture & Roadmap

**CANONICAL.** The system as it runs **today** (Part 1, present tense) and the forward plan / horizons (Part 2, future tense). Two parts, one doc — the roadmap is only legible against the current shape.

Owns the **map**. Does not re-argue the locked calls behind it ([`DECISIONS.md`](DECISIONS.md), by `D-id`) nor restate what a feature *is* ([`PRODUCT.md`](PRODUCT.md)) or where it lives ([`FEATURES-PAGES.md`](FEATURES-PAGES.md)). **Code wins** over prose; this is the altitude view.

---

# PART 1 — CURRENT ARCHITECTURE (present tense)

## At one altitude
```
<a simple box diagram of the live system: client → edge → app/api → data/cache/storage/media>
```
> 📝 One short subsection per plane (web/edge · api · auth · data · realtime · media · async · ops). State the *current* truth; reference the locked decision behind each by `D-id`. Flag any doc-vs-code drift inline.

## <Plane> — <one-line current state> (D-<nnn>)
<the live shape, key constraints, and what's latent vs active>

---

# PART 2 — ROADMAP (future tense)

> 📝 Summarize phases at a readable altitude; reference a task-level plan for detail rather than pasting tasks.

## The launch / scale shape
<the target shape + the headline strategy (big-bang vs incremental, scale targets)>

## Phases
- **Phase 0 — <name>:** <what + status>
- **Phase 1 — <name>:** <…>

## Deferred / out of scope
<what's intentionally not on the path, with the D-id or reason>

---
## References
Decisions: [`DECISIONS.md`](DECISIONS.md) · Features↔routes: [`FEATURES-PAGES.md`](FEATURES-PAGES.md) · Inventory: [`PRODUCT.md`](PRODUCT.md)

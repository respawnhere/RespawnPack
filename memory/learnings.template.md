# Learnings ledger (template)

Lighter than the graph: append-on-resolution lessons that tune *how the agent works* (patterns, pitfalls, preferences, operational quirks). One row per learning. Auto-load the top few at the start of relevant skills; capture a new one before finishing whenever something cost real time.

> 📝 Backend-agnostic: keep this as a markdown table, or store rows as graph observations. Either way, honor **confidence** + **source**.

## Fields
- **id** — short slug.
- **kind** — `pattern` (do this) · `pitfall` (avoid this) · `preference` (the human's choice) · `operational` (a quirk of the stack/tooling).
- **learning** — one line.
- **confidence** — 1–10.
- **source** — `stated` (the human said so — durable, trustworthy, cross-project) · `observed` (seen happen) · `inferred` (the agent's guess).
- **date** — when captured.

## Confidence decay + trust-gating (the discipline)
- `observed` / `inferred` confidence **decays** over time (e.g. −1 per 30 days) — stale AI guesses should fade, not calcify into fact.
- `stated` does not decay (the human said it).
- **Cross-project recall is allowlisted to `stated` rows only** — never let an `inferred` lesson from one repo silently steer another (defends against AI-learning drift / profile-poisoning).

## Ledger
| id | kind | learning | confidence | source | date |
|---|---|---|---|---|---|
| <slug> | pitfall | <one line> | 8 | stated | <date> |

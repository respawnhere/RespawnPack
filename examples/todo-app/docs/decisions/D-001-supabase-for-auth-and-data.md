---
id: D-001
date: 2026-04-02
status: accepted
title: "Supabase for auth and data"
removal: false
supersedes: ""
supersededBy: ""
---

### D-001 — Supabase for auth and data · 2026-04-02 · accepted
- Decision: use Supabase (Postgres + Auth) as the backend for TodoApp instead of a hand-rolled Express API.
- Rationale: a two-person team building nights and weekends; managed Postgres plus row-level security covers auth and data access without owning infrastructure.
- Affects: all data-backed features, `respawnpack.config.json` opsTargets.db.

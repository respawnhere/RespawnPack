# Decisions & Removals (append-only)

**CANONICAL.** The one place a decision — or a **removal** — is recorded. Append-only: never reorder, never delete an entry; supersede it with a new one. This is the project's **negative-knowledge channel**: the reason a killed feature must **not** be reintroduced lives here, so generators/agents stop resurrecting dead work.

**Status vocab:** `accepted` · `proposed` · `deprecated` (no longer the way, kept for history) · `superseded` (replaced — points to the replacement).

---

### D-001 — Supabase for auth and data · 2026-04-02 · accepted
- Decision: use Supabase (Postgres + Auth) as the backend for TodoApp instead of a hand-rolled Express API.
- Rationale: a two-person team building nights and weekends; managed Postgres plus row-level security covers auth and data access without owning infrastructure.
- Affects: all data-backed features, `respawnpack.config.json` opsTargets.db.

### D-002 — Google OAuth added alongside email/password · 2026-05-10 · accepted
- Decision: add Google OAuth sign-in as a second auth path; keep email/password as the default.
- Rationale: onboarding drop-off in the first beta cohort traced to password friction; OAuth removes a step for the majority of testers who already have a Google account.
- Affects: `/login`, `/signup`, PRODUCT.md §1.

### D-003 — AI task suggestions retired · 2026-06-18 · accepted · ⛔ removal
- Decision: remove the AI task-suggestion feature (a sidebar panel that proposed next todos based on completed ones) rather than continue tuning it.
- Rationale: beta usage data showed under 4% of active users ever opened the panel, and of those who did, most dismissed the suggestion without acting on it. The feature also required storing a rolling window of completed-todo text for the ranking model, which expanded the data-retention surface for a feature nobody used.
- Affects: PRODUCT.md §3 (flipped to ⛔ killed), the now-removed suggestion panel component.
- ⛔ Removal: AI task suggestions must not be reintroduced without a new decision entry here. If revisited, it needs a clear adoption thesis and a data-minimization plan for the completed-todo window it would read from, not just a UI resurrection.

### D-004 — Shared lists over folders · 2026-06-25 · accepted
- Decision: the next multi-todo-list feature is shared/collaborative lists (invite another user to a list), not personal folders/categories.
- Rationale: the most common support request in the beta was "can I share a list with my partner," not "can I organize my own todos into folders." Building folders first would be solving a problem nobody asked for.
- Affects: PRODUCT.md §2 (shared lists, 📋 deferred), FEATURES-PAGES.md §5 (future build-gap once scoped).

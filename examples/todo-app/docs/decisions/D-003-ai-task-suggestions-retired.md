---
id: D-003
date: 2026-06-18
status: accepted
title: "AI task suggestions retired"
removal: true
supersedes: ""
supersededBy: ""
---

### D-003 — AI task suggestions retired · 2026-06-18 · accepted · ⛔ removal
- Decision: remove the AI task-suggestion feature (a sidebar panel that proposed next todos based on completed ones) rather than continue tuning it.
- Rationale: beta usage data showed under 4% of active users ever opened the panel, and of those who did, most dismissed the suggestion without acting on it. The feature also required storing a rolling window of completed-todo text for the ranking model, which expanded the data-retention surface for a feature nobody used.
- Affects: PRODUCT.md §3 (flipped to ⛔ killed), the now-removed suggestion panel component.
- ⛔ Removal: AI task suggestions must not be reintroduced without a new decision entry here. If revisited, it needs a clear adoption thesis and a data-minimization plan for the completed-todo window it would read from, not just a UI resurrection.

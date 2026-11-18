---
id: D-002
date: 2026-05-10
status: accepted
title: "Google OAuth added alongside email/password"
removal: false
supersedes: ""
supersededBy: ""
---

### D-002 — Google OAuth added alongside email/password · 2026-05-10 · accepted
- Decision: add Google OAuth sign-in as a second auth path; keep email/password as the default.
- Rationale: onboarding drop-off in the first beta cohort traced to password friction; OAuth removes a step for the majority of testers who already have a Google account.
- Affects: `/login`, `/signup`, PRODUCT.md §1.

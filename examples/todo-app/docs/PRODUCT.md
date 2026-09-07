# Product — the feature inventory

**CANONICAL.** The single governed list of **what TodoApp is made of and what state each feature is in** — so generation, review, and any "is X a thing?" question resolve here first.

**WRITE-ONCE — what this file does NOT own:**
- **Page/route mapping, flows, navigation** → [`FEATURES-PAGES.md`](FEATURES-PAGES.md). This says *what a feature is + its status*; that says *where it lives*.
- **Rationale / why a killed thing must not return** → [`DECISIONS.md`](DECISIONS.md), referenced by `D-id`.
- **Tokens, copy, component values** → code. Docs mirror code; never hard-code a contradicting value.

**Status legend:** ✅ live · 🔒 built-but-held (code exists, gated off) · 📋 deferred (planned, not built) · ⛔ killed (removed; link the `D-id`) · 🧩 build-gap (designed, has a FEATURES-PAGES row, not built).

---

## 1. Auth / accounts
| Feature | Status | Notes |
|---|---|---|
| Email + password sign-up | ✅ | Supabase Auth, email confirmation required before first login |
| Google OAuth sign-in | ✅ | Supabase Auth provider, added after sign-up shipped |
| Account deletion | 🧩 | Designed, no route yet; see FEATURES-PAGES §5 |

## 2. Todo core loop
| Feature | Status | Notes |
|---|---|---|
| Create / edit / complete / delete a todo | ✅ | One list per user, no folders yet |
| Due dates + reminders | ✅ | Reminder email sent via a Supabase Edge Function cron |
| Shared lists (invite a collaborator) | 📋 | In progress; schema drafted, no UI yet, targeted for the next milestone |

## 3. AI features
| Feature | Status | Notes |
|---|---|---|
| AI task suggestions | ⛔ | D-003, killed after the private beta; see DECISIONS.md |

**Product rules (constraints, not features — authored here so build/gen don't drift):**
- A free-tier account is capped at 200 open (incomplete) todos; the create action rejects past that cap with a plain-language upgrade prompt.
- Reminder emails never fire more than once per todo per day, regardless of how many times its due date is edited.

---

## 4. Held / deferred — what is intentionally absent
Generators and reviewers: **a screen missing one of these is correct, not a bug.** Do not "fill in" these gaps.

**Built-but-held (🔒):** none currently; TodoApp has no flag-gated code in this example.
**Deferred (📋):** shared lists (see §2), Phase 2.
**Build-gaps (🧩):** account deletion (see §1) → see [`FEATURES-PAGES.md`](FEATURES-PAGES.md) §build-gaps.

---

## 5. Killed features (negative knowledge)
Each is a pointer to its [`DECISIONS.md`](DECISIONS.md) removal — **do not reintroduce.** Rationale lives there; this only keeps dead features visible so generation/review don't resurrect them.

| Killed feature | Status | Decision |
|---|---|---|
| AI task suggestions | ⛔ | D-003, low adoption in beta, and it kept guessing wrong priorities; cut rather than tuned |

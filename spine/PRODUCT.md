<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/PRODUCT.md · fill the inventory; keep the status legend + sections. -->
# Product — the feature inventory

**CANONICAL.** The single governed list of **what <PROJECT> is made of and what state each feature is in** — so generation, review, and any "is X a thing?" question resolve here first.

**WRITE-ONCE — what this file does NOT own:**
- **Page/route mapping, flows, navigation** → [`FEATURES-PAGES.md`](FEATURES-PAGES.md). This says *what a feature is + its status*; that says *where it lives*.
- **Rationale / why a killed thing must not return** → [`DECISIONS.md`](DECISIONS.md), referenced by `D-id`.
- **Tokens, copy, component values** → code. Docs mirror code; never hard-code a contradicting value.

**Status legend:** ✅ live · 🔒 built-but-held (code exists, gated off) · 📋 deferred (planned, not built) · ⛔ killed (removed; link the `D-id`) · 🧩 build-gap (designed, has a FEATURES-PAGES row, not built).

> 📝 **Fill:** one section per product domain; one row per meaningful feature; a one-line note + a status tag. Keep it to features, not pages (those live in FEATURES-PAGES) and not rationale (that lives in DECISIONS).

---

## 1. <Domain — e.g. Core loop>
| Feature | Status | Notes |
|---|---|---|
| <feature> | ✅ | <one line> |
| <feature> | 🔒 | <gated behind …> |

## 2. <Domain>
| Feature | Status | Notes |
|---|---|---|
| <feature> | 📋 | <Phase 2 …> |

<!-- add domains: auth/accounts · social · content · payments/monetization · notifications · moderation · admin · etc. -->

**Product rules (constraints, not features — authored here so build/gen don't drift):**
- <e.g. limits, windows, caps, invariants that downstream code/generation must honor>

---

## N. Held / deferred — what is intentionally absent
Generators and reviewers: **a screen missing one of these is correct, not a bug.** Do not "fill in" these gaps.

**Built-but-held (🔒):** <features whose code exists but are deliberately not promoted / flag-gated — name the flag>.
**Deferred (📋):** <planned, not built — Phase 2+>.
**Build-gaps (🧩):** <designed, has a FEATURES-PAGES row, not built> → see [`FEATURES-PAGES.md`](FEATURES-PAGES.md) §build-gaps.

---

## N+1. Killed features (negative knowledge)
Each is a pointer to its [`DECISIONS.md`](DECISIONS.md) removal — **do not reintroduce.** Rationale lives there; this only keeps dead features visible so generation/review don't resurrect them.

| Killed feature | Status | Decision |
|---|---|---|
| <feature> | ⛔ | D-<nnn> — <one-line why> |

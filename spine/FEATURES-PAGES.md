<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/FEATURES-PAGES.md · this is the signature doc — read the contract (§last) before filling. -->
# Features ↔ Pages ↔ Flows ↔ Navigation (the matrix)

**CANONICAL.** The single governed map of every feature, the page/route it lives on, the flows it belongs to, and the app's navigation. This file is **both** the input to mockup/code generation **and** the verification checklist — a generation prompt for a page is built *from* that page's row + the [reverse index](#3-feature--page-reverse-index), so a feature **cannot be silently dropped**.

- **Generated/validated against the route source** `<ROUTE_SOURCE>` — see the [validation contract](#6-generation--validation-contract).
  > 📝 **Fill `<ROUTE_SOURCE>`** with how routes are discovered in this repo: e.g. `app/**/page.tsx` (Next App Router), `pages/**` (Next Pages), `src/routes/**`, a router config file, or an OpenAPI/route manifest.
- **Last validated:** <date> against <N> routes. **Status legend:** ✅ live · 🔒 built-but-held · 🧩 build-gap (designed, not built) · 📋 planned.

---

## 1. Navigation model (the shell)
> 📝 The thing the AI most often loses. Capture the nav surfaces explicitly.
- **Top bar / header:** <items>
- **Primary nav (sidebar / tabs):** <items, with active-state behavior>
- **Mobile nav:** <how it collapses>
- **Focused / chromeless modes:** <routes that hide the shell>

---

## 2. Route × feature matrix
> 📝 One row per real route from `<ROUTE_SOURCE>`. Group by area (public / auth / app / admin / embed …).

### <Area — e.g. App (authed)>
| Route | Source file | Features on this page | Status |
|---|---|---|---|
| `<path>` | `<file>` | <the features that live here> | ✅ |
| `<path>` | `<file>` | <features> | 🔒 |

<!-- repeat per area -->

---

## 3. Feature → page reverse index
> 📝 The anti-drop guarantee: a mockup/build of a page must include **every** feature listed against it here. List cross-cutting features and every place they appear.

| Feature | Appears on |
|---|---|
| <e.g. tipping / search / share / a cross-cutting action> | `<route>` · `<route>` · `<route>` |

---

## 4. Key user flows
> 📝 The signature sequences, step → route.
1. **<flow name>:** `<route>` → `<route>` → `<route>`.

---

## 5. Build-gaps (designed, not built — 🧩)
> 📝 Features that have a designed place here but no code yet. Schema-touching ones flagged.

| Gap | Where it should land | Note |
|---|---|---|
| <gap> | `<route/component>` | <e.g. needs a schema column> |

---

## 6. Generation & validation contract
This is what keeps the matrix true (and alive) rather than drifting:

1. **Every route has a row.** `/savepoint` enumerates `<ROUTE_SOURCE>` and diffs the route set against §2. A route with no row, or a row with no route, is **drift** and is flagged.
2. **Mockups/generation are built FROM this file** — a screen prompt is assembled from the route's §2 row + every feature the §3 reverse index lists for it. A prompt that omits a listed feature fails review. *(This is the anti-silent-drop mechanism.)*
3. **Status reconciles with code.** A 🔒 built-but-held route that is actually live in code is a doc-vs-code conflict — resolve it in `PRODUCT.md` + `DECISIONS.md`, don't paper over it.
4. **Feature truth lives in `PRODUCT.md`; page truth lives here; rationale lives in `DECISIONS.md`.** This file maps them together; it doesn't redefine what a feature is or why it exists/was removed.

# Features ↔ Pages ↔ Flows ↔ Navigation (the matrix)

**CANONICAL.** The single governed map of every feature, the page/route it lives on, the flows it belongs to, and the app's navigation. This file is **both** the input to mockup/code generation **and** the verification checklist — a generation prompt for a page is built *from* that page's row + the [reverse index](#3-feature--page-reverse-index), so a feature **cannot be silently dropped**.

- **Generated/validated against the route source** `app/**/page.tsx` (Next.js App Router) — see the [validation contract](#6-generation--validation-contract).
- **Last validated:** 2026-06-30 against 7 routes. **Status legend:** ✅ live · 🔒 built-but-held · 🧩 build-gap (designed, not built) · 📋 planned.

---

## 1. Navigation model (the shell)
- **Top bar / header:** logo, "New todo" button, account menu (settings, sign out).
- **Primary nav (sidebar / tabs):** My todos, Shared with me (hidden until §2's shared-lists gap ships), Settings.
- **Mobile nav:** sidebar collapses into a bottom tab bar (My todos, Settings).
- **Focused / chromeless modes:** `/login`, `/signup` hide the shell entirely.

---

## 2. Route × feature matrix

### Public (unauthenticated)
| Route | Source file | Features on this page | Status |
|---|---|---|---|
| `/login` | `app/login/page.tsx` | Email + password sign-in, Google OAuth sign-in | ✅ |
| `/signup` | `app/signup/page.tsx` | Email + password sign-up | ✅ |

### App (authed)
| Route | Source file | Features on this page | Status |
|---|---|---|---|
| `/todos` | `app/todos/page.tsx` | Create / edit / complete / delete a todo, Due dates + reminders | ✅ |
| `/todos/[id]` | `app/todos/[id]/page.tsx` | Edit a todo, Due dates + reminders | ✅ |
| `/settings` | `app/settings/page.tsx` | Account menu access | ✅ |

<!-- repeat per area -->

---

## 3. Feature → page reverse index

| Feature | Appears on |
|---|---|
| Due dates + reminders | `/todos` · `/todos/[id]` |
| Google OAuth sign-in | `/login` |

---

## 4. Key user flows
1. **Sign up and create the first todo:** `/signup` → `/todos` → `/todos/[id]`.
2. **Sign in with Google:** `/login` → `/todos`.

---

## 5. Build-gaps (designed, not built — 🧩)
| Gap | Where it should land | Note |
|---|---|---|
| Account deletion | `/settings` | Needs a Supabase Edge Function to cascade-delete todos before removing the auth user |

---

## 6. Generation & validation contract
This is what keeps the matrix true (and alive) rather than drifting:

1. **Every route has a row.** `/savepoint` enumerates `app/**/page.tsx` and diffs the route set against §2. A route with no row, or a row with no route, is **drift** and is flagged.
2. **Mockups/generation are built FROM this file** — a screen prompt is assembled from the route's §2 row + every feature the §3 reverse index lists for it. A prompt that omits a listed feature fails review. *(This is the anti-silent-drop mechanism.)*
3. **Status reconciles with code.** A 🔒 built-but-held route that is actually live in code is a doc-vs-code conflict — resolve it in `PRODUCT.md` + `DECISIONS.md`, don't paper over it.
4. **Feature truth lives in `PRODUCT.md`; page truth lives here; rationale lives in `DECISIONS.md`.** This file maps them together; it doesn't redefine what a feature is or why it exists/was removed.

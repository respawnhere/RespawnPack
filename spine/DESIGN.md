<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/DESIGN.md -->
# Design System (canonical)

**CANONICAL.** Brand, theme, tokens, components, and the polish bar — one human-readable reference. **Code wins on conflict:** `<TOKEN_SOURCE>` (tokens), `<COPY_SOURCE>` (copy), `<COMPONENT_SOURCE>` (components) are authoritative; this doc mirrors them.

> 📝 **Fill the `<…_SOURCE>`** with the real code paths (e.g. `packages/shared/tokens`, `strings/en.ts`, `packages/ui/`). Use the §A/§B split only if you have an approved-but-not-yet-built design direction.

## North star (the bar)
<the feel/quality bar this product holds itself to — 1–2 lines + the acceptance criteria>

## §A — CURRENT (shipped)
- **Brand:** <name, mark, logo rules>
- **Voice & tone:** <rules; banned words; empty/error-state style> — copy from `<COPY_SOURCE>`
- **Color:** <core + accent + semantic tokens, mirrored from `<TOKEN_SOURCE>`>
- **Type / spacing / motion:** <scales + tokens>
- **Components:** <the component library + where it lives>
- **The polish bar (acceptance):** <the N checks a surface must pass to ship>
- **Token rules (lint where noted):** <no hardcoded values outside tokens; etc.>

## §B — APPROVED TARGET (if any — not yet in code)
<the approved-but-unbuilt direction + the deltas to apply during translation; link the record + the DECISIONS D-ids>

---
*Code wins. When code (`<TOKEN_SOURCE>`/`<COPY_SOURCE>`/`<COMPONENT_SOURCE>`) and this doc disagree, fix the doc.*

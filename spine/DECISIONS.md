<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/DECISIONS.md · append-only — never reorder/delete an entry. -->
# Decisions & Removals (append-only)

**CANONICAL.** The one place a decision — or a **removal** — is recorded. Append-only: never reorder, never delete an entry; supersede it with a new one. This is the project's **negative-knowledge channel**: the reason a killed feature must **not** be reintroduced lives here, so generators/agents stop resurrecting dead work.

**Status vocab:** `accepted` · `proposed` · `deprecated` (no longer the way, kept for history) · `superseded` (replaced — points to the replacement).

**Entry schema:**
```
### D-NNN — <title>   ·   <date>   ·   <status>
- Decision: <one line>
- Rationale: <why>
- Supersedes / Superseded-by: <D-xxx or —>
- Affects: <features / pages / files>
- ⛔ Removal: <what this kills + why it must NOT return>   (removal entries only)
```

> 📝 **How to use:** every direction-setting choice gets a numbered entry. When you kill a feature/option, write a removal entry (status `deprecated`/`superseded`, `⛔ Removal:` line) AND flip the feature's `PRODUCT.md` status to ⛔ killed, linking this `D-id`. `/savepoint`'s drift-check greps removals to catch resurrection.

---

### D-001 — <first decision> · <date> · accepted
- Decision: <one line>
- Rationale: <why>
- Affects: <…>

<!-- Example removal entry:
### D-00X — <thing> retired · <date> · accepted · ⛔ removal
- Decision: <the new way>
- ⛔ Removal: <old thing> is retired because <why>. Do not reintroduce.
-->

<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/compliance/README.md · the compliance-adherence index. -->
# <PROJECT> — compliance adherence

The living artifacts that keep compliance **true over time**, not just audited once. `/comply` reads and maintains them; the loop keeps them from drifting. The detailed per-requirement checklists and source texts live separately in [`library/compliance/`](../../library/compliance/) — these are the **state**, those are the **reference**.

| Artifact | Class | What it records | Maintained by |
|---|---|---|---|
| [`compliance.config.md`](../../compliance.config.md) *(repo root)* | declaration | which regimes apply, and why (the triage answer) | `/loadout` on new data flows; reviewed quarterly |
| [`REGISTER.md`](REGISTER.md) | canonical | posture per framework + per primitive; accepted risks; audit history | `/comply` per audit |
| [`RoPA.md`](RoPA.md) | canonical | Records of Processing (GDPR Art. 30) — what data, why, where, retention | `/loadout` on new processing |
| [`breach-runbook.md`](breach-runbook.md) | reference | detect → assess → notify, with the per-regime clocks | when a procedure/clock changes |
| [`dpa-baa-checklist.md`](dpa-baa-checklist.md) | reference | the right vendor contract (DPA/BAA/addendum) before data flows | per new sub-processor |

## How it fits the loop
- **`/loadout`** classifies data at plan time → proposes `compliance.config.md` + `RoPA.md` deltas (compliance designed in, not bolted on).
- **`/review`** runs the compliance lens on data-touching diffs.
- **`/comply`** audits the applicable frameworks against the [9 unified primitives](../reference/compliance-requirements.md), records posture in `REGISTER.md`, and proposes `DECISIONS.md` entries for accepted risks.
- **`/ship`** gates sensitive-data releases on the `/comply` result.
- **`/savepoint`** flags a new data flow that changes the regime or lacks a RoPA row.

**Reference, not legal advice** — these record your posture and procedures; a lawyer/DPO owns the determinations they point to.

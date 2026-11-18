<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/compliance/REGISTER.md · CANONICAL — hand-maintained at the moment posture changes. -->
# <PROJECT> — compliance register

**CANONICAL.** The single record of compliance **posture** — for each framework that applies (per [`compliance.config.md`](../../compliance.config.md)), where you stand, when it was last checked, and where the evidence and any accepted risks live. `/comply` updates a row each time it audits a framework; `/savepoint` flags when a new data flow changes which frameworks apply. Keep it current at decision time — a stale register drifts silently and is worse than none.

**Reference, not legal advice.** "Compliant" here means "our controls satisfy the requirements as we read them" — not a legal certification.

**Status vocab:** `compliant` (all requirements met, evidence on file) · `partial` (material gaps open — see the gap link) · `gap` (not yet implemented) · `accepted-risk` (won't-fix with a recorded rationale → `DECISIONS.md`) · `n/a` (out of scope per `compliance.config.md`).

## Posture

| Framework | Applies? | Status | Last audited | Owner | Evidence / gaps / decision |
|---|---|---|---|---|---|
| GDPR | <y/n> | <status> | <date> | <name> | <link: /secure+/comply output, RoPA, D-id> |
| UK GDPR + DPA 2018 | <y/n> | | | | |
| ePrivacy / PECR | <y/n> | | | | |
| CCPA / CPRA | <y/n> | | | | |
| US state privacy | <y/n> | | | | |
| HIPAA | <y/n> | | | | |
| GLBA | <y/n> | | | | |
| COPPA | <y/n> | | | | |
| PCI-DSS | <y/n> | | | | |
| SOC 2 | <y/n> | | | | |
| ISO 27001 | <y/n> | | | | |
| NIST CSF 2.0 | <y/n> | | | | |
| NIST Privacy Framework | <y/n> | | | | |
| PIPEDA | <y/n> | | | | |
| Quebec Law 25 | <y/n> | | | | |
| SOX | <y/n> | | | | |
| NIST 800-53 / 800-171 | <y/n> | | | | |
| NIS2 | <y/n> | | | | |
| DORA | <y/n> | | | | |
| EU AI Act | <y/n> | | | | |
| Cyber Resilience Act | <y/n> | | | | |

> Trim rows for frameworks marked `n/a` in `compliance.config.md`, or leave them with `n/a` + the reason. Don't delete a framework that *became* out of scope — set `n/a` and link the decision, so the history survives (same negative-knowledge principle as `DECISIONS.md` removals).

## Primitive coverage
The 9 unified primitives, built once and mapped to many frameworks. Track each once here rather than per-law.

| Primitive | Status | Where it's implemented (file / managed service) |
|---|---|---|
| 1. Encryption (TLS 1.2+, AES-256 at rest, key mgmt) | <status> | <…> |
| 2. DSAR engine (access/delete/correct/export) | | |
| 3. Consent + preference store (+ GPC) | | |
| 4. Data inventory + sensitive-field tagging | | <→ RoPA> |
| 5. Access control (RLS/RBAC/MFA/least-privilege) | | |
| 6. Immutable audit logging | | |
| 7. Retention + deletion jobs | | |
| 8. Incident-response + breach pipeline | | <→ breach-runbook> |
| 9. Vendor/sub-processor register (BAA/DPA) | | <→ dpa-baa-checklist> |

## Accepted risks
Won't-fix gaps, recorded so the call is deliberate and survives. Each must also have a `DECISIONS.md` entry.

| Date | Framework / requirement | Risk accepted | Rationale | Owner | `DECISIONS.md` |
|---|---|---|---|---|---|
| <date> | <e.g. GDPR Art. 30 RoPA> | <what's not done> | <why it's acceptable now> | <name> | <D-NNN> |

## Audit history
| Date | Scope | By | Outcome (link) |
|---|---|---|---|
| <date> | <frameworks audited> | `/comply` | <summary / report> |

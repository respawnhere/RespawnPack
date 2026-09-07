---
name: comply
description: The compliance role — triages which regulatory frameworks apply, by data type, jurisdiction, and sector, then audits the product against the matching per-requirement checklists. Reports gaps ranked by risk with citation and remediation. Reference, not legal advice.
when_to_use: "comply", "/comply", "compliance", "/compliance", "gdpr", "/gdpr", "hipaa", "/hipaa", "ccpa", "pci", "soc2", "am I compliant", "privacy compliance", "data protection", "is this gdpr compliant", "compliance audit", "dsar", "consent", "data subject rights"
---

# /comply — compliance audit (framework-grounded)

<!-- The 3-level path is authored for the INSTALLED layout (.claude/skills/comply/ -> target root); it intentionally does not resolve in the pack source tree. Do not "fix" it to 2 levels. -->
Audits the product against the regulations and standards that actually apply to it, using the detailed per-requirement checklists in [`library/compliance/requirements/`](../../../library/compliance/requirements/) and the source texts in [`library/compliance/references/`](../../../library/compliance/references/). Like `/secure`, it adversarially verifies before reporting, and never invents an obligation — every finding cites a specific article / section / control. **Reference, not legal advice.**

## Step 0 — Triage the applicable regime
Decide what applies before auditing anything (read `compliance.config.md` if present; otherwise infer and confirm, then write it so the next run inherits the triage):
- **What data** does the product handle? PII · PHI (health) · cardholder data · children's data · financial NPI → the data classes in scope.
- **Whose data / which jurisdictions?** EU/UK residents → GDPR / UK GDPR / ePrivacy; US state residents → CCPA + state laws; Canadians → PIPEDA (+ Quebec Law 25).
- **Which sector triggers?** health-for-a-provider → HIPAA; financial/money-movement → GLBA; children <13 → COPPA; card payments → PCI-DSS; enterprise/EU sales → SOC 2 / ISO 27001; AI features → EU AI Act; installable artifact → Cyber Resilience Act.
- **Output:** the list of applicable frameworks. Confirm with the human before proceeding (see the triage table in `docs/reference/compliance-requirements.md`).
- **If `library/compliance/requirements/` isn't installed:** the installer places it (and `docs/compliance/`) only once `compliance.config.md` section 4 ("Applicable frameworks") names a real scope — a fresh install with no triage yet done places neither, saving ~471 KB + ~20 KB it would otherwise never read. Fill in section 4's "Default scope" / "Conditional/sector" bullets with the frameworks this triage found, then re-run `node install/install.js` (or `install/upgrade.js` on an existing install) to place both trees. Until that re-run, audit straight from the pack checkout — the identical files live at `library/compliance/requirements/<framework>.md` and `library/compliance/references/` there.

## Step 1 — Map the regulated-data flow
Find where each regulated data class enters, is stored, logged, transmitted, and who can access it — DB, backups, caches, analytics, error trackers, LLM prompts, and every sub-processor. This map is the input to every framework check and the basis for breach-scope analysis. Cross-reference `docs/ARCHITECTURE-ROADMAP.md` for trust boundaries and `respawnpack.config.json` `opsTargets` for the managed services in play. Use `docs/compliance/RoPA.md` as the data-flow map where it exists; otherwise the map you build here seeds it.

## Step 2 — Work the checklists, grouped by the unified primitive
For each applicable framework, open its `library/compliance/requirements/<framework>.md`. The checklists are cross-mapped to the **9 unified primitives** — audit by primitive so one finding maps to many frameworks instead of re-checking per law:
1. Encryption · 2. DSAR engine · 3. Consent / preference store · 4. Data inventory + tagging · 5. Access control (RLS / RBAC / MFA) · 6. Audit logging · 7. Retention / deletion · 8. Incident-response / breach · 9. Vendor / sub-processor register (BAA / DPA).

For each requirement, judge: present / partial / absent, with file:line or the managed-service evidence.

## Step 3 — Adversarially verify
For each gap, run a skeptic pass (default "actually compliant, or not in scope" unless the evidence holds). Drop or downgrade what doesn't survive; force any finding you can't verify to low confidence. A compliance report that cries wolf gets ignored.

## Step 4 — Report (+ propose fixes)
Rank surviving gaps by **risk × likelihood**. Each gets: the framework + cited article/section/control, the gap, the concrete remediation (mapped to its primitive), and the breach/penalty exposure. State what's covered. For an **accepted risk** (won't-fix, with rationale), propose a `DECISIONS.md` entry + an `accepted-risk` row in `docs/compliance/REGISTER.md` so the call is recorded, not lost. **Record per-framework posture in the register each run** — that is the state a later audit re-reads. The highest-leverage managed-infra check: confirm each provider offers the needed **BAA (PHI) / DPA (PII)** before regulated data flows to it, working `docs/compliance/dpa-baa-checklist.md`.

## Invariants
- **Reference, not legal advice** — cite the source; flag where a lawyer/DPO is needed (DPIA sign-off, BAA terms, cross-border transfers, automated-decision review).
- **Triage-gated** — audit only the frameworks that actually apply; don't impose HIPAA/PCI on a product that handles neither.
- **Verify before reporting** — every finding cites a specific requirement and survives the skeptic pass.
- **Build once, map to many** — group by the unified primitive; one control (encryption, a DSAR endpoint, an audit log) satisfies many frameworks at once.
- **Adherence persists, not just reports** — posture lands in `docs/compliance/REGISTER.md`, the data map in `docs/compliance/RoPA.md`, vendor contracts in `docs/compliance/dpa-baa-checklist.md`; an incident follows `docs/compliance/breach-runbook.md`. These are what a re-audit reads, so a regime doesn't silently drift.
- Cross-cutting: `/loadout` designs compliance in (data classification + lawful basis up front, proposing `compliance.config.md` + RoPA deltas), `/review` runs the compliance lens on data-touching changes, `/ship` gates sensitive-data releases, `/savepoint` flags a new data flow that changes the regime.

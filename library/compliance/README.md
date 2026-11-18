# Compliance: requirements & references

RespawnPack's compliance layer: detailed, per-requirement checklists for the frameworks a product on managed infra is most likely to hit, plus the authoritative source documents.

- **[`requirements/`](requirements/)**: one file per framework, enumerating **every** requirement (article / section / control) mapped to a concrete dev/data action, the unified primitive it satisfies, and a citation. Worked through by the `/comply` skill.
- **[`references/`](references/)**: the official regulatory/standards texts, downloaded where redistributable (see [`references/SOURCES.md`](references/SOURCES.md) for citations + licenses). Copyrighted standards (ISO 27001, PCI-DSS, SOC 2) are linked there, not vendored.
- **Adherence artifacts**: the living *state* `/comply` maintains (distinct from these reference checklists), installed to `docs/compliance/` from `spine/compliance/`: `compliance.config.md` (declared scope, repo root), `REGISTER.md` (posture per framework), `RoPA.md` (Records of Processing), `breach-runbook.md` (notification clocks), `dpa-baa-checklist.md` (vendor contracts).
- High-level overview + the 9 unified primitives: `docs/reference/compliance-requirements.md` once installed (`spine/reference/compliance-requirements.md` in the pack).

## Scope
**21 frameworks**, in two tiers:
- **Default-scope** (almost every data-handling product): GDPR · UK GDPR · ePrivacy/PECR · CCPA/CPRA · US state privacy · HIPAA · SOC 2 · PCI-DSS · NIST CSF 2.0 · NIST Privacy Framework.
- **Conditional/sector** (triage-gated, only audited when the data type, jurisdiction, or sector triggers them): GLBA · COPPA · SOX · NIST 800-53 · NIST 800-171 · PIPEDA · Quebec Law 25 · NIS2 · DORA · EU AI Act · Cyber Resilience Act.

## How `/comply` uses this
1. Triage the product (what data, which residents, which sector) → the applicable frameworks.
2. Work each applicable `requirements/<framework>.md` against the codebase, grouped by the unified primitive (so one fix maps to many frameworks).
3. Report gaps ranked by risk, with the citation + the concrete remediation.

Reference only, **not legal advice**. Regulations change; verify against the cited source.

<!-- RESPAWNPACK SPINE TEMPLATE · lands as compliance.config.md (repo root) · fill the <PLACEHOLDERS>, keep the structure. -->
# <PROJECT> — compliance scope (`compliance.config.md`)

**The declared answer to "which regimes apply to this product, and why."** `/comply` reads this in Step 0 (triage) instead of re-guessing each run; `/loadout` updates it when a new data flow changes the picture; `/savepoint` flags drift against it. Keep it short and current — it is the index, the detailed work lives in [`library/compliance/requirements/`](library/compliance/requirements/) and the posture in [`docs/compliance/REGISTER.md`](docs/compliance/REGISTER.md).

**Reference, not legal advice.** This records *your* applicability calls; a lawyer/DPO owns the hard ones (BA status, cross-border transfers, high-risk AI, DPIA sign-off).

- **Last reviewed:** <date> · **Owner:** <name/role> · **Review cadence:** on every new data class / jurisdiction / sub-processor, and at least quarterly.

## 1. Data classes handled
Tick what the product collects, stores, or transmits — this drives most triggers.

| Data class | In scope? | Where it lives (tables / stores / logs) |
|---|---|---|
| Personal data / PII (names, emails, identifiers) | ☐ | <…> |
| Sensitive / special-category (health, biometric, race, religion, sexuality, precise geolocation) | ☐ | <…> |
| Protected Health Information (PHI) for a covered entity | ☐ | <…> |
| Cardholder data (PAN) | ☐ | <…> |
| Financial non-public personal information (NPI) | ☐ | <…> |
| Children's data (under 13 / under 16 in some states) | ☐ | <…> |
| Authentication secrets / credentials | ☐ | <…> |

## 2. Whose data — jurisdictions & data subjects
| Population | In scope? | Triggers |
|---|---|---|
| EU / EEA residents | ☐ | GDPR · ePrivacy |
| UK residents | ☐ | UK GDPR + DPA 2018 · PECR |
| California residents (over threshold) | ☐ | CCPA/CPRA |
| Other US state residents (VA, CO, CT, UT, TX, …) | ☐ | US state privacy laws |
| Canadians (federal) | ☐ | PIPEDA |
| Quebec residents | ☐ | Law 25 (P-39.1) |

## 3. Sector / activity triggers
| If the product… | In scope? | Triggers |
|---|---|---|
| handles health data for a provider/insurer (you're a Business Associate) | ☐ | HIPAA |
| offers financial products / moves money | ☐ | GLBA |
| is directed to (or knowingly collects from) children under 13 | ☐ | COPPA |
| takes card payments | ☐ | PCI-DSS |
| sells to enterprise / EU buyers (market-driven) | ☐ | SOC 2 / ISO 27001 |
| is or becomes a public company (IPO/acquisition readiness) | ☐ | SOX ITGCs |
| ships an AI feature affecting EU users | ☐ | EU AI Act (Art. 50 transparency, at least) |
| ships an installable artifact (app / CLI / SDK / extension / firmware) | ☐ | EU Cyber Resilience Act |
| sells ICT services to EU financial entities | ☐ | DORA (contractual flow-down) |
| is a medium+ entity in an EU essential/important sector | ☐ | NIS2 |
| pursues US government / defense (CUI) contracts | ☐ | NIST 800-53 (FedRAMP) / 800-171 (CMMC) |

## 4. Applicable frameworks (the resolved list)
The frameworks the ticks above select. Each links to its per-requirement checklist; `/comply` audits exactly these and no others.

- **Default scope (almost always):** <e.g. GDPR · UK GDPR · ePrivacy/PECR · CCPA/CPRA · US state privacy>
- **Conditional/sector (triggered):** <e.g. HIPAA · GLBA · EU AI Act · …>
- **Explicitly out of scope (and why):** <e.g. "no card data — Stripe hosted checkout keeps PAN out of scope (SAQ-A); no children's data — 18+ ToS gate">

## 5. Accountability roles
| Role | Required when | This product |
|---|---|---|
| DPO (GDPR Art. 37) | core activity = large-scale monitoring or special-category | <name / "not required — document why"> |
| Privacy Officer (PIPEDA / Law 25 s.3.1) | any Canadian/Quebec personal data | <name / default = highest authority> |
| Qualified Individual (GLBA §314.4(a)) | NPI in scope | <name> |
| HIPAA Security Official (§164.308(a)(2)) | PHI in scope | <name> |
| Outside counsel | for the hard calls | <firm / contact> |

## 6. Sub-processors & transfers
- **Sub-processor / vendor register:** <link or "see [`docs/compliance/dpa-baa-checklist.md`](docs/compliance/dpa-baa-checklist.md) + the vendor register">. Confirm each provider offers the needed **DPA (PII) / BAA (PHI) / security addendum (NPI)** *before* regulated data flows to it.
- **International transfers:** <e.g. "EU data stays in an EU region; US transfers covered by SCCs + a transfer assessment; UK uses the IDTA/Addendum"> or "none".

## 7. Worked default (delete once filled)
> A typical EU+US B2B SaaS on managed infra, no health/financial/children's data, with an AI feature:
> **Default scope** — GDPR, UK GDPR, ePrivacy/PECR, CCPA/CPRA, US state privacy. **Conditional** — EU AI Act (Art. 50 transparency only; designed to stay out of high-risk). **Market** — SOC 2 (enterprise sales). **Out of scope** — HIPAA (no PHI), GLBA (no NPI), COPPA (18+), PCI (Stripe hosted checkout → SAQ-A), CRA (pure SaaS, no installable artifact). **Roles** — founder is Privacy Officer; no DPO required (no large-scale monitoring); outside counsel on retainer for DPIA sign-off.

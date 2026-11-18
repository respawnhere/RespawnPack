<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/compliance/breach-runbook.md · REFERENCE runbook — update when a procedure or clock changes. -->
# <PROJECT> — breach / incident notification runbook

The single procedure for a confirmed or suspected breach of personal/regulated data: **detect → contain → assess → notify → document → learn**, parameterized by the **tightest applicable clock**. This is the operational face of the **incident-response + breach pipeline primitive (8)**. Wire it to the audit log (6) and the data inventory / RoPA (4) so scope and timeline are reconstructable.

**Reference, not legal advice.** Notification decisions (is it a "breach"? is there "risk"? does an exemption apply?) often need counsel/DPO — escalate early; the clocks run from *discovery*, not from when you finish investigating.

## The clock starts at discovery
Most regimes count from when you **become aware** of the incident, not from when you confirm its scope. Timestamp discovery immediately and run the steps in parallel — do not let assessment eat the notification window.

## Step 0 — Detect & triage
Open an incident record (severity, discovery timestamp, on-call owner). Sources: alerting, SIEM, audit-log anomalies, a report from a sub-processor (their contract should require prompt notice — see the DPA/BAA checklist), or a researcher via `security.txt`.

## Step 1 — Contain
Stop the bleeding: revoke/rotate exposed credentials and keys, close the access path, isolate affected systems, preserve forensic evidence (don't wipe logs). Record every action with timestamps.

## Step 2 — Assess scope (drives everything downstream)
- **What data, whose, how much** — use the data inventory / [`RoPA.md`](RoPA.md) to enumerate the data classes and data-subject categories touched, and counts per jurisdiction (the 500-consumer / 500-resident thresholds below depend on this).
- **Was it "unsecured"?** If the data was **encrypted** (and keys weren't exposed) or destroyed per guidance, several regimes' notification duties fall away — under HIPAA only **unsecured** (un-encrypted) PHI triggers notification (§164.402 defines "unsecured PHI"), and CCPA's statutory-damages exposure likewise turns on encryption. Record the encryption state.
- **Risk determination** — many regimes only require individual notice above a risk threshold: GDPR "risk" / "high risk", PIPEDA "real risk of significant harm (RROSH)", Law 25 "risk of serious injury", HIPAA's four-factor §164.402 assessment. Document the determination either way (you bear the burden of proof).

## Step 3 — Determine obligations & clocks (per applicable regime)
Run this only for the frameworks in [`compliance.config.md`](../../compliance.config.md). **All windows run from discovery/awareness unless noted.**

| Regime | Notify whom | Deadline | Threshold / trigger |
|---|---|---|---|
| **GDPR** (Art. 33/34) | Supervisory authority (DPA) | **72h** (without undue delay) | any breach unless "unlikely to result in risk" |
| | Affected individuals | without undue delay | only if **high risk** to rights/freedoms |
| **UK GDPR** (DPA 2018) | ICO | **72h** | same as GDPR; report to the ICO |
| **HIPAA** (§164.404/406/408/410) | Affected individuals | **≤60 calendar days** | breach of *unsecured* PHI |
| | HHS (OCR portal) | ≥500: **≤60 days**; <500: **annually**, within 60 days of year-end | per the 500 threshold |
| | Prominent media | **≤60 days** | **>500 residents** of one state/jurisdiction |
| | (as a **BA**) the covered entity | **≤60 days** (or tighter per BAA) | any breach of unsecured PHI |
| **GLBA Safeguards** (§314.4(j)) | FTC (online form) | **≤30 days** (as soon as possible) | **≥500 consumers**, *unencrypted* NPI |
| **US state privacy / breach laws** | State AG + affected residents | per state — many "without unreasonable delay", several cap at **30–60 days** | per-state thresholds; check the specific state(s) |
| **PIPEDA** (s.10.1, s.10.3) | OPC + affected individuals | as soon as feasible | **RROSH**; *and* log **every** breach, retained **24 months** (from when you *determine* it occurred) |
| **Quebec Law 25** (s.3.5–3.8) | CAI + affected persons | with diligence (promptly) | **risk of serious injury**; maintain an incident register (all incidents; **5-year** retention) |
| **NIS2** (Art. 23) | CSIRT / competent authority | early warning **24h** → notification **72h** → final report **1 month** | significant incident |
| **DORA** (Art. 19 + RTS 2025/301) | Competent authority | initial **≤24h** of awareness (and ≤4h after classifying major) → intermediate **72h** → final **1 month** (after the intermediate report) | major ICT-related incident |
| **EU CRA** (Art. 14) | ENISA / CSIRT (single platform) | early warning **24h** → notification **72h** → final report: **14 days** after a fix is available (exploited vuln) / **1 month** after the 72h notice (severe incident) | actively-exploited vulnerability or severe incident in a product with digital elements |

> If several apply, the **tightest clock and broadest recipient set** govern — e.g. a fintech with EU users facing an actively-exploited bug could owe GDPR 72h **and** DORA 24h **and** CRA 24h notices at once. Notify on the shortest first.

## Step 4 — Notify
- **Content** (cover what each regime requires): what happened + dates, data categories involved, likely consequences, what you're doing / mitigations, steps individuals should take, and a contact point — in plain language.
- **Channels:** email/letter to individuals; the regulator's portal/form; substitute notice (website + media) where contact info is insufficient and the regime allows it.
- Send through templated paths so the clock isn't lost to drafting; capture timestamps and recipients.

## Step 5 — Document & retain
Retain, for each incident: the discovery timestamp, the risk/four-factor determination (incl. "not a breach" calls), every notification (recipient, content, date), and the remediation. Retention floors: **HIPAA 6 years**, **Quebec Law 25 incident register 5 years** (from awareness), **PIPEDA breach log 24 months**, plus your own policy. This evidence discharges the burden of proof (e.g. HIPAA §164.414(b)).

## Step 6 — Post-incident
Root-cause and a `DECISIONS.md` entry for any preventive change; update the affected controls and the [`REGISTER.md`](REGISTER.md) posture; feed a learning into `/debug`'s capture. Update this runbook if a step or clock proved wrong.

## Cross-references
- Scope/data: [`RoPA.md`](RoPA.md) · sub-processor breach-notice duties: [`dpa-baa-checklist.md`](dpa-baa-checklist.md) · per-regime detail: [`library/compliance/requirements/`](../../library/compliance/requirements/) (HIPAA §164.400–414, GDPR Art. 33–34, GLBA §314.4(j), NIS2 Art. 23, DORA Art. 19, CRA Art. 14).

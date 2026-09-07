<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/compliance/dpa-baa-checklist.md · REFERENCE checklist — update when a procedure changes. -->
# <PROJECT> — DPA / BAA / sub-processor checklist

The procedure for putting the **right contract in place before regulated data flows to a vendor** — the highest-leverage managed-infra compliance check there is. This is the operational face of the **vendor/sub-processor register primitive (9)**. Every recipient listed in [`RoPA.md`](RoPA.md) should appear here with the correct contract type and status.

**Reference, not legal advice.** Contract terms (liability, indemnity, audit scope) need counsel; this checklist is about *having the right instrument and the clauses that matter*.

## Step 1 — Which contract does this vendor need?
Pick by the most-sensitive data class the vendor will touch. **The order of operations matters: confirm the vendor *offers* the instrument before you route data — if it won't sign, the data must not reach it.**

| Data the vendor touches | Required instrument | Basis |
|---|---|---|
| EU/UK personal data (you're controller, they're processor) | **DPA** (Data Processing Agreement) | GDPR Art. 28 |
| Protected Health Information (PHI) | **BAA** (Business Associate Agreement) | HIPAA §164.314(a), §164.308(b) |
| Financial NPI | **service-provider / security addendum** | GLBA §314.4(f) |
| US-state personal data | **service-provider contract** | CCPA §1798.140(ag) + state analogues |
| Canadian / Quebec personal data | **written mandate w/ confidentiality + security terms** | PIPEDA Principle 4.1.3 · Law 25 s.18.3 |
| Any of the above transferred outside the EU/UK | **SCCs** (EU 2021/914) · **UK IDTA/Addendum** + a transfer assessment | GDPR Ch. V |
| ICT services to an EU financial entity (you're the provider) | **DORA Art. 30 contractual terms** + Register of Information entry | DORA Art. 28–30 |

> A vendor can need **several** (e.g. a US analytics tool touching EU PII needs a DPA **and** SCCs). Children's data (COPPA) and card data (PCI) add their own flow-down terms.

## Step 2 — Managed-infra check (do this first, every time)
Before routing regulated data, confirm the provider publishes and will sign the instrument you need. These vary by plan and product:

- **Supabase / Fly / Cloudflare / Vercel** — DPA generally available; **BAA usually requires a specific plan/agreement** (verify before any PHI).
- **Email / SMS (Resend, Postmark, Twilio, …)** — DPA yes; BAA only on specific tiers — keep PHI out otherwise.
- **LLM / AI APIs** — check the DPA, the **data-retention / training-use** terms, and whether a **BAA / zero-retention** option exists before sending PII/PHI in prompts.
- **Error trackers / analytics / session replay** — high leak risk; either get the contract **or** scrub regulated data before it reaches them (prefer scrubbing).

## Step 3 — Clause checklist
**DPA (GDPR Art. 28(3)) must include:**
- ☐ Process only on **documented instructions**
- ☐ **Confidentiality** of authorized personnel
- ☐ **Art. 32 security** measures
- ☐ **Sub-processor** authorization + flow-down of equivalent terms
- ☐ Assist with **data-subject rights** and with Art. 32–36 (security, breach, DPIA)
- ☐ **Delete or return** data at end of service
- ☐ **Audit / inspection** rights + provide compliance information
- ☐ **Breach notification** to you, without undue delay

**BAA (HIPAA §164.314(a)) must include:**
- ☐ Comply with the **Security Rule** for ePHI
- ☐ Use/disclose PHI only as permitted
- ☐ **Report security incidents & breaches** of unsecured PHI (per §164.410) to you
- ☐ Ensure **subcontractors** agree to the same protections (flow-down)
- ☐ **Return or destroy** PHI at termination where feasible

## Step 4 — Register the vendor
Record in the vendor/sub-processor register (and reflect status in [`REGISTER.md`](REGISTER.md)):

| Vendor | Data class | Instrument | Status | Transfer mechanism | Signed / dated | Sub-processor list reviewed |
|---|---|---|---|---|---|---|
| <e.g. Supabase> | PII | DPA | ☐ signed | EU region | <date> | <date> |
| <…> | | | | | | |

## Cross-references
- Recipients to cover come from [`RoPA.md`](RoPA.md); breach-notice duties flow into [`breach-runbook.md`](breach-runbook.md); per-framework detail (HIPAA §164.314, GDPR Art. 28, GLBA §314.4(f), DORA Art. 30) in [`library/compliance/requirements/`](../../library/compliance/requirements/).

<!-- RESPAWNPACK SPINE TEMPLATE · lands as docs/compliance/RoPA.md · CANONICAL — maintain at the moment a processing activity changes. -->
# <PROJECT> — Records of Processing Activities (RoPA)

**CANONICAL.** The inventory of *what personal data you process, why, and how* — required by **GDPR Art. 30** (controllers under 30(1), processors under 30(2)) and the practical backbone for CCPA/PIPEDA/Law 25 data-mapping, DPIAs, retention, and breach-scope analysis. It is the human-readable face of the **data-inventory primitive (4)**: keep it in sync with the sensitive-field tags in code, not as a parallel guess.

**Maintain it at the moment a processing activity is added or changes** (a new feature, integration, or sub-processor) — `/loadout` proposes the RoPA delta when it classifies data; `/savepoint` flags a new data flow that has no RoPA row.

**Reference, not legal advice.** Art. 30 has a limited <250-employee exemption that rarely applies (it falls away for any non-occasional processing, special-category data, or criminal-offence data) — assume you need this.

## How to use
One entry per **processing activity** (a purpose-bound use of data — "user authentication", "product analytics", "billing", "support tickets", "marketing email"), not one per field. Fill the Art. 30 fields below; the worked example shows the shape. Where you are a **processor** for a customer (Art. 30(2)), record the controller and the categories you process on their behalf instead of purposes/lawful basis.

## Processing activities

### PA-001 — <activity name>
- **Role:** <controller | processor | joint controller>  ·  **Controller (if processor):** <customer / —>
- **Purpose(s):** <why you process this data>
- **Lawful basis (GDPR Art. 6):** <consent | contract | legal obligation | vital interests | public task | legitimate interests (+ the LIA)>  ·  **Special-category condition (Art. 9), if any:** <…>
- **Data-subject categories:** <users, customers, employees, prospects, children, …>
- **Personal-data categories:** <identifiers, contact, auth, usage, location, financial, health, …>  ·  **Sensitive/special-category:** <… or none>
- **Recipients / sub-processors:** <internal teams + external vendors that receive it — must match the vendor register & DPA/BAA checklist>
- **International transfers:** <country + safeguard (SCCs / UK IDTA / adequacy) — or "none / EU-only">
- **Retention:** <period or criteria → ties to the deletion-jobs primitive (7)>
- **Security measures (TOMs):** <the primitives in play — encryption (1), access control (5), audit logging (6), pseudonymisation, …>
- **Source store(s):** <tables / buckets / services where it lives>

### PA-002 — <activity name>
- _(repeat the block)_

## Worked example (delete once you have real entries)
> ### PA-001 — User authentication & account management
> - **Role:** controller
> - **Purpose(s):** authenticate users, secure accounts, account recovery
> - **Lawful basis:** contract (Art. 6(1)(b)) — necessary to provide the service
> - **Data-subject categories:** registered users
> - **Personal-data categories:** email, hashed password, IP/device for security, MFA factors · **Sensitive:** none
> - **Recipients / sub-processors:** Supabase (auth + DB, DPA on file), email provider for verification (DPA on file)
> - **International transfers:** EU region; no US transfer for this activity
> - **Retention:** life of account + 30 days post-deletion (backup expiry), then purged
> - **Security measures:** TLS 1.2+ (1), Postgres RLS + MFA (5), append-only auth audit log (6), password hashing
> - **Source store(s):** `auth.users`, `public.profiles`

## Cross-references
- **Sub-processor contracts:** [`dpa-baa-checklist.md`](dpa-baa-checklist.md) — the recipients above each need the right contract before data flows.
- **Posture:** record RoPA completeness against the data-inventory primitive in [`REGISTER.md`](REGISTER.md).
- **Breach scope:** the breach-runbook reads this to scope which data classes and data subjects an incident touched.

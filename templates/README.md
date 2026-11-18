# RespawnPack templates

Install-time artifacts the installer drops into a target repo (skipped if the destination already exists, like everything else the installer places).

| Template | Lands at | What |
|---|---|---|
| [`ci/security.yml`](ci/security.yml) | `.github/workflows/respawnpack-security.yml` | **Security CI**: gitleaks full-history secret scan + dependency-CVE audit, on every push/PR **and** a weekly schedule. The out-of-session half of the security loop. |
| [`CODEOWNERS`](CODEOWNERS) | `.github/CODEOWNERS` | **Sensitive-path review gates**: require owner review on auth / payments / migrations / infra / `.claude/` before merge. The persistent, every-contributor complement to the in-session `lockdown` hook (fill in owners). |

> **Organization-owned repos** must set a free `GITLEAKS_LICENSE` secret (get one at [gitleaks.io](https://gitleaks.io)) for the secret-scan job to run; personal-account repos need no license.

## Why a CI template *and* the security skills

They cover different moments, by design (defense-in-depth):

| Layer | Runs | Catches |
|---|---|---|
| [`secret-scan`](../hooks/secret-scan.js) hook | at push time, in-session | a credential about to be pushed |
| [`/secure`](../skills/secure/SKILL.md) · [`/secrets-audit`](../ops/secrets-audit/SKILL.md) · `/review` lens | on demand, while you work | code (OWASP), deps/SBOM, infra advisories, secret hygiene |
| **this CI** | every push/PR + weekly cron | pushes made outside Claude, and **CVEs disclosed after a clean ship** |

The skills and the hook protect you while an agent is in the loop; the CI protects the repo when one isn't. Edit the `dependency-audit` step for your stack. It auto-detects Node package managers (Yarn v1 and v2+ included); add `pip-audit` / `cargo audit` / `govulncheck` for others.

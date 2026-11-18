---
name: secure
description: The security-audit role — defense-in-depth over a change or repo: the host's /security-review for the OWASP code lenses, plus the pack's dependency/supply-chain CVEs and SBOM, the LLM-surface lens, and managed-infra advisories. Verifies each finding. Delegates secrets to /secrets-audit.
when_to_use: "secure", "/secure", "audit", "security", "security audit", "threat scan", "owasp", "vuln scan", "pentest the change"
---

# /secure — security audit (defense-in-depth)

**Thin wrapper.** The code-level OWASP lenses are the host's `/security-review` (with the `security-guidance` plugin's per-edit scan assumed present when the host reports it); the pack keeps the secrets delegation, the dependency/SBOM legs, the LLM/AI-surface lens the notes do not give the host, and the managed-infra advisories. The host's command is the host's; the pack does not vouch for its output. Run it any time; `/review` and `/ship` call in for sensitive changes, and it **adversarially verifies every finding before reporting**.

## Step 0 — Scope the audit surface
Decide the surface: a change (`git diff` — uncommitted / branch / PR) or the whole repo (a periodic audit). Identify the **risk surfaces** that get extra weight: auth/session, access control, payments, file upload, user input reaching a query/DOM/shell, webhooks, deserialization, SSRF-prone fetches, and anything internet-facing. Read `docs/ARCHITECTURE-ROADMAP.md` for trust boundaries and `respawnpack.config.json` `opsTargets` for the managed services in play.

## Step 1 — Secrets (delegate, don't re-implement)
Secret hygiene lives in [`/secrets-audit`](../secrets-audit/SKILL.md) — run it (or confirm it's already clean); the [`secret-scan`](../../hooks/secret-scan.js) hook is the push-time backstop. **Don't duplicate it here** (WRITE-ONCE) — fold its HIGH-severity findings into this report by reference. Never echo a secret value; reference it by name.

## Step 2 — Dependencies & supply chain (SBOM) — the pack's leg
- **CVE scan** — audit the dependency set for known vulnerabilities via [`/mcp-security-audit`](../mcp-security-audit/SKILL.base.md) (the JS leg — drives the `security-audit` MCP `audit_nodejs_dependencies` over `package.json` deps where connected), else the stack's auditor (`npm audit --audit-level=high` / `pnpm audit` / `yarn npm audit` / `pip-audit` / `cargo audit` / `govulncheck`). The MCP leg is Node/npm only — use the matching auditor for Python/Go/Rust.
- **Supply-chain hygiene** — flag unpinned ranges on security-sensitive deps, lockfile drift (missing or out-of-sync), typosquat-risk / freshly-published / low-reputation packages, and `postinstall` scripts pulled in transitively.
- **SBOM** — produce or refresh a software bill of materials (resolved dependency tree + versions + licenses) so "what are we actually shipping" is answerable. Call out deps newly introduced in the diff.

## Step 3 — Code-level audit: the host's /security-review, plus the pack's LLM lens
Run the host's `/security-review` on the surface, weighted by Step 0's risk surfaces; it carries the OWASP code lenses (access control / IDOR, injection, authn/session, SSRF / unsafe fetch / deserialization, sensitive-data exposure), and the `security-guidance` plugin's per-edit scan is assumed present when the host reports it. Its findings are the host's; the pack re-reports only what survives the verify below. No `/security-review` on this host → say so and run the pack's legs alone, never pretend the code lenses ran.

Beside it, fan out the pack's own lens the notes do not attribute to the host:
- **LLM / AI surfaces (OWASP LLM Top 10) — the pack's lens.** *Only when the target calls a model or runs an agent.* Prompt-injection (direct, and indirect via retrieved documents or tool output); insecure handling of model output (rendered, executed, or run as a query without validation); excessive agency (tool/permission grants beyond the feature's need); sensitive-data leakage into prompts or logs; and cost abuse (unbounded or unauthenticated paid calls). No AI surface → skip this lens; don't invent one.

**Adversarially verify** each finding — a skeptic pass that tries to *refute* it (default "not exploitable" unless the evidence holds); drop or downgrade what doesn't survive; force any you can't verify to low confidence. This covers the pack's LLM-lens findings and any host finding the pack re-reports.

## Step 4 — Infra / config advisories (MCP-first) — the pack's leg
For the managed services (`opsTargets`), pull real advisories, not guesses:
- **Supabase / Postgres** — `get_advisors(type: security)`: missing RLS, exposed tables/views, `security definer` risks, weak policies.
- **Cloudflare / Fly / Vercel** — WAF/firewall posture, public bindings, over-broad tokens/scopes, missing security headers (CSP / HSTS / `X-Content-Type-Options`).
- **Config** — debug endpoints reachable in prod, permissive CORS, default credentials, verbose errors leaking internals.

## Step 5 — Report (+ optionally fix)
Rank surviving findings by **severity × exploitability**. Each gets: file:line (or the dependency / advisory), an **exploit scenario** (how it's abused), and a concrete **fix**. State what was clean. If asked, apply fixes (in scope) and re-verify. For an **accepted risk** (won't-fix, with rationale), propose a `DECISIONS.md` entry so the call is recorded, not lost.

## Invariants
- **The code lenses are the host's** `/security-review`; the pack owns the secrets delegation, the dependency/SBOM legs, the LLM-surface lens, and the MCP infra advisories. No `/security-review` on this host → the pack's legs run alone and the report says so.
- **Never print a secret value** — reference by name; the secrets dimension is delegated to `/secrets-audit` (WRITE-ONCE).
- **Defense-in-depth, not theater** — prioritize real risk reduction; rank by exploitability; don't bury the report in lint-level noise.
- **Reads + proposes** — findings and fixes are proposed; a prod change (rotating a key, tightening a policy) needs the same authorization as any prod write.
- Cross-cutting: `/review` runs the lighter security lens inline; `/secure` is the deep pass `/ship` gates on for sensitive paths.

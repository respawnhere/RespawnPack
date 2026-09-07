# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `0.3.x` (latest release) | Yes |
| `main` (latest) | Yes |
| `< 0.3.0` | No |

RespawnPack is pre-1.0. Fixes land on `main` and the next tagged release; there is no separate long-term-support branch yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on [respawnhere/RespawnPack](https://github.com/respawnhere/RespawnPack): open the repo's **Security** tab and select **Report a vulnerability**. This creates a private advisory visible only to the maintainer until a fix is ready.

Do not open a public issue for a suspected vulnerability. Public issues are fine for everything else (bugs, feature requests, docs).

RespawnPack is maintained by a single person on a best-effort basis. There is no bounty program and no guaranteed response time, but reports are read and triaged as they come in.

## Scope

The security-relevant surfaces in this repo are:

- **The installer** (`install/install.js`): writes files into a target repo and merges hook configuration into `.claude/settings.json`. A bug here could place unintended files or hook entries in a downstream project.
- **The governance hooks** (`hooks/lockdown.js`, `hooks/secret-scan.js`, `hooks/stop-savepoint.js`, `hooks/pre-push`): the edit-scoping and secret-scanning guardrails that other repos rely on once installed.
- **The subagent-result channel** (`hooks/injection-scan.js`, PostToolUse on Agent/Task): a subagent's returned report is untrusted content, no more trustworthy than a fetched web page, and is scanned for capability spoofing, fabricated conversation history, and other instruction-shaped signatures on the way back to the orchestrator. Advisory only, since the pack's own security-triage subagents legitimately quote the payloads they report on.
- **The memory engine** (`memory/engine/`): the MCP server and `rmem` CLI backing the respawn-memory system, including its embedding providers and PGLite-backed storage.

Reports about the credited third-party skills referenced in `ATTRIBUTION.md` should go to their own upstream repositories; RespawnPack references them but does not maintain their code.

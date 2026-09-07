<!-- RESPAWNPACK SPINE · lands as docs/reference/README.md -->
# Reference

**REFERENCE class.** Runbooks and one-time procedures — low-drift, not read as "current product truth." Put operational how-tos here (deploy, restore, incident, vendor setup, test-scenario libraries). Procedures that the agent *runs* belong in `.claude/skills/`; the data/specs they consume belong here.

## Subtrees

- **`design-standards/`** holds the five detail files behind `design-standards.md`: interaction craft, visual system, psychology of use, accessibility, validation.
- **`models/`** holds the model capability register (`capability-register.json` and the rendered `capability-register.md` beside it) and the per-family prompting practice: `prompting-anthropic.md`, `prompting-openai.md`, `prompting-minimax.md`, and `prompting-general.md` as the fallback for a model the register does not profile. The register is dated and sourced by construction: a rating carries a URL and an access date, or it reads `unproven` with the gap named. The installer places this subtree under `docs/reference/models/`, and a target's own copy there is what `core/policy/routing.js`, `adapters/providers/offload.js` and the task runner read first; each falls back to this pack's own copy here only when a target has none, so this subtree is no longer a dead end. In the pack repository the dated evidence file the register was read out of, `capability-evidence.md`, sits beside it with a URL and an access date on every claim; it is not installed into a project.

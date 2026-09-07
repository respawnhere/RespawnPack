# RespawnPack — Orchestration templates

Reusable **Workflow-tool** scripts + the subagent conventions behind them. These encode the harness-native patterns RespawnPack favors over hand-rolled bash orchestration. Run them with the Workflow tool (inline `script` or `scriptPath`); they fan out subagents deterministically and return structured results.

## Agent vs Workflow (pick the mechanism)
- **Agent tool** — model-driven, ad-hoc. A few independent subagents in one message. Good for "read across these and give me the answer."
- **Workflow tool** — deterministic control flow (loops, fan-out, barriers, verification) in a JS script. Good for repeatable, structured, at-scale work (audit, review, migration). Resumable.

## The conventions every template honors
1. **Moderate concurrency by default.** The Workflow runtime caps concurrent agents at ~`min(16, cores−2)`, but the *practical* ceiling is lower — a ~13-wide fan-out throttled against the model rate-limit in real use. **Keep parallel agents single-digit; run synthesis sequentially.** If you fan out wide, expect to lean on **resume** (`resumeFromRunId`) — cached agents return instantly, only the failed tail re-runs.
2. **`pipeline()` is the default; `parallel()` is a barrier.** Use `pipeline(items, stage1, stage2)` so each item flows through all stages independently (wall-clock = slowest single chain). Only use `parallel()` (a barrier) when a stage genuinely needs *all* prior results at once (dedup across the set, early-exit on zero, "compare against the others").
3. **Structured output via `schema`.** Give `agent()` a JSON-Schema `schema` so it returns validated data (no parsing). Synthesis reads the prior stage's structured output.
4. **Adversarially verify before trusting.** A finding isn't real until an independent skeptic pass fails to refute it. Force unverifiable findings to low confidence.
5. **Worktree isolation for parallel edits.** When subagents *mutate files* concurrently, pass `isolation:'worktree'` so they don't collide (expensive — only when actually editing in parallel).
6. **Subagents return data, not prose-for-humans.** The orchestrator relays; brief each subagent tightly (its context is only the prompt you give it).

## The pattern catalog
| Template | Pattern | When |
|---|---|---|
| [`audit.workflow.js`](audit.workflow.js) | fan-out readers → barrier → synthesize → completeness-critic | survey a corpus (docs, a codebase area) comprehensively |
| [`review.workflow.js`](review.workflow.js) | per-dimension review → adversarially verify each finding (pipelined) | review a change across correctness/security/… without false positives — the `.workflow.js` is a fill-in template; the [`agents/*-reviewer.md`](../agents/) files are the source of truth for the lens list (mirrored in [`skills/review/SKILL.md`](../skills/review/SKILL.md) Step 2) |
| [`migrate.workflow.js`](migrate.workflow.js) | discover sites → transform each (worktree-isolated) → verify | mechanical sweep across many call-sites |

Other shapes worth composing (see the Workflow tool's own guidance): **loop-until-dry** (keep finding until K empty rounds), **judge-panel** (N attempts → score → synthesize), **completeness-critic** (a final "what did we miss?" pass).

## Run
```
Workflow({ scriptPath: ".claude/workflows/review.workflow.js" })   // or inline `script`
// resume a throttled run: Workflow({ scriptPath, resumeFromRunId: "<runId>" })
```
> 📝 These are **templates** — adapt the `FILL:` parts (the corpus/dimensions/pattern, the prompts, the schemas) to the task. The `meta` block must be a pure literal.

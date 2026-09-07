<!-- RESPAWNPACK SPINE · lands as docs/reference/models/prompting-general.md -->
# Prompting practice: the general fallback

**As of 2026-09-03. This is the fallback.** When the model you are prompting has a family file beside this one, use that file: `prompting-anthropic.md`, `prompting-openai.md`, `prompting-minimax.md`. Use this file when the model belongs to no profiled family, when you are writing one prompt that has to work on more than one of them, or when the family file is silent on the point.

**The rule for what is allowed in here.** Every practice below is stated by at least two of the three makers' own guidance pages, and the third does not contradict it. That is what makes it portable. Anything only one maker says lives in that maker's file, and the places where two of them actively disagree are listed at the bottom so you do not write one of them into a shared template by accident.

Sources are the three makers' guidance pages, all accessed 2026-09-03: Anthropic https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices; OpenAI https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide and https://developers.openai.com/api/docs/guides/prompt-engineering; MiniMax https://platform.minimax.io/docs/token-plan/prompting-best-practices.

---

## The thirteen

1. **State the task, the constraints and the shape of a good answer.** Write it so a colleague with no context could follow it. (Anthropic's golden rule, repeated by MiniMax; OpenAI asks for precise instructions with no contradictions.)

2. **Give the reason behind a constraint, not only the rule.** (Anthropic: context improves performance. OpenAI: tell the model when an important ambiguity should trigger a question. MiniMax uses the same pattern in its worked examples.)

3. **Separate instructions, context, examples and inputs with visible delimiters, and keep the layout consistent.** All three say this; they disagree about which delimiter, which is why the shape matters more than the syntax.

4. **Provide three to five relevant, diverse examples** for anything format- or judgment-sensitive. (Anthropic and MiniMax by number; OpenAI asks for a diverse range of possible inputs.)

5. **Put long source material first and the question or task last, and ask for quotes or citations.** (Anthropic measures up to 30 percent better answers; MiniMax calls it the largest single effect on answer quality; OpenAI puts reusable content first for caching, which is compatible.)

6. **Control reasoning depth with the model's own effort or thinking parameter rather than scripting step-by-step reasoning.** Raise it for planning, debugging and long-horizon work; lower it for extraction and formatting. (All three.)

7. **Say what to do rather than what not to do, and do not stack contradictory or redundant instructions.** Thoroughness, verification and "ask first" are the three that stack up unnoticed. Delete instructions written for an older model before adding new ones. (Anthropic and OpenAI; MiniMax asks you to evaluate before changing.)

8. **Describe tools precisely and expose only the ones the task needs.** Name, purpose, inputs, return shape, failure behaviour. Instruct the model to call independent tools in parallel and dependent ones in sequence, and never to guess a parameter. (All three.)

9. **In agent loops, keep the history append-only and pass the full assistant turn back unchanged**, including thinking or reasoning items. Use the maker's caching mechanism instead of editing earlier turns. (An Anthropic hard requirement that returns a 400; OpenAI's reasoning reuse; MiniMax states the complete model response must be appended.)

10. **Define scope and autonomy up front:** what the request authorises, which actions need confirmation (destructive, irreversible, shared-system), and that the model should finish the requested work rather than ending on a question. (Anthropic's autonomy and finish-the-task blocks; OpenAI's Codex guidance not to end on clarifications unless truly blocked; MiniMax's small number of active goals.)

11. **Specify the output contract explicitly:** length, format, sections, markdown policy. Default verbosity and formatting differ per model and change between versions, so anything you leave implicit will move under you. (All three.)

12. **Ground the answer:** say the model may refuse or say it does not know, require it to open sources before claiming facts, and ask it to cite what it used. (Anthropic's "never speculate about code you have not opened"; MiniMax's explicit permission to refuse; OpenAI's read-the-code pattern.)

13. **Re-run your own evaluations when you switch model or effort level.** Effort names are not comparable across models. (Anthropic asks you to match by observed thinking length rather than by effort name; OpenAI to preserve the current effort as a baseline and then compare one level lower; MiniMax to run the current and candidate prompts on the same cases.)

---

## Where the families disagree, so keep it out of a shared prompt

- **Structure.** Anthropic favours XML tags and a role sentence. OpenAI favours a developer message organised by markdown headers, with tags for content boundaries. MiniMax favours bold labels or trailing colons. Tagged examples are the one form all three accept.
- **Progress narration.** OpenAI's general guide asks for a rephrased goal and progress updates; its own Codex guide asks you to remove them, because they can make that model stop abruptly. Anthropic asks you to add narration on one model and trim it on another. There is no portable default; set it per model.
- **Verification.** Anthropic asks you to remove self-check instructions on one of its models to avoid over-verification. OpenAI's Codex guide asks the model to test and refine. MiniMax asks for an evaluation loop on the prompt itself, not on the answer. The portable version is item 7: verify once, deliberately, and do not stack.
- **Sampling.** Anthropic rejects non-default `temperature`, `top_p` or `top_k` on several models with a 400. MiniMax publishes recommended values (temperature 1.0, top_p 0.95). OpenAI's guides do not mention temperature for the GPT-5.x models. A single sampling block cannot be carried across the three.
- **Tool-call mechanics.** OpenAI prescribes exact tool implementations by name. Anthropic prescribes the wording of a tool description and per-turn batching instructions, and rejects a forced tool choice on one model. MiniMax prescribes the content of a tool definition. Only item 8's shape is shared.

## One thing all three now agree on

Set an effort or thinking knob. Do not script the reasoning. That is the largest single change from the prompting advice of two years ago, and it is the one instruction in this file that all three makers state in their own words.

<!-- RESPAWNPACK SPINE · lands as docs/reference/models/prompting-anthropic.md -->
# Prompting practice: Anthropic Claude

**As of 2026-09-03.** Eight practices, each with the maker's page it comes from. Where a practice is model-specific it says which model, because the same instruction helps one model in this family and hurts another. For a model this file does not cover, fall back to [`prompting-general.md`](prompting-general.md). Which model to reach for is a different question: that is `capability-register.md` beside this file.

Every source below was accessed 2026-09-03. Anthropic's documentation pages carry no publication date; the per-model pages state a release date, which is quoted where it matters.

---

## 1. Be explicit, and say why

State the task, the constraints and the shape of a good answer. Give the reason behind a constraint rather than only the rule: the maker says context and motivation help the model understand the goal. If you want behaviour beyond the literal ask, request it in words. The maker's own test is to show the prompt to a colleague with minimal context and see whether they could follow it.

Source: vendor, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices

## 2. Structure with XML tags, and give three to five examples

Tags let the model tell instructions from context from input without guessing. The maker asks for three to five diverse examples for best results on anything format- or judgment-sensitive. A single sentence of role in the system prompt measurably changes the answer.

**Where this family differs from the others:** OpenAI organises a developer message with markdown headers and reserves tags for content boundaries; MiniMax uses bold labels or trailing colons. All three accept examples wrapped in tags, so tagged examples are the portable part.

Source: vendor, the prompting best-practices page above.

## 3. Long input first, question last, and ask for quotes

Put longform data at the top of the prompt and the question at the end. The maker puts a figure on it: up to 30 percent better responses. Ask the model to ground its answer in quotes from the material it was given.

For Claude Fable 5.1, add a worked example of how a quotation should be marked: the maker records that its summaries can reproduce passages of the source without marking them as quotations.

Source: vendor, the prompting best-practices page above, and https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1

## 4. Steer with `effort`, not with a thinking budget

On the 5-generation models thinking is adaptive and on by default, and the maker states adaptive thinking reliably beats extended thinking. Set depth with `effort`. On Claude Opus 5, prefer thinking enabled at low effort over disabling thinking, because with thinking off a tool call can leak into the text. Claude Haiku 4.5 is the exception in this family: it takes a manual `budget_tokens` budget and has no `effort`.

Effort names are not comparable across models. The maker states Claude Sonnet 5 at medium is comparable to Sonnet 4.6 at high, and Sonnet 5 at high to 4.6 at max. Re-run your own evals when you move a prompt between models.

Source: vendor, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 and https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5

## 5. Describe tools imperatively, and tone the forcing language down

Write "Change this function", not "Can you suggest a change". Write "Use this tool when ...", not "CRITICAL: you MUST". The maker reports that an explicit instruction to call independent tools in parallel raises parallel-call rates to roughly 100 percent. On Claude Fable 5.1 send that batching instruction each turn as a turn-scoped system message, and note that this model rejects a forced `tool_choice` of "any" or "tool".

Source: vendor, the per-model prompting pages above.

## 6. Do not over-prompt thoroughness or verification

Remove "if in doubt, use [tool]". On Claude Opus 5 remove "double-check" and "use a subagent to verify": the maker reports they cause over-verification. On Claude Sonnet 5 remove periodic self-summarisation such as "after every 3 tool calls, summarize progress".

**Where this family differs:** OpenAI's Codex guide asks the model to test and refine. The safe cross-family default is to verify once, deliberately, and not to stack redundant verification instructions.

Source: vendor, the per-model prompting pages above.

## 7. Control verbosity per model, and say what to do rather than what not to do

Default output length differs by model and changes between versions, so the output contract belongs in the prompt. Claude Opus 5's written deliverables run long and `effort` does not reliably change visible length. Claude Fable 5.1 writes fewer progress updates, so ask for them and set `display: "updates"` if you want them. The style of the prompt shapes the style of the answer.

Source: vendor, the per-model prompting pages above.

## 8. Agentic hygiene: append-only history, state in files, bounded subagents

Keep the conversation append-only and pass thinking blocks back unchanged. Claude Fable 5.1 returns a 400 on an edited prefix. Carry state across context windows in files and in git rather than in the window. Include a reversibility instruction ("consider the reversibility and potential impact of your actions"), an anti-over-engineering instruction, and "never speculate about code you have not opened". Damp subagent use: name when a subagent is worth it (parallel work, isolated context), and on Claude Opus 5 cap concurrency with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, because the maker reports it delegates more readily than earlier models.

Source: vendor, the per-model prompting pages above and https://www.anthropic.com/engineering/built-multi-agent-research-system (published 2025-06-13, an earlier model generation, cited for the lead-plus-subagents pattern rather than for a current figure).

---

## API-level rules that are not style

- No prefill from the 4.6 generation on; it returns a 400. For classification use structured outputs or a tool enum.
- Non-default `temperature`, `top_p` or `top_k` are rejected on Claude Sonnet 5 and on the Fable 5 line. MiniMax, by contrast, publishes recommended sampling values, so a shared prompt template cannot carry one temperature setting for both.
- Claude Fable 5.1, Claude Fable 5 and Claude Opus 5 carry safety classifiers that can decline a request. The refusal arrives as **HTTP 200** with `stop_reason: "refusal"` and a `stop_details.category`. A caller that checks only the HTTP status records a refusal as a success. Categories are cyber, bio, frontier_llm, reasoning_extraction and general_harms; the permitted server-side fallback targets for Fable 5.1 are Claude Opus 4.8 and Claude Opus 5.
- Finding vulnerabilities in source code is permitted, and the maker's prompting page gives phrasing guidance for avoiding false positives on the cyber classifier. Base64 in tool output can trigger one on its own, which is worth knowing before you blame the prompt.

Source: vendor, https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback and the Fable 5.1 prompting page above.

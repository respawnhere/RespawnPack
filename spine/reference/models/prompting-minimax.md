<!-- RESPAWNPACK SPINE · lands as docs/reference/models/prompting-minimax.md -->
# Prompting practice: MiniMax

**As of 2026-09-03.** Eight practices, each with the maker's page it comes from. This maker publishes the least prompting guidance of the three, and the gaps are named at the bottom rather than filled in from a neighbour. For a model this file does not cover, fall back to [`prompting-general.md`](prompting-general.md). Which model to reach for is `capability-register.md` beside this file.

Every source below was accessed 2026-09-03. These pages carry no publication date.

---

## 1. Make the task, the constraints and the output contract explicit

The maker's own framing: the task, the constraints and the desired output are explicit. Name the section names, table columns, bullet limits and scope boundaries you want. The same colleague-with-no-context test Anthropic uses appears here in the maker's own words.

Source: vendor, https://platform.minimax.io/docs/token-plan/prompting-best-practices

## 2. Label sections with bold headers or trailing colons

This maker's structural convention is labelled sections: Task, Context, Source, Constraints, Output format. Use named variables in a template so the same prompt can be filled in without rewriting its shape.

**Where this family differs:** Anthropic asks for XML tags, OpenAI for a developer message under markdown headers. All three accept examples wrapped in tags, which is the portable part of a shared template.

Source: vendor, the usage-tips page above.

## 3. Give three to five diverse examples

The maker states that three to five diverse few-shot examples usually beat abstract style instructions. This is the one structural practice all three families state identically.

Source: vendor, the usage-tips page above.

## 4. For long context, put the task at the end and index the sources

The maker's strongest single claim about prompt layout: placing the task at the end of the prompt has the largest single impact on answer quality. Index and delimit source material, with dates and titles on each piece.

Source: vendor, the usage-tips page above.

## 5. Define each tool by name, purpose, inputs, return shape and failure behaviour

Use parallel calls for independent read-only lookups and sequential calls for workflows that chain. In multi-turn tool loops on the Anthropic-compatible endpoint, the complete model response must be appended to the conversation history, which is the same append-only rule Anthropic enforces with a 400.

Source: vendor, the usage-tips page above and https://platform.minimax.io/docs/api-reference/text-anthropic-api

## 6. Toggle reasoning per task class

Deeper reasoning for planning, debugging, tradeoffs and long-horizon execution; skip it for extraction, rewriting and formatting. MiniMax-M3 exposes `thinking` as enabled, adaptive or disabled, which makes this a setting rather than a prompt instruction.

Source: vendor, the usage-tips page above and https://huggingface.co/MiniMaxAI/MiniMax-M3

## 7. Control hallucination with permission to refuse and a citation requirement

Give the model explicit permission to refuse, and require it to quote or cite the source it used. Both instructions are the maker's own.

Source: vendor, the usage-tips page above.

## 8. Keep the goal set small, and evaluate prompt changes on the same cases

Give the model a small number of active goals at a time. When you change a prompt, run the old and the new version on the same cases and record the regressions rather than judging by impression.

Source: vendor, the usage-tips page above.

---

## API-level rules that are not style

- **Recommended sampling is published**, unlike the other two families: temperature 1.0 and top_p 0.95 for MiniMax-M3, plus top_k 40 for MiniMax-M2.7. Anthropic rejects non-default sampling on several of its models, so a shared template cannot carry one setting for both.
- **The native endpoint can return HTTP 200 with a non-zero `base_resp.status_code`.** A client that checks only the HTTP status will read a failure as a success. Check both.
- **Error codes worth handling by name:** 1002 rate limit, 1008 insufficient balance, 2049 invalid API key, 2056 usage quota exceeded (wait for the next five-hour resource window), 1039 token limit exceeded, 1026 and 1027 input and output flagged as sensitive.
- **The Anthropic-compatible endpoint ignores some Anthropic parameters** (`top_k`, `stop_sequences`, `mcp_servers` among them) and restricts temperature to [0, 2]; the M2.x models there support text and tool-call content blocks only. An open, unanswered issue on the maker's repository reports that layer advertising a 200K window for the 1M-token MiniMax-M3, so a client that trusts the advertised metadata compacts early.

Source: vendor, https://platform.minimax.io/docs/api-reference/text-post, https://platform.minimax.io/docs/api-reference/errorcode and the Anthropic-compatible endpoint page above.

## What this maker does not publish

Named rather than filled in from a neighbour, because a practice invented here would read exactly like one the maker stated:

- **No system-prompt structure guidance.** The labelled-section convention above is the closest thing published.
- **No per-task temperature guidance.** The only sampling numbers are the model-card defaults.
- **No cyber, code-review or long-context quality evaluation** for any model in this family, which is why the register leaves those classes unproven for both entries rather than inferring them from the coding figures.

Where this file is silent, [`prompting-general.md`](prompting-general.md) is the fallback: it carries only practices at least two of the three makers state and the third does not contradict.

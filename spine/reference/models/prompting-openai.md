<!-- RESPAWNPACK SPINE · lands as docs/reference/models/prompting-openai.md -->
# Prompting practice: OpenAI

**As of 2026-09-03.** Eight practices, each with the maker's page it comes from. One of them, progress narration, points in opposite directions inside this family depending on whether you are prompting Codex or a general GPT-5 model, so it is keyed on that rather than given as a default. For a model this file does not cover, fall back to [`prompting-general.md`](prompting-general.md). Which model to reach for is `capability-register.md` beside this file.

Every source below was accessed 2026-09-03. These pages carry no publication date.

---

## 1. Set `reasoning.effort` deliberately

GPT-5.6 supports none, low, medium (default), high, xhigh and max; the maker says to reserve max for the hardest quality-first workloads. Codex exposes Low through Ultra. Lower the effort to curb agentic eagerness; raise it and add a persistence instruction to increase it.

When you move a prompt to a new model, the maker's advice is to preserve the current effort as the baseline and then compare one level lower, because a level is not the same amount of thinking on two different models.

Source: vendor, https://developers.openai.com/api/docs/guides/latest-model and https://learn.chatgpt.com/docs/models

## 2. Prefer leaner prompts, and remove one thing at a time

The maker reports that configurations with leaner system prompts improved evaluation scores by roughly 10 to 15 percent, and recommends removing one group of instructions, examples or tools at a time so you can see which mattered. Expose only the tools the task needs.

**This is the sharpest difference from Anthropic's guidance**, which asks for more explicitness and three to five examples. Both makers agree on the underlying rule, that every instruction earns its place, and disagree on where the default sits.

Source: vendor, https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide

## 3. Remove contradictions before adding instructions

Contradictory instructions make the model spend reasoning tokens looking for a reconciliation. Define what level of action each request authorises. Repeated "ask first" lines cause unnecessary approval requests, which is a contradiction with any instruction to finish the work.

Source: vendor, the GPT-5 prompting guide above, and https://developers.openai.com/api/docs/guides/prompt-engineering

## 4. Use the developer role, organised by headers

Developer messages are instructions from the application developer and are prioritised ahead of user messages. Organise them as Identity, Instructions, Examples, Context. Markdown headers and lists carry the structure; tags are for delineating content boundaries inside it. Put reusable content first so prompt caching can take it.

**Where this family differs:** Anthropic puts the structure in XML tags and a role sentence; MiniMax uses bold labels or trailing colons.

Source: vendor, https://developers.openai.com/api/docs/guides/prompt-engineering

## 5. Shape the output with the API parameter as well as the prompt

`text.verbosity` sets the default level of detail. GPT-5.6 is more concise by default than GPT-5.5, so brevity instructions written for the older model may now be doing nothing. Use markdown only where it is semantically correct, and if adherence to a formatting rule degrades over a long session, restate it every three to five messages.

Source: vendor, https://developers.openai.com/api/docs/guides/latest-model

## 6. Reuse reasoning across turns, and set cache breakpoints explicitly

The Responses API carries reasoning between turns through `previous_response_id` and its reasoning context. GPT-5.6 supports explicit prompt caching (`prompt_cache_options.mode: explicit`); cache writes cost 1.25x the uncached input rate, so mark the breakpoints rather than hoping for them.

Source: vendor, https://developers.openai.com/api/docs/guides/latest-model

## 7. In Codex, use the maker's own tool shapes

Use the exact `apply_patch` tool: the maker states the model was trained to excel at that diff format. Always set `workdir` on `shell_command`. Parallelise with `multi_tool_use.parallel` and only that. Default to implementing with reasonable assumptions rather than ending on a clarifying question unless genuinely blocked. Skip the planning tool for roughly the easiest quarter of tasks. Never `git reset --hard` unless asked, and no broad try/catch.

Source: vendor, https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide

## 8. Progress narration is model-specific, in both directions

The general GPT-5 guide asks the model to begin by rephrasing the goal and to give upfront plans and progress updates. The Codex guide asks you to remove all prompting for upfront plans, preambles and status updates, because on the Codex-line models it can make the model stop abruptly. These are the same maker's two pages, and they are not reconcilable into one default.

Anthropic's guidance runs the same way and lands elsewhere again: add narration on Claude Fable 5.1, trim it on Claude Opus 5. Narration is a per-model setting. Do not write it once into a shared template.

Source: vendor, the GPT-5 prompting guide and the Codex prompting guide above.

---

## Notes that are not style

- **Reasoning models want high-level guidance; non-reasoning GPT models want the logic spelled out.** Applying the second style to the first wastes the model's reasoning on reconciling your steps with its own.
- **No prompting guide specific to GPT-5.5 or GPT-5.6 exists in the cookbook.** Both candidate URLs return 404; the GPT-5.6 guidance lives in the API guides, and the GPT-5 guide is the general reference. Practices above are drawn from those.
- **Temperature is not discussed** for the GPT-5.x models in any guide read. MiniMax publishes recommended sampling values and Anthropic rejects non-default ones on several models, so sampling cannot be carried across families in a shared template.
- **Codex model access follows the sign-in**, not the API model list: the ChatGPT sign-in lists the GPT-5.6 family plus `gpt-5.3-codex-spark` for Pro, and both sign-in methods reach `gpt-5.5`. The maker's Codex models page is the authority.

Source: vendor, https://developers.openai.com/api/docs/guides/prompt-engineering and https://learn.chatgpt.com/docs/models

<!-- RESPAWNPACK SPINE · lands as docs/reference/models/capability-register.md -->
# Model capability register

**As of 2026-09-03. Re-verify after 2026-10-03.** Across the three families a lineup change landed roughly every two to three weeks through 2026, so this document has an expiry date rather than a "last updated" line, and any vendor launch invalidates the entries it touches.

This is the reader's copy of `capability-register.json` beside it. The JSON is what a router reads; this file is what a person reads. They carry the same thirteen models and the same eight task classes, and a test in the pack fails if the two ever stop naming the same set.

**Why it exists.** Orchestration rule 5 tells you to set the model tier explicitly on every dispatch, and names three tiers and no models. So every dispatch has been choosing by habit, or by whatever the operator last read on a launch page. This register is what a choice can rest on instead.

**What makes it different from a table someone typed.** A rating is a claim about a model, and here a claim rests on a source or it does not get made. `preferred` and `capable` cannot be written without at least one URL, the date it was read, and the sentence that source actually supports. Everything else is `unproven`, with no citations at all and a stated gap. The schema makes the other shapes impossible to spell and the pack's schema suite checks this register against it on every run.

The evidence base is a dated research file that ships with the pack beside this register's source, `spine/reference/models/capability-evidence.md` (not installed into a project), in which every claim carries a URL and an access date. Anything that file marks unverified, meaning it was seen only in a search-engine summary or on a page that could not be fetched, is absent from this register entirely. Several widely quoted benchmark figures are in that category and are not here.

## How to read a rating

| Rating | What it means |
|---|---|
| **preferred** | A dated source names this task for this model and no better-evidenced option was found. It does not mean "the winner": where two makers each publish their own table, the register says so. |
| **capable** | A dated source supports the model for this task, usually the maker's own positioning, with no measurement outside the maker or with a caveat recorded beside it. |
| **unproven** | No dated source that supports a rating was found. It is not a low score. Sometimes the model is documented for something else, sometimes nobody has published a measurement of that class for any current model at all. |

Three things a rating never encodes: price alone, popularity, and anything a live probe would tell you. Nothing here has been run on this machine. Every entry's `probes` list is empty, and a bounded live probe per model is the owner's own action.

## Reaching each family

| Family | How the pack reaches it | Credential | Prompting practice |
|---|---|---|---|
| Anthropic Claude | The Claude Code CLI the operator is already signed in to, driven through the pack's host adapter. | The host's own session. The pack never authenticates. | `docs/reference/models/prompting-anthropic.md` |
| OpenAI | The Codex CLI, signed in by the operator with `codex login`. | The operator's own account sign-in, performed by them. | `docs/reference/models/prompting-openai.md` |
| MiniMax | The OpenAI-compatible endpoint at `https://api.minimax.io/v1`. | A value read from the environment variable named `MINIMAX_API_KEY` at call time, never stored, logged or echoed. | `docs/reference/models/prompting-minimax.md` |

For a model no family here profiles, the fallback is `docs/reference/models/prompting-general.md`, which carries only practices at least two of the three makers state and the third does not contradict.

**Hook-bearing work stays on Claude Code whatever this register says.** The hooks are the anti-drift core and no other provider runs them. What can move is a bounded, hookless unit of work: a review lens, a research read, a bulk summary.

**The credential rule, in one line.** The only credential this register names is a variable NAME. No key, token, account name or session value appears in this file, in the JSON, in the pack's configuration, or in anything the pack writes. The schema declares no property a value could be written into, and the pack's own secret patterns are run over these files inside the test suite.

## The register at a glance

**P** preferred · **C** capable · **?** unproven, meaning no dated source was found.

| Model | Family | Status | coding | review | security-testing | long-context | planning | writing | research | extraction |
|---|---|---|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | Anthropic | current | **P** | C | C | C | C | **P** | C | ? |
| `claude-opus-5` | Anthropic | current | **P** | **P** | C | C | **P** | C | ? | ? |
| `claude-sonnet-5` | Anthropic | current | C | ? | ? | C | C | C | C | C |
| `claude-haiku-4-5-20251001` | Anthropic | current | C | ? | ? | ? | ? | ? | ? | **P** |
| `claude-mythos-5-1` | Anthropic | restricted | ? | ? | ? | ? | ? | ? | ? | ? |
| `claude-opus-4-6` | Anthropic | legacy | C | ? | C | C | ? | C | C | ? |
| `gpt-5.6-sol` | OpenAI | current | **P** | ? | C | C | C | C | C | ? |
| `gpt-5.6-terra` | OpenAI | current | C | ? | ? | C | ? | ? | ? | ? |
| `gpt-5.6-luna` | OpenAI | current | ? | ? | ? | C | ? | ? | ? | **P** |
| `gpt-5.6-cyber` | OpenAI | restricted | ? | ? | ? | ? | ? | ? | ? | ? |
| `gpt-5.5` | OpenAI | legacy | C | ? | ? | C | ? | C | ? | ? |
| `MiniMax-M3` | MiniMax | current | C | ? | ? | C | C | C | C | C |
| `MiniMax-M2.7` | MiniMax | current | C | ? | ? | ? | C | C | ? | C |

Fifty-five of the hundred and four cells are `unproven`. That is the register working, not failing: two whole columns have no `preferred` in them because nobody has published a measurement, and two models are unrated in every class because a general owner cannot reach them.

## By task class

### coding

Preferred: `claude-fable-5-1`, `claude-opus-5`, `gpt-5.6-sol`. **A tie at the frontier, not a ranking.** The one neutral dated leaderboard found, vals.ai's Terminal-Bench 2.1 on the Terminus 2 harness at 2026-09-01, has them at 85.77%, 85.02% and 84.64%, a 1.2-point spread with a ten-point gap to fourth place. Each maker's own table orders the three differently because each runs its own harness at its own version, and Anthropic's "Terminal-Bench 4.0" and OpenAI's "Terminal-Bench 2.1" are not the same scale. Store the version string with any score you carry forward.

Capable, the value tier: `claude-sonnet-5`, `MiniMax-M3`, `gpt-5.6-terra`, `MiniMax-M2.7`, and the legacy and small entries `gpt-5.5`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`.

Effort matters as much as the model. The makers state it themselves: Sonnet 5 at high is comparable to Sonnet 4.6 at max, and Opus 5 converts additional effort into better results more reliably than earlier models in its line. An effort level carried over from an older model is not the same amount of thinking.

### review

Preferred: `claude-opus-5`, on the most specific review claim any maker publishes about any current model, that it finds real bugs at a high rate per pass with mostly real additional findings, and that the accuracy holds at lower effort. Capable: `claude-fable-5-1`, which names hours-long cross-session review among its gains.

**Everything else here is unproven, and so is the class.** No third-party code-review benchmark covering any current model was found. One tool-level benchmark exists with model figures for an older generation, seen only in search results, and it is excluded. So the two ratings above are the makers' own words, and the honest reading of this column is "one maker has written about review, nobody has measured it".

### security-testing

**No model is preferred here, and that is the finding.** Capable, all of them for vulnerability discovery in source code only: `claude-fable-5-1`, `claude-opus-5`, `claude-opus-4-6`, `gpt-5.6-sol`.

On the publicly available models of both families, exploit development and penetration testing are blocked by design. Anthropic documents a `cyber` refusal category returned as HTTP 200 with `stop_reason: "refusal"`, which a caller checking only the HTTP status will record as a success. OpenAI's public flagship scores 1.5% on the maker's own internal measure of exploit-chain development, authentication bypass and privilege escalation, against 95% for its gated cyber model.

Those capabilities are documented only on restricted models: `claude-mythos-5-1` through Project Glasswing or the Cyber Verification Program, currently only for a set of US organisations, and `gpt-5.6-cyber` through Daybreak Red, by approved enterprise account with SOC 2 Type II or ISO 27001 and mandatory hardware security keys. Both are listed in this register with `status: restricted` and no rating in any class, because a rating nobody can route to is a recommendation that fails at the request.

**On "Opus 4.6 for pentesting".** The maker's own page for that model frames its cyber capability as vulnerability finding under safeguards, points it at finding and patching vulnerabilities in open-source software, and adds that six new cybersecurity probes were built to track misuse. It never recommends the model for penetration testing. Two months after that page, the maker's restricted line reported 83.1% on CyberGym vulnerability reproduction against Opus 4.6's 66.6%. The register records what the source says, which is a different answer from the one the question assumed.

**No MiniMax model has any cyber positioning or evaluation at all.** That is an absence in the sources, not a low score.

### long-context

**No model is preferred here.** No published long-context quality benchmark for any current model was found; the one third-party page that would have carried it returns 404. So this column is window size plus the maker's word, and it is rated that way.

Capable, on a documented window of a million tokens or more: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `MiniMax-M3`. Unproven on window size alone: `claude-haiku-4-5-20251001` at 200K and `MiniMax-M2.7` at 204,800.

Two caveats that bite at the wire. `gpt-5.5` prices prompts over 272K input tokens at 2x input and 1.5x output for the whole session. An open issue on MiniMax's own repository reports its Anthropic-compatible endpoint advertising a 200K window for the 1M-token `MiniMax-M3`, so a client that trusts the advertised metadata compacts at roughly 167K.

The prompting practice for this class agrees across all three makers: long source material first, the question last, and ask for quotes. Anthropic puts a figure on it, up to 30 percent better answers; MiniMax calls it the largest single effect on answer quality.

### planning

Preferred: `claude-opus-5`, which the maker positions for multi-agent coordination with writer-verifier patterns and few cases of subagents overwriting each other's work, and warns delegates readily enough to need capping. Capable: `claude-fable-5-1`, `claude-sonnet-5`, `gpt-5.6-sol`, `MiniMax-M3`, `MiniMax-M2.7`.

No orchestration or subagent benchmark covering any current model was found. The one measured result in this area anywhere in the evidence base is Anthropic's 2025 engineering post on a previous generation, a lead-plus-subagents system beating single-agent Opus 4 by 90.2% on an internal research eval. It is cited in the prompting standard as a pattern and is not counted as evidence for any model here.

`claude-haiku-4-5-20251001` is unproven in this class for a reason worth stating: the maker positions it as the subagent in an orchestration, not the orchestrator. Being delegated to is not a planning claim.

### writing

Preferred: `claude-fable-5-1`, at 1853 on GDPval-AA v2, the highest figure in the only knowledge-work table found. Capable: `claude-opus-5` at 1824 and `claude-sonnet-5` at 1,618 on the same v2 scale, plus `gpt-5.6-sol`, `gpt-5.5`, `MiniMax-M3` and `claude-opus-4-6` on positioning. `MiniMax-M2.7` reports 1495 on GDPval-AA rather than v2, which its maker calls the highest among open-source models and which this register does not rank against the v2 figures.

**Every one of those Elo figures is published by one of the parties being compared.** GDPval-AA v2 is Anthropic's table, and it places OpenAI's flagship at 1711. No neutral writing or documentation benchmark exists in the evidence base. `preferred` in this column means best-evidenced, not independently confirmed.

Two maker caveats to carry into a prompt: Opus 5's written deliverables run long and its effort knob does not reliably change visible length, and GPT-5.6 is more concise by default than GPT-5.5, so brevity instructions written for the older model may now be unnecessary.

### research

**No model is preferred here**, because the three families report three different benchmarks and each reports its own. MiniMax's product page gives `MiniMax-M3` BrowseComp 83.5 against Claude Opus 4.7's 79.3. OpenAI's launch materials, quoted by a named third party, give `gpt-5.6-sol` 53.6 on Agents' Last Exam. Anthropic gives `claude-fable-5-1` higher accuracy on multistep web research with no figure at all, and said of `claude-opus-4-6` in February 2026 that it was better than any other model on BrowseComp, which was a claim about a February 2026 field.

Capable: `claude-fable-5-1`, `claude-sonnet-5`, `claude-opus-4-6`, `gpt-5.6-sol`, `MiniMax-M3`. `claude-opus-5` is unproven here, and the reason is instructive: its maker's pages name coding, review, multi-agent coordination, long context and office tasks, and say nothing about web research. An absence in the maker's own material is recorded rather than filled in from the model beside it.

One prompting note: Fable 5.1 at low effort is less likely to call a search or retrieval tool, so raise the effort or add the verification instruction rather than assuming the model will look things up.

### extraction

Preferred: `claude-haiku-4-5-20251001`, which its maker lists for real-time applications, high-volume intelligent processing and cost-sensitive deployments at $1/$5 per million tokens, and `gpt-5.6-luna`, which its maker describes as optimised for cost-sensitive workloads and cut in price by 80% on 2026-07-30. Capable: `MiniMax-M3` and `MiniMax-M2.7` at $0.30/$1.20 per a named third party, and `claude-sonnet-5`, which carries the most direct extraction sentence any maker publishes but at twice Haiku's price.

**No classification or extraction benchmark covering any current model was found.** This column is price, latency and positioning. `preferred` here means best-positioned for the workload, and nothing about accuracy.

Two mechanical notes: Anthropic recommends structured outputs or a tool enum for classification rather than a prefill, which returns a 400 from the 4.6 generation on; MiniMax's own guidance is to turn deep reasoning off for extraction, rewriting and formatting.

## By model

Each entry gives the maker's own positioning, then one line per class that carries a rating, then the classes left unproven. Every source below was accessed on 2026-09-03. Full citations, including the exact claim each source supports, are in `capability-register.json`.

### Claude Fable 5.1 · `claude-fable-5-1`

Anthropic, current, 1,000,000-token window, 128,000 maximum output. Maker's positioning: "For demanding reasoning and long-horizon agentic work" (vendor, https://platform.claude.com/docs/en/models/fable-5-1/overview, which marks it "Latest. Released September 1, 2026.").

- **coding, preferred.** Multi-file features, large refactors and migrations, debugging and hours-long review (vendor, https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1). Terminal-Bench 4.0 55.8% and CursorBench 3.2.0 73.4% (vendor, https://www.anthropic.com/claude-fable-and-mythos-5-1, September 2026). Terminal-Bench 2.1 85.02%, second (third-party, https://www.vals.ai/benchmarks/terminal-bench-2-1, 2026-09-01).
- **review, capable.** "Code review across sessions that run for hours", maker's word only (vendor, the what's-new page above).
- **security-testing, capable.** Can discover software vulnerabilities "though not to develop exploits for them" (vendor, the announcement above). The `cyber` refusal category is documented (vendor, https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
- **long-context, capable.** Reasoning across the full 1M window (vendor, the what's-new page), no measured quality figure anywhere.
- **planning, capable.** The maker's guidance is to let the lead agent keep working while subagents run.
- **writing, preferred.** GDPval-AA v2 1853, top of the maker's own table; document, spreadsheet and slide work named in the positioning.
- **research, capable.** Higher accuracy on multistep web research, no figure published.
- **extraction, unproven.** No positioning, no evaluation, and at $10/$50 per million tokens outside the tier this class is about.

Notes: thinking is adaptive and always on, depth set with `effort` (default `high`); non-default `temperature`, `top_p` and `top_k` are rejected and so is a forced `tool_choice`; history must be append-only, and an edited prefix including a rewritten thinking block is a 400; summaries may reproduce source passages without marking them as quotations.

### Claude Opus 5 · `claude-opus-5`

Anthropic, current, 1,000,000-token window, 128,000 maximum output. Maker's positioning: "For complex agentic coding and enterprise work" (vendor, https://platform.claude.com/docs/en/models/opus-5/overview, "Latest. Released July 24, 2026.").

- **coding, preferred.** A step change over Opus 4.8 at half Fable 5's cost (vendor, https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5); Terminal-Bench 2.1 84.64% (third-party, vals.ai, 2026-09-01).
- **review, preferred.** High precision and recall, mostly real findings, accuracy holding at lower effort (vendor, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).
- **security-testing, capable.** Finds vulnerabilities; "remains behind Mythos 5 on cybersecurity tasks"; exploit generation and penetration testing blocked (vendor, https://www.anthropic.com/news/claude-opus-5, 2026-07-24).
- **long-context, capable.** 1M window as both default and maximum, with consistent instruction following throughout it (vendor, the what's-new page).
- **planning, preferred.** Teams of subagents with writer-verifier patterns; delegates readily enough to need capping (vendor, the what's-new and prompting pages).
- **writing, capable.** "Office and document tasks"; GDPval-AA v2 1824.
- **research, unproven.** The maker's pages for this model name no web-research capability at all.
- **extraction, unproven.** No positioning, no evaluation, and outside the cost-sensitive tier.

Notes: written deliverables run long and effort does not reliably change visible length, so state the length in the output contract; remove "double-check" and "use a subagent to verify" instructions, which the maker reports cause over-verification here; prefer thinking enabled at low effort over disabling it, since tool calls can leak into text with thinking off.

### Claude Sonnet 5 · `claude-sonnet-5`

Anthropic, current, 1,000,000-token window, 128,000 maximum output. Maker's positioning: "The best combination of speed and intelligence" (vendor, https://platform.claude.com/docs/en/models/sonnet-5/overview, "Latest. Released June 30, 2026.", a drop-in upgrade for Sonnet 4.6).

- **coding, capable.** "The most agentic Sonnet model yet" (vendor, https://www.anthropic.com/news/claude-sonnet-5, 2026-06-30); Terminal-Bench 2.1 80.4 and SWE-Bench Pro 63.2 (third-party, https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained, 2026-06-30).
- **long-context, capable.** 1M window (vendor, models overview); no quality statement for this model.
- **planning, capable.** Makes plans, uses browsers and terminals, runs autonomously; Humanity's Last Exam 46.8% with tools.
- **writing, capable.** GDPval-AA v2 1,618 (third-party, Vellum).
- **research, capable.** Improved BrowseComp cost-performance across effort levels, no figure published.
- **extraction, capable.** "Structured extraction, and pipelines" named by the maker (vendor, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5).
- **Unproven: review** (the maker's only review text for this model is a harness migration caveat, not a capability claim) **and security-testing** (no cyber positioning, and the refusals documentation does not name this model).

Notes: non-default `temperature`, `top_p` or `top_k` return a 400; medium here is comparable to Sonnet 4.6 at high, and high to 4.6 at max; remove periodic self-summarisation instructions such as "after every 3 tool calls, summarize progress".

### Claude Haiku 4.5 · `claude-haiku-4-5-20251001`

Anthropic, current, a window of 200,000 tokens, 64,000 maximum output. The alias `claude-haiku-4-5` resolves to this pinned id. Maker's positioning: "The fastest model with near-frontier intelligence" (vendor, https://platform.claude.com/docs/en/models/haiku-4-5/overview, released 2025-10-15, retirement not sooner than 2026-10-15).

- **extraction, preferred.** "Real-time applications, high-volume intelligent processing, cost-sensitive deployments needing strong reasoning, sub-agent tasks" at $1/$5 per million tokens (vendor, https://platform.claude.com/docs/en/about-claude/models/choosing-a-model).
- **coding, capable.** SWE-bench Verified 73.3%, Terminal-Bench 41.75% with thinking (vendor, https://www.anthropic.com/news/claude-haiku-4-5, 2025-10-15), on benchmark versions the current lineup no longer reports.
- **Unproven: review, security-testing, long-context, planning, writing, research.** The review figure that exists for this model was seen only in search results and is excluded; the window is a fifth of the class it would compete in; and the maker positions it as the subagent, not the orchestrator.

Notes: extended thinking is manual here (a `budget_tokens` budget), not the adaptive `effort` knob the 5-generation models use; for classification prefer structured outputs or a tool enum over a prefill, which returns a 400 from the 4.6 generation on.

### Claude Mythos 5.1 · `claude-mythos-5-1`

Anthropic, **restricted**, 1,000,000-token window, 128,000 maximum output. Maker's positioning: "Claude Mythos 5.1 is identical to Fable 5.1, but it offers more permissive safeguards for vetted individuals and organizations" (vendor, https://www.anthropic.com/claude-fable-and-mythos-5-1, September 2026).

**No rating in any class.** Access runs through Project Glasswing, the Cyber Verification Program for defensive security work, and the Life Sciences Verification Program, and the maker states it is "only available to a set of US organizations". A rating a general owner cannot act on would be a recommendation that fails at the request, so the restriction is recorded instead.

Recorded as facts rather than ratings: the maker calls it the strongest cyber capability it has released; Terminal-Bench 4.0 60.9%, the highest figure in its own table; and its own words on the risk, that Mythos-class models "excel at discovering and exploiting software vulnerabilities. They can thus make cyberattacks substantially easier and cheaper to commit."

### Claude Opus 4.6 · `claude-opus-4-6`

Anthropic, **legacy**, 1,000,000-token window, 128,000 maximum output. The maker marks it "Legacy. Released February 5, 2026." with retirement not sooner than 2027-02-05 (vendor, https://platform.claude.com/docs/en/models/opus-4-6/overview).

- **security-testing, capable.** "Finds real vulnerabilities in codebases better than any other model", evaluated on CyberGym, framed as accelerating defensive use and patching open-source software (vendor, https://www.anthropic.com/news/claude-opus-4-6, 2026-02-05). Two months later the restricted line reported CyberGym 83.1% against this model's 66.6% (vendor, https://anthropic.com/glasswing, 2026-04-07).
- **coding, capable.** SWE-bench Verified 81.42% with prompt modification, top Terminal-Bench 2.0 at the time.
- **long-context, capable.** 1M window, a beta at launch.
- **writing, capable.** GDPval-AA against a model no longer in either lineup.
- **research, capable.** Better than any other model on BrowseComp *as of February 2026*, and MCP Atlas 62.7% at high effort.
- **Unproven: review, planning, extraction.**

Notes: this is the owner's example, recorded as the sources actually read. "Opus 4.6 for pentesting" is not a maker recommendation. On the publicly available models of both families, exploit development and penetration testing are classifier-blocked and are documented only on the restricted models. A further cyber claim about this model, best results in 38 of 40 blind-ranked investigations, appears only in search results against a system card that could not be fetched, and is recorded nowhere in this register.

### GPT-5.6 Sol · `gpt-5.6-sol`

OpenAI, current, 1,050,000-token window, 128,000 maximum output, knowledge cutoff 2026-02-16. The alias `gpt-5.6` resolves here. Maker's positioning: "Flagship model for complex professional work" (vendor, https://developers.openai.com/api/docs/models).

- **coding, preferred.** "Built for frontier reasoning and long-horizon agentic work", claimed state of the art on Terminal-Bench 2.1 (vendor, https://community.openai.com/t/introducing-gpt-5-6-series-sol-terra-and-luna-coming-july-9-10am-pt/1384931, 2026-06-26); 85.77%, first, on the neutral harness (third-party, vals.ai, 2026-09-01).
- **security-testing, capable.** "Strongest capability for complex coding, computer use, research, and cybersecurity" among Codex's models (vendor, https://learn.chatgpt.com/docs/models); competitive on ExploitBench at roughly a third of the output tokens. Ceiling documented: 1.5% on the maker's own advanced-cybersecurity completion measure.
- **long-context, capable.** 1,050,000-token window (vendor, https://developers.openai.com/api/docs/models/gpt-5.6-sol).
- **planning, capable.** Multi-agent subagent coordination in the Responses API, a beta (vendor, https://developers.openai.com/api/docs/guides/latest-model).
- **writing, capable.** "Complex professional work"; the only cross-family knowledge-work figure is the competitor's, at 1711.
- **research, capable.** Agents' Last Exam 53.6 (third-party quoting the maker, https://simonwillison.net/2026/Jul/9/gpt-5-6/, 2026-07-09). A widely quoted BrowseComp figure for this model was found only in search results and is excluded.
- **Unproven: review** (no maker page names it; Codex's "Guardian review" is a product entry, not an evaluation) **and extraction** (the maker names Luna for that workload).

Notes: `reasoning.effort` runs none, low, medium (default), high, xhigh, max, with max reserved for the hardest quality-first work; pricing at the time of reading was $4/$20 per million tokens promotionally through at least 2026-11-21, cached input $0.40.

### GPT-5.6 Terra · `gpt-5.6-terra`

OpenAI, current, 1,050,000-token window, 128,000 maximum output. Maker's positioning: "GPT-5.6 model that balances intelligence and cost" (vendor, models page).

- **coding, capable.** "GPT-5.5-competitive performance at 2x lower cost" (vendor, the staff announcement, 2026-06-26), with no benchmark of its own.
- **long-context, capable.** Same 1,050,000-token window as the rest of the family.
- **Unproven: review, security-testing, planning, writing, research, extraction.** The maker's agentic, cyber and cost-sensitive statements for this generation name Sol or Luna, not this model.

Notes: launch pricing reported by a named third party was $2.50/$15 per million tokens, cut 20% on 2026-07-30; the post-cut figure was not confirmed against a maker page and is not stated here.

### GPT-5.6 Luna · `gpt-5.6-luna`

OpenAI, current, 1,050,000-token window, 128,000 maximum output. Maker's positioning: "GPT-5.6 model optimized for cost-sensitive workloads", the "fastest, most affordable member of the family" (vendor, models page and staff announcement).

- **extraction, preferred.** The maker's own positioning, plus an 80% price cut recorded in the API changelog on 2026-07-30 (vendor, https://developers.openai.com/api/docs/changelog).
- **long-context, capable.** The cheapest million-token window in this register, which is the whole of the claim.
- **Unproven: coding, review, security-testing, planning, writing, research.** The maker publishes no capability claim for this model beyond speed and price.

Notes: launch pricing reported by a named third party was $1/$6 per million tokens; the post-cut price was not confirmed, so this register carries the cut and not a price.

### GPT-5.6 Cyber · `gpt-5.6-cyber`

OpenAI, **restricted**, no context-window or output specification published on the pages read. Maker's positioning: "Most advanced cybersecurity model for authorized vulnerability research" (vendor, models page, listed beside the `gpt-daybreak-red-latest` and `gpt-daybreak-blue-latest` aliases, introduced 2026-08-07).

**No rating in any class.** Access is the Daybreak Red programme: an application, SOC 2 Type II or ISO 27001, mandatory hardware security keys, and approved enterprise accounts only. Daybreak Blue is the second tier, `gpt-5.6-sol` with adjusted safeguards for defensive tasks.

Recorded as a fact rather than a rating: a named third party reporting the maker's statements gives an internal advanced-cybersecurity completion rate of 95% for this model, against 57.3% for GPT-5.5-Cyber and 1.5% for the public flagship, measured over exploit-chain development, authentication bypass and privilege escalation.

### GPT-5.5 · `gpt-5.5`

OpenAI, **legacy**, 1,050,000-token window, 128,000 maximum output, knowledge cutoff 2025-12-01, snapshot `gpt-5.5-2026-04-23`. Reachable from either Codex sign-in method, which is why it is still listed while `gpt-5.4` and `gpt-5.4-mini`, retired from Codex on 2026-08-31, are not.

- **coding, capable.** Understands complex goals, uses tools, checks its work, and uses significantly fewer tokens for the same Codex tasks (vendor, https://community.openai.com/t/gpt-5-5-is-here-available-in-the-api-codex-and-chatgpt-today/1379630, 2026-04-23); Terminal-Bench 2.0 82.7% (third-party, https://en.wikipedia.org/wiki/GPT-5.5, citing the maker).
- **long-context, capable.** 1,050,000 tokens, with prompts over 272K input tokens priced at 2x input and 1.5x output for the whole session.
- **writing, capable.** Outperforms GPT-5.4 on documents, spreadsheets and slide decks, a comparison against a retired model.
- **Unproven: review, security-testing, planning, research, extraction.** The maker's cyber offering for this generation is GPT-5.5-Cyber, a separate limited-preview variant, not this model. Widely quoted SWE-bench figures for this model appear only in search results and are excluded.

Notes: `reasoning.effort` runs none through xhigh here, one level short of the GPT-5.6 family's max.

### MiniMax-M3 · `MiniMax-M3`

MiniMax, current, 1,000,000-token window, no maximum-output figure published on the pages read. Maker's positioning: "Latest M-series language model for agentic reasoning" (vendor, https://platform.minimax.io/docs/release-notes/models, 2026-06-01); the product page adds "Up to 1M tokens with guaranteed minimum of 512K tokens".

- **coding, capable.** "Frontier-level performance on specialized tasks such as coding"; SWE-Bench Pro 59.0%, Terminal-Bench 2.1 66.0% (vendor, https://www.minimax.io/blog/minimax-m3, 2026-06-01); SWE-bench Verified 80.5 on the model card.
- **long-context, capable.** 1,000,000 tokens against 204,800 for every other model on the same page.
- **planning, capable.** MCP Atlas 74.2%, suited to complex reasoning and agentic tasks with thinking enabled.
- **writing, capable.** Strong on office workflows such as search and Office-suite tasks.
- **research, capable.** BrowseComp 83.5 against Claude Opus 4.7's 79.3 (vendor, https://www.minimax.io/models/text/m3).
- **extraction, capable.** $0.30/$1.20 per million tokens with an 80% cache discount at 89.9 tokens per second (third-party, https://artificialanalysis.ai/models/minimax-m3); the maker's own guidance is to turn thinking off for extraction, rewriting and formatting.
- **Unproven: review and security-testing.** No MiniMax model has any cyber positioning or evaluation at all.

Notes: recommended sampling is temperature 1.0 and top_p 0.95; an open, unanswered issue on the maker's repository reports the Anthropic-compatible endpoint advertising a 200K window for this model; rate limits are 200 requests and 10,000,000 tokens per minute; the maker's token-plan page and its M3 blog give different subscription prices for the same tiers.

### MiniMax-M2.7 · `MiniMax-M2.7`

MiniMax, current, 204,800-token window, no maximum-output figure published. Maker's positioning: "M2.7 is our first model deeply participating in its own evolution", positioned for "Agent Teams, complex Skills, and dynamic tool search" (vendor, https://www.minimax.io/news/minimax-m27-en, 2026-03-18).

- **coding, capable.** SWE-Pro 56.22% described as matching GPT-5.3-Codex, Terminal Bench 2 57.0%, SWE Multilingual 76.5.
- **planning, capable.** Agent Teams positioning, Toolathon 46.3%, MLE Bench Lite medal rate 66.6%.
- **writing, capable.** GDPval-AA Elo 1495, which the maker calls the highest among open-source models.
- **extraction, capable.** $0.30/$1.20 per million tokens at 77.6 tokens per second (third-party, https://artificialanalysis.ai/models/minimax-m2-7), with a `MiniMax-M2.7-highspeed` variant accepted on the same interface.
- **Unproven: review, security-testing, long-context** (204,800 tokens, and a third party states even that is the combined input-plus-output total, which could not be confirmed) **and research.**

Notes: recommended sampling is temperature 1.0, top_p 0.95, top_k 40; a named third-party benchmarking service marks this model deprecated for its own purposes, so its third-party figures will stop moving; rate limits are 500 requests and 20,000,000 tokens per minute.

## What this register does not say

- **Nothing here has been measured on this machine.** Every `probes` list is empty. A bounded live probe per model spends tokens and is the owner's action.
- **No routing reads it yet.** The routing policy that consumes it is a separate task; today this register is a document and a schema, and nothing chooses a model from it.
- **The models MiniMax also accepts are absent.** `MiniMax-M2.5`, `MiniMax-M2.1` and `MiniMax-M2` remain callable on both of the maker's interfaces, and no maker page with a dated capability claim for them was found. A status invented here would read exactly like one the maker published.
- **Claude Opus 4.8 is absent as an entry** and named only as what it is documented to be: one of the two permitted server-side fallback targets when Claude Fable 5.1 declines a request, alongside Claude Opus 5.
- **Prices move faster than this file.** Three price changes landed across the two commercial families in the eight months before this reading, and one maker publishes two different subscription prices for the same tiers on two of its own pages. Treat every figure here as dated, not current.
- **A benchmark number is only comparable inside its own harness and version.** Anthropic reports "Terminal-Bench 4.0" and "Terminal-Bench-Science 0.1"; OpenAI, vals.ai and Artificial Analysis report "Terminal-Bench 2.1"; the same model scores 85.02% on one 2.1 set-up and 91.4% on another. Carry the version string with any score.

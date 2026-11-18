---
name: wordsmith
description: The writing role — edits prose and spoken scripts to be clear, specific, honest, and human: strips AI-slop (filler, inflated significance, decorative vocabulary, fabrication) while preserving meaning and voice. Covers docs, copy, and scripts. Quality editing, not authorship detection.
when_to_use: "wordsmith", "proofread", "copyedit", "edit this", "rewrite this", "writing review", "review this writing", "review the copy", "polish the docs", "make this read better", "deslop", "humanize this", "does this sound AI", "/wordsmith", "/proofread", "/copyedit"
disable-model-invocation: true
---

# /wordsmith — human-first writing and editing

Make prose read as if a real person chose every word: clear, specific, honest, and fit for its audience and medium. Applies the writing standards in `docs/reference/writing-standards.md`, the full doctrine and taxonomy, treated as the **default a project overrides**, not the last word.

**This is quality editing, not an AI detector.** Do not claim a phrase, punctuation mark, or readability score proves who wrote something. Diagnose whether the text is clear, honest, specific, audience-fit, and worth the reader's time. The goal is to remove friction and artificial polish while keeping the thought, expertise, and voice the piece needs.

## Standards precedence (a project's own rules win)
The shipped `docs/reference/writing-standards.md` is the **default**. A project states its house style in a versioned rules file, and where a rule there contradicts the shipped standard, **the project's rule wins**. Load project rules from two locations and no others: `docs/reference/wordsmith-rules.md` and any `.claude/rules/writing*.md` (the host also loads the latter as instructions). When more than one is present, the file with the highest `version:` frontmatter (or a `Version:` line) wins; a file with no version is still applied but is reported as **unversioned** and loses to any versioned file. A rules file anywhere else is ignored; if the user points at one outside the two locations, name it and say it was ignored rather than loading it. With no project rules file present, the shipped standard applies and you say so.

The three enforcement mechanics a project rules file should carry (the field built these; the pack ships the shape, not a gate):
1. **A versioned rule file** whose `version:` grows with every rule change, so a stale copy is visible.
2. **A `[script]`, `[reader]` or `[both]` tag on each rule.** A `[script]` rule is mechanical (a banned character, a required header) and can be gated by a project script the user runs (in `ops/` or the project's own tooling); the pack ships no such script, so a `[script]` rule with no gate wired is reported as **unenforced**, never silently treated as caught. A `[reader]` rule needs a read; `[both]` needs both.
3. **A different-agent reader pass before sign-off**: the writer never signs off its own prose (see the final audit).

The pack writes a confirmed rule into that file for you: `respawnpack memory candidates promote <id> --as rule/<slug> --by "<who>" --tag script|reader|both` appends the rule under `## Rules` and bumps the `version:`, choosing the highest-version file among the two locations (the same precedence you load by); rejecting that candidate removes the line again and records it under `## Withdrawn rules` (no rule text, never an instruction to apply); a hand edit that bumps the version with no confirmed candidate behind it is flagged by `doctor`'s `rules:version-ahead` row, so the file you load is the one the gate audited.

## Step 1 — Build the brief, and announce the precedence
Infer these privately from the task; do not stall a clear job with questions. Audience (who, what they already know), medium (reading or spoken), objective (understand, decide, do, feel), stakes (casual, commercial, technical, legal, medical, emotional), required facts (claims, sources, names, numbers, quotes that must survive), voice (direct, warm, expert, cinematic, plain), and the real attention budget. With no audience or tone given, default to a competent general reader and plain, direct, calm language.

**Print which standard you applied.** Before editing, state the precedence you resolved: which project rules file(s) you loaded and each one's version (or "unversioned"), or "no project rules file; applying the shipped writing-standards.md". The reader must be able to see which rule won.

## Step 2 — Pick the mode
Reading text and spoken text obey different rules (writing-standards.md, "The two modes").
- **Reading text** (docs, README, web copy, report): lead with the point, one job per paragraph, active verbs, visible logic, end on a consequence not a recap.
- **Spoken text** (script, narration, video, talk): write for one-time hearing, short clauses, subject and action early, repeat key nouns, read it aloud and fix every stumble.
Do not edit a script like a white paper or a web page like narration.

## Step 3 — Diagnose
Mark only patterns that hurt clarity, credibility, originality, rhythm, or audience fit. The full taxonomy is in the standard; the highest-yield ones to scan for:
- throat-clearing before the point, and recap conclusions that add nothing;
- high polish with low specificity (no actor, number, example, or consequence);
- inflated significance and promotional praise with no proof ("transformative", "world-class");
- decorative vocabulary ("delve", "leverage", "robust", "seamless", "multifaceted");
- empty contrast ("it's not just X, it's Y"), rule-of-three habit, synonym cycling;
- nominalization and noun piles; templated structure and markdown leakage;
- vague attribution, over-hedging, fake balance, sycophancy, manufactured drama;
- chatbot residue ("Great question", "I hope this helps", "Here is your");
- clichés and stock metaphors; repetition without escalation;
- and the one that does real harm: fabricated facts, citations, quotes, or links.

## Step 4 — Rewrite for human preference
- Concrete before abstract: person or thing, then action, then result, then interpretation.
- Replace announcement with proof: do not call a thing important, powerful, or efficient unless the next sentence proves it.
- Create movement: each paragraph should do something new (reveal a fact, sharpen a problem, show a consequence, answer a question, give an example).
- Calibrate certainty to evidence; avoid both empty caveats and false confidence.
- Preserve useful repetition (a key term for clarity, a key phrase for memorability); cut only repetition that adds nothing.
- Preserve the author's meaning, required facts, and effective voice. Never invent authenticity (no fake stories, fake uncertainty, typos, or staged emotion).

## Step 5 — Run the editing passes (in order)
Truth and evidence, then reader value, then compression, then voice and rhythm, then a medium audit (read spoken drafts aloud). Details in writing-standards.md, "Editing passes".

## Step 6 — Fact and trust audit
Verify every claim that affects trust, money, health, reputation, legal rights, safety, or a public decision: names, dates, statistics, quotations, citations, links, and identifiers, and that each source supports the exact claim it follows. Strip raw tool citations, placeholder links, markdown artifacts, and assistant residue. For a deep factual pass on a research-heavy piece, fan out verifier Agents (one per claim cluster) and default each to "unsupported until shown otherwise".

## Final audit
Run the checklist in writing-standards.md, "The final audit" (point, specificity, accuracy, economy, voice, rhythm, evidence, medium, hygiene, ending). If three or more checks fail, rewrite the section from its core point rather than patching sentences.

**The reader pass runs in a different agent.** Before sign-off, dispatch a reader pass to a separate subagent (the Agent tool) with the project rules file as its brief, so the writer never signs off its own prose. The reader reports pass or fail per `[reader]` and `[both]` rule; a `[script]` rule it sees no wired gate for is reported unenforced, not assumed caught.

## Output behavior
Deliver the finished text first, unless the user asks for analysis or a change log. Do not narrate the edits, open with a preamble, or close with a chatbot sign-off. When revising, make the minimum changes needed for truth, clarity, rhythm, and audience fit, and flag only material factual gaps, not every stylistic tweak.

## Invariants
- Quality editing, never an authorship verdict. No single "tell" proves AI authorship.
- Verify before beautifying. A fluent false claim is worse than a rough true one; never fabricate facts, sources, or quotes.
- Preserve the author's meaning and real voice; do not flatten into generic professional prose.
- Never invent authenticity (fake stories, fake imperfections, staged emotion).
- Match the medium: reading text and spoken text are edited by different rules.

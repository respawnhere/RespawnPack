---
name: aar
description: The after-action role — runs `respawnpack aar` for a window, reads the written report back, and proposes the human NOTE that goes at its foot. It composes nothing itself: every section comes from records the kernel already keeps, and a candidate stays an unverified lead. Command-only; the NOTE is proposed for the human, never auto-written.
when_to_use: "/aar", "after action report", "what happened this phase", "aar this run", "write up this window"
disable-model-invocation: true
---

# /aar — the After Action Report for a window of work

The kernel composes the report; this role runs it, reads it, and writes the one thing a machine cannot:
what a person should take away. Everything factual in the document comes from records that already
existed — the compiled state at each end of the window, the commits, the derived changelog, and the
machine-local savepoint receipt, candidate journal and delegation archive. Nothing here re-derives a
number, and nothing here promotes a lead.

`contract complete goal` already writes one on a successful close, so this role is for the windows a
goal closure does not name: the end of a phase, the end of a run, the morning after.

## Step 1 — Compose it, and look at it before writing anything

```bash
node .claude/respawnpack/respawnpack.js aar
```

Preview is the default: this prints the document and creates nothing. Read the window line first — the
report states which rule chose each end (`--since`, the last report's end, the savepoint-only chain's
base, or the root commit) — and re-run with `--since <rev>` / `--until <rev>` if that is not the window
you meant. `--title "<what this phase was>"` names it; the slug in the filename comes from that title.

## Step 2 — Write it

```bash
node .claude/respawnpack/respawnpack.js aar --title "<what this phase was>" --write
```

It lands at `docs/derived/aar/<until-date>-<slug>.md`. If a report already exists at that path the verb
**refuses at exit 2 and names it** rather than overwriting: a report records what was known at a moment,
and a second opinion about the same window belongs in a second file. Pick a different title or window.

## Step 3 — Read the report back, then propose the NOTE

Open the file you just wrote. Read the generated block, in this order:

1. **Bottom line** — does it match what you understand happened? If it does not, the window is wrong,
   not the paragraph; re-cut it rather than arguing with the composition.
2. **Owner actions** — every input the composition could not read. These are the report's known gaps.
3. **WITHHELD counts** — an end whose committed `STATE.json` did not describe its own revision has no
   numbers here on purpose. Do not go and fetch them from somewhere else to fill the hole.
4. **Candidates** — each one is an `UNVERIFIED LEAD` unless the journal records it promoted. Promotion
   is `respawnpack memory candidates promote <id> --as <type>/<slug> --verified-by "<what proved it>"`,
   it is a separate deliberate act, and this role never performs it.

Then **propose** the NOTE block's text to the human and let them accept it. The NOTE is the one part of
the document a person owns; writing it for them turns the report into a machine talking to itself. Keep
it to a few sentences: what this window was really about, what surprised you, what the next window
should start with.

## Invariants

- **Compose, never conclude** — the verb copies from records; this role reads them and adds a human
  reading. Neither one evaluates a criterion or decides an outcome.
- **The NOTE is proposed, never auto-written** — user sovereignty, the same rule that governs every
  canonical spine edit (`skills/README.md` shared principle 2).
- **A candidate stays an unverified lead** — reading one in a report is not promoting it, and this role
  has no promotion step.
- **Withheld is withheld** — a count the report declines to print is not to be sourced from elsewhere
  and pasted in. The withholding is the finding.
- **Never overwrite a report** — the refusal at exit 2 is the contract; a second window gets a second
  file.

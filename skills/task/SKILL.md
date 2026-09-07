---
name: task
description: The fresh-session delegate role for one bounded task-runner item — a thin skin over contract delegate, never a second state machine. Refuses a vague brief, boots the same anti-drift sequence, and closes only by attesting each criterion.
when_to_use: "/task", "task runner", "run the task queue", "next queued task", "dispatch this task"
---

# /task — one bounded delegation, fresh session, attested and stopped

The playbook a fresh session runs for exactly one bounded unit of work, whether a task-runner spawned
that session or a human operator typed `/task` directly. It is deliberately a thin skin over the
`contract delegate` mechanism every session already has (`templates/CLAUDE.md`,
[`/respawn`](../respawn/SKILL.md) Step 0b, `spine/reference/behavior-standards.md` §6) — never a second
state machine. The refusals a bespoke task record would need to invent (an empty acceptance list, a
partial attestation) already exist in the kernel and are already load-bearing; reusing them is what
keeps a fresh-session-per-task queue from drifting out of step with every other way this pack tracks
"done."

## The runner this fronts

A dedicated runner drives the queue this skill executes against:
`node adapters/claude-code/task-runner/runner.js --dir <project> [--task <id>] [--dry-run]`. It reads
`docs/derived/state/tasks.json` (the ordered, dependency-aware task list), refuses to start against a
stale `STATE.json`, records `contract delegate --task --acceptance` from the next ready row before it
spawns anything, and runs exactly one fresh headless session per task. That spawned session is what
runs this skill. The runner and this skill are companion pieces of the same phase of work: this skill
is what any session does once it is running — whether the runner spawned it this way or a human
operator invoked `/task` directly with no runner involved at all.

A queue row may also name its `taskClass` (one of `core/policy/routing.js`'s eight classes — coding,
review, security-testing, long-context, planning, writing, research, extraction; a row that names none
routes as `coding`). This never changes which host runs the session — a task session always carries
this pack's hooks (anti-drift item 54), whatever the capability register rates `preferred` for another
family — it only changes which model within that hooked family the session's `--model` is set to,
picked from whichever capability register answered (the target's own installed standards, else this
pack's own, else the host's plain default when neither is available). The chosen route is recorded on
the run's report and on the task-attempt receipt, so a session reading its own dispatch never needs to
guess which model it is; an owner's `--model` on the runner's own command line always wins over it.

## Step 1 — Read the dispatch brief; refuse a vague one

- **If the runner spawned you**, `node .claude/respawnpack/respawnpack.js contract` already reads
  `delegate` — the runner recorded the task's title and acceptance criteria from the matching queue row
  before it spawned this session. That recorded contract **is** your dispatch brief; read it from there
  rather than from conversational text, since nobody said anything to you in this case.
- **If nothing is recorded yet**, a human operator typed `/task` (or asked for this directly) — the
  dispatch brief is whatever they just said: the goal, the exact input paths (not vibes), the output
  contract, and any file-ownership boundary, per `spine/reference/orchestration-patterns.md` rule 2.
- **Either way: no acceptance criteria means no task.** A brief that states a goal but never says what
  "done" looks like is the same ambiguity `behavior-standards.md` §6 refuses to enter goal mode over —
  refuse here for the same reason. Derive the obvious criteria from an otherwise-clear brief; do not
  invent a definition of done from a one-line title, and do not start work while it's missing.

## Step 2 — Record the delegation immediately; never `collaborate`

- **Runner-spawned path:** the contract is already recorded (Step 1). This step is confirming that, not
  re-deriving it — do not re-record the task with your own paraphrase of the criteria. The queue row's
  exact wording is what `contract complete --met` will need restated verbatim later, and a session's
  paraphrase drifting from the runner's original is exactly the kind of two-readers mismatch this pack
  refuses elsewhere.
- **Human-operator path:** record it now, before anything else —
  `node .claude/respawnpack/respawnpack.js contract delegate --task "<title>" --acceptance "<criterion
  1>;<criterion 2>"`.
- Either way, the session is now in `delegate` mode — never `collaborate`, and never `goal`. A task
  session does not inherit standing autonomy and does not grant itself any; it finishes one bounded
  thing and stops.

## Step 3 — Run `/respawn`'s boot, Steps 0 through 3, unchanged

A task session is not exempt from the anti-drift boot. Run [`/respawn`](../respawn/SKILL.md)'s Step 0
(load and validate `STATE.json` before trusting any number in it), Step 0b (confirm the contract —
already `delegate` from Step 2), Step 1 (orient to `PRODUCT.md`/`DECISIONS.md`/`FEATURES-PAGES.md` so
the work doesn't resurrect a ⛔ killed feature), Step 2 (the adoption interview, which self-skips once
`doctor`'s `onboarding` row already reads COMPLETE — expected on any project mature enough to run an
unattended task queue, but confirm it rather than assuming it), and Step 3 (query memory first) exactly
as written. Do not shortcut boot because the task looks small: a stale projection or a re-proposed
killed feature is exactly as costly from a task session as from any other.

## Step 4 — Execute the bounded work, stub first

Do the work the brief scopes, nothing more. Before composing the deliverable in context, write a stub of
it and extend it section by section (`orchestration-patterns.md` rule 9b's field-tested lesson): a
session that dies mid-work after writing once, at the end, leaves nothing recoverable; one that stubs
first leaves a partial, resumable file. Stay inside any `--forbidden` boundary the delegation recorded,
and touch only what the brief's file-ownership boundary named.

## Step 5 — Attest, criterion by criterion — a claim, not a proof

When the work is done, close the delegation by restating every recorded criterion, one `--met` per
criterion:

```bash
node .claude/respawnpack/respawnpack.js contract complete --met "<criterion 1>" --met "<criterion 2>"
```

The kernel refuses the close unless every criterion it recorded at Step 2 is restated here — restating
one you did not actually meet is not a shortcut, it is a false attestation, and the record is archived as
exactly that: "a claim, not a proof." Never write "done" or "complete" in your own returned prose as
though that settled anything; a confident sentence, a clean exit, or running out of turns is never a
completion signal a runner may treat as proof — the recorded `--met` attestation is the only thing
downstream is allowed to trust.

## Step 6 — Report a confirmation line only

Return one line: the deliverable's path plus a one-sentence summary — never the full content
(`orchestration-patterns.md` rule 3). The runner works a queue, one fresh session per item; a session
that pastes its whole output back doesn't scale across that queue any better than it would across a
parallel review wave. If the orchestrating party needs the content, it reads the path.

## Invariants

- **Thin skin over `contract delegate`, never a second state machine** — no new record, no new verbs,
  no parallel notion of "done."
- **No acceptance criteria, no task** — refuse rather than invent a definition of done, in either the
  runner-spawned or the human-operator path.
- **Never `collaborate`, never inferred `goal`** — exactly one bounded delegation, start to finish, and
  it does not become a standing loop.
- **The anti-drift boot is not optional** — `/respawn` Steps 0 through 3 run unchanged, every time.
- **Stub the deliverable first** (rule 9b) — a session that composes in context and writes once leaves
  nothing when it dies before that write.
- **`contract complete --met` is an attestation, not a self-graded pass** — restate only what actually
  happened, once per recorded criterion, and never let prose substitute for it.
- **Report a confirmation line only** — path plus summary, never the full content (rule 3).

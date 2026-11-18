# Knowledge graph conventions

A small, structured graph beats flat notes because you can traverse relations ("what depends on X," "what causes Y") and query by type. Keep it small and high-signal. The goal is recall of hard-won facts.

## Entity types
| Type | Name pattern | Holds |
|---|---|---|
| **Gotcha** | `gotcha:<slug>` | symptom → root cause → fix. The highest-value type. |
| **Infrastructure** | `infra:<component>` | a live component + its facts (endpoint, region, quirks, config truth) |
| **Compatibility** | `compat:<tool>` | version / tooling / platform constraints that bite (e.g. "X breaks on Windows without Y") |
| **Decision (operational)** | `decision:<slug>` | an ops-level call not big enough for `docs/DECISIONS.md` |
| **Hypothesis** | `hyp:<slug>` | an open theory under investigation (promote to Gotcha when confirmed, or delete) |
| **Rule (G15)** | `rule:<slug>` | a confirmed project rule, the correction-to-rule pipeline's output; carries a `ruleTag` (`script`/`reader`/`both`) and is written alongside the project's versioned rules file |

## Relations (typed edges)
`depends-on` · `causes` · `fixed-by` · `supersedes` · `relates-to` · `applies-to`. Use them. They're what makes traversal useful (e.g. `infra:redis depends-on compat:tls-scheme`; `gotcha:matchmaker-race relates-to infra:queue`). The last, **`applies-to|skill:<name>`**, links a lesson/gotcha to the RespawnPack skill it informs. It's the relation `/skill-guard` regenerates a living skill's `## Learned` overlay from (see the living-skills doctrine).

## Observations
Atomic facts attached to an entity, one statement each. A Gotcha typically carries three: the symptom, the root cause, the fix. Add observations to grow an entity over time rather than spawning near-duplicate entities.

## Workflow
- **Query first** (`search_nodes` / grep the index) before investigating, always.
- **Extend, don't duplicate**: `add_observations` on an existing entity when the fact belongs to it; `create_entities` only for a genuinely new thing.
- **Promote/prune**: a confirmed `hyp:` becomes a `gotcha:`; a disproven one is deleted. Stale infra facts get corrected, not stacked.
- **Verify before trusting**: a recalled fact reflects when it was written. Confirm it still holds (file/flag/endpoint still exists) before acting on it.

## Naming
Lowercase kebab slugs, type prefix: `gotcha:redis-tls-mismatch`, `infra:media-plane`, `compat:windows-prisma-dll`. Stable slugs so relations + cross-references survive.

## Seeding
On install, seed the few gotchas the project already knows (from past incidents / the changelog). A graph with 10 real gotchas + the query-first discipline beats an empty one nobody fills.

## One schema, one backend
This is the **canonical statement** of RespawnPack's memory model (linked from [`README.md`](README.md), not restated there). The schema is the knowledge graph on this page: **entities** (`type:slug`) + **observations** + **typed relations**. The pack ships one backend:

**File + grep (no deps).** An entity is `memory/graph/<type>/<slug>.md`: the `type:slug` id maps to `<type>/<slug>.md`, frontmatter carries `aliases` + `relations` (`verb|dst-id`, using the verbs above) + an `asOf` date, and the **body is the observations** (e.g. the `## Symptom` / `## Root cause` / `## Fix` sections of a gotcha), under a `**Klass:** <type>` line naming what the entity IS. Query = grep. The always-available floor, and now the one backend.

**The world-revision binding (G8).** A promoted lesson may also carry three flat frontmatter fields naming the revision of the world it was true in, so "the world moved past it" becomes a detectable signal rather than a thing a reader has to remember: `worldRevisionKind` (`commit` | `docDigest` | `estateRevision`), `worldRevision` (a 40-hex commit sha, a sha256 of a document's CRLF-folded bytes, or an estate serial as a string), and `worldRevisionLocator` (what names the world: empty or the cited paths for a commit, the repository-relative document path for a digest, the repository-relative tracked file whose first non-empty line is the current serial for an estate). Absent fields mean **unbound**; present-but-bad ones (an unknown kind, an empty value, a non-hex commit) are **malformed** and named, never read as current. These stay distinct from an entity that simply has no binding.

Promotion writes all of this from its flags (G7): `**Klass:**` is the `--as` type (the capture klass is kept as a `- captured as: <klass>` provenance line, so nothing is lost); `--relates <verb>|<id>` and `--supersedes <id>` (sugar for `--relates supersedes|<id>`) populate `relations` in the `verb|dst-id` form, with an unknown verb or a malformed id refused by name before anything is written and a well-formed id that names no existing entity accepted but reported (a forward reference is legal); and `asOf` defaults to `promotedAt` or is set with `--as-of <ISO date>`. A repeat promotion to the same target rewrites the same bytes: `relations` and `asOf`, like `promotedAt` and `verifiedBy`, come from the store or the entity already on disk, never from the clock. To change them after the fact, edit the file.

**Retired:** the optional `respawn-memory` engine (a PGLite + pgvector MCP server over these same files) and an MCP memory-server variant are retired with `--with-memory` (decision 33, 2026-10-09). The engine returned an empty recall after every reinstall until a manual sync. The markdown entity files are, and always were, the source of truth; nothing about the schema changes. A promoted lesson is now mirrored into the host's own auto memory (see [`README.md`](README.md)) so a fresh session finds it, and a left-over `memory/.index/` is the retired engine's database, the user's to delete.

Write to the schema. An entity is the same markdown file whether or not anything indexes it.

## Candidates: a lead is not a fact

`/savepoint` automatically captures **candidate memories** — evidence-backed leads, never conclusions
reconstructed from a diff (ADR-001) — into a separate, TRACKED store (`memory/candidates/<id>.json` +
`memory/candidates/audit.jsonl`, `core/memory/candidates.js`), distinct from the graph above. A candidate is
`finding` (a FAIL/CANNOT_DETERMINE savepoint check, or stale evidence, captured automatically) or
`constraint`/`decision`/`root-cause-fix` (an operator-stated `--candidate "kind:text"`, or, for
`root-cause-fix`, the candidate `incident --new` mints in the same call, G17). **A lesson promoted from an
incident's candidate cites the incident id as its provenance and never copies the fix body.** The incident
library (`memory/incidents/<id>.json`) OWNS the signature, cause and fix; the minted candidate's claim
names the incident by id (`root-cause-fix: incident inc_… (<signature>)`) and lists the incident file as
its evidence path, so promotion writes a graph entity that traces back to the one place the fix lives
rather than growing a second copy of it. A candidate or note that carries a fix BODY instead of the id is a
duplicate `doctor`'s `incidents:inlined-fix` row flags. A live goal
constraint is deliberately NOT auto-captured: it already lives durably in `docs/derived/state/goal.json`
and is read by every contract check, so re-minting it would duplicate a known fact rather than record a
lead. It carries provenance
(who/what captured it, which cycle/revision, what evidence backs it) and a `verificationState`:
`candidate` (the default — a lead), `verified` (promoted), or `rejected`.

**Promotion is the only door into this graph**, and it is never automatic: `respawnpack memory
candidates promote <id> --as <type>/<slug> --verified-by "<what proved it>" --by "<who>"` REQUIRES a
stated verification AND an author (an empty either is refused and nothing is written) and writes the
entity above at `memory/graph/<type>/<slug>.md` — the file-backed schema this page documents, with
`promotedFrom`/`verifiedBy` added to its frontmatter so the canonical fact traces back to the candidate
and the verification that earned it. `respawnpack memory candidates reject <id> --why "<reason>" --by
"<who>"` closes a lead that turned out wrong. Both are idempotent and audited
(`memory/candidates/audit.jsonl`): a repeat is a recorded no-op pointing at the first, not a second
promotion or a silently different one.

**Corrections become rules (G15).** A correction an owner states is captured the same way every lead is,
as a `constraint` candidate through `savepoint --candidate "constraint:..."`. Confirming it is a promotion
`--as rule/<slug>`: the usual graph entity is written (its `## Observation` is the rule's text, a
`ruleTag` of `script`/`reader`/`both` on its frontmatter, default `reader`), AND in the same call the
confirmed rule is appended to the project's versioned rules file that the `/wordsmith` and `/review` skills
load (`docs/reference/wordsmith-rules.md`, or a `.claude/rules/writing*.md` scoped with `--paths` so it
costs 0 B at boot) as `N. [<tag>] <text> (rule:<slug>, confirmed v<version>, <candidate id>)`, with the
file's `version:` bumped by one. The kernel writes to the file the skill would load (the highest `version:`
among the two locations, the same precedence), so the loaded text and the written text never disagree. The
write is idempotent by the `(rule:<slug>, confirmed` marker: a repeat adds no second line and no second
bump. It runs under an exclusive rules-file lock, so concurrent promotions each land their own line, and a
rules-file write that fails is `CANNOT_DETERMINE` with the exact command to re-run, never PASS. A rejection
that proceeds withdraws the rule: its confirmed line is removed (one bump) and a text-free
`- rule <n> withdrawn (rule:<slug>, withdrawn v<n>, <id>): <reason>` record goes under `## Withdrawn rules`. A hand
edit is never silently honoured: `doctor` carries `rules:unconfirmed-line` (a confirmation line the store
does not back) and `rules:version-ahead` (a version bumped with no confirmed candidate behind it) as
integrity anomalies, and `rules:unversioned` where a rules file carries no parseable version. What this
does NOT do: the host READS a `.claude/rules/` instruction, it does not enforce it; a `[script]` rule's
gate is the project's own script and its absence is reported, not fixed; the estate's command-pattern stop
(flag a restart in a window at the tool call) is a later opt-in hook, so an operational rule is standing
reader text until then.

⛔ **Every verdict carries an author (G6).** `--by` is as mandatory as `--verified-by`/`--why`: a verdict
with no one on record cannot be reviewed, so a missing or blank `--by` is refused at the CLI and in the
core before anything is written, never defaulted to null. A MACHINE author is a real author: the
savepoint's own automatic rejections (D4's "already recorded" duplicates) pass `by: savepoint`, which
satisfies the rule — the point is that something is on record for every verdict, not that a human typed
it. A legacy record whose verdict predates this rule stays readable and is COUNTED by the ledger below
as `verdicts-without-author`, never silently repaired: an author cannot be reconstructed after the fact.

⛔ **Rejecting a promoted candidate retracts its entity, or refuses — never strands it (G6).** A `reject`
of a candidate whose graph entity is still live is the operator's choice by flag. `--retract` MOVES
`memory/graph/<type>/<slug>.md` to `memory/graph/_retracted/<type>/<slug>.md`, adding `retractedAt`,
`retractedBy` and `retractedReason` to its frontmatter and leaving the body untouched, and removes the
host mirror line through the same reject path; its absence REFUSES the whole rejection naming the entity
file, so a rejection never silently leaves an entity asserting a lesson the store has withdrawn. A
retraction MOVES and MARKS, it never deletes. Relations that OTHER entities carry to the retracted one
are reported as dangling, never rewritten — one rejection does not reach into another entity's file.
`readGraphEntities` still reads `_retracted/` so the ledger can count it, while the register and D4's
qualification rule skip it: a retracted lesson is exactly the thing a fresh lead may legitimately raise.

**A candidate must be a lead, not a copy of a record the project already holds.** When `/savepoint`
captures automatically, a claim it could already recover from a durable record is not minted as a fresh
lead: it is captured and immediately rejected in the same run with the reason naming the record (for
example `already recorded: docs/decisions/D-017-<slug>.md` on a migrated project, `already recorded:
docs/DECISIONS.md D-017` on an unmigrated one, or `already recorded: memory/graph/gotcha/x.md`), so
the audit shows the lead was seen and where it lives, and no reviewer is handed a decision that was
already made. The durable records checked are this graph, the decisions (the `docs/decisions/` shard
when migrated, the `docs/DECISIONS.md` monolith otherwise, a superseded decision excluded), the
removal registry, and the requirement rows in `STATE.json`. Code and tests are deliberately NOT searched:
the pack cannot read them semantically and will not pretend to, so "code and tests" is covered only where
a fact is also an evidence-backed requirement row or a removal. The match is deliberately literal (the
normalised claim equal to, or a long containment of at least forty characters of, a record's text), so a
paraphrased duplicate is still minted and a reviewer rejects it by hand. When the matching record is a
graph entity and the lead carries evidence the entity does not yet cite, the entity grows by one dated
line under `## Observations` instead, and nothing is minted; the canonical first observation and the
frontmatter are untouched. A live goal constraint is handled one layer up (it is not minted at all,
because it is already durable in `goal.json`). A deliberate operator `--candidate` is never filtered: it
is captured exactly as before, with a one-line note naming any record it resembles, because the human
decides.

⛔ **An agent recalling a candidate MUST label it as an unverified lead, every time, with no exception.**
`core/memory/candidates.js`'s `renderForRecall()` is the only rendering path and already prefixes every
unverified item with an `UNVERIFIED LEAD` marker and a "NOT established; verify before relying on it"
qualifier — but any prose summary an agent writes BY HAND (a session note, a savepoint output line, an
answer to "what do we know about X") must carry the same discipline: a candidate is a hypothesis
someone recorded, not project truth, until it has been promoted through the gate above. Presenting a
`candidate`- or `rejected`-state record as settled fact is the exact failure this store exists to
prevent — the same failure the `verificationState` wall is drawn to stop the automatic writer itself
from committing.

## The inbound feedback channel (G16): what leaves a project, and what never does

A project also holds records **about the pack's behaviour** (a defect it hit, a workaround it invented, a
lead it rejected as the pack's problem), distinct from its own knowledge. `respawnpack feedback --export`
packages those so they can reach the dev side **without the project's operational detail**, and
`respawnpack memory candidates import <file>` is the dev-side receiver.

**What leaves.** Only PACK-DIRECTED records: a candidate, a graph entity (retracted ones marked), or a
decision whose claim, evidence, rejection reason, id/slug or first observation names a pack identifier (a
verb, an installed hook, a `doctor` row id, a `savepoint` check id in its `id:` shape, a pack-owned path
prefix OR a pack artefact the pack writes into a project, a receipt key, a posture profile, or a config
key). An identifier that is also an English word is matched ONLY in a command shape (after
`respawnpack`, in backticks, as a `--flag` head, a config key in dotted form, a profile beside `posture`),
so a knowledge project's canon prose that merely contains the word `state` or `memory` is not pack-directed
and never leaves. Each is reduced to an allow-listed schema (`kind`, `sourceId`, `klass`, `verificationState`,
the matched `identifiers`, the first-sentence `claim`/`rejectionReason`/`observation`, `retracted`, mechanical
`evidence` tokens only, the machine author CLASS, and a date) and nothing else. **What never leaves.** A
record that names no pack identifier is listed as EXCLUDED and is not in the package; a project's host
auto-memory notes and `.claude/rules/` files are out of scope entirely; and every free-text field passes a
mechanical REDACTION FENCE that refuses a non-pack path, an IP, a hostname or domain, an email, a URL, a
high-entropy token, or any of the nine `secret-scan` secret shapes, naming the field and quoting nothing of
the blocked value past three characters. The "non-pack path" rule exempts the files the pack itself writes
into a project (`docs/derived/`, `docs/DECISIONS.md`, `memory/candidates|incidents/`, and a BARE
`docs/decisions/` id or `memory/graph/` type), because a record naming only the derived state a `savepoint`
minted is the pack's most common finding; a decision file's slug and a graph node's slug are the project's
own vocabulary and stay blocked, and a drive-letter or rooted path stays blocked whatever follows it. A
consequence: a project that keeps its OWN files under those pack paths has them read as pack artefacts. The verb PREVIEWS exactly what would leave and writes nothing
without `--out`; with `--out` it REFUSES while any included record is fence-blocked, until the owner
`--drop`s it or edits the source. ⛔ The fence catches **shapes, not meaning**: a secret written as prose
passes, so the preview is the owner's last sight of what leaves. The package's `provenance.projectId` is
sixteen random bytes minted machine-locally, so a receiver correlates exports from one install without
learning anything about the project.

**How the receiver verifies, and that an import is a LEAD.** The import re-runs the fence on every
free-text field AND on every `evidence` token (each of which must also be a mechanical shape the exporter
emits), so a forged or hand-edited record that hides a hostname or a secret anywhere is REFUSED by name and
never imported; it verifies the provenance (`packVersion` matched to a
release this checkout knows, its `VERSION` or a CHANGELOG `## [x.y.z]` heading), and lands each remaining
record as a **candidate** through the same audited gate every other lead travels, authored
`import:<projectId>`. It is marked `UNVERIFIED LEAD` on recall and is **never** a graph entity or a lesson
until a human `promote`s it with `--by`. A verified import is PASS; an unverifiable one (an absent or torn
provenance block, or a `packVersion` this checkout cannot match) imports every lead with a `provenance
unverified: ` prefix at CANNOT_DETERMINE, never dropped and never trusted. The pack file a record names is a
lead, not a cause; the self-reported version is verified, not trusted, because a hand edit can forge it.

## The register: this graph, rendered for a person

The graph above is a directory of markdown files and the candidate store beside it is a directory of
JSON records. Neither is something a person reads, and that cost is measurable: thirteen candidates
accumulated unreviewed across sessions because nothing ever put them in front of anybody.
`docs/derived/LESSONS.md` is the **human-readable projection of both** — rendered by `savepoint --write`
(`kernel/lib/render.js`), one table row per promoted entity (`type:slug`, its first observation,
`promotedAt`, the `verifiedBy` that earned the promotion, and the skills its `applies-to|skill:`
relations name, so a lesson that became a rule is visible as one), then the counts of candidate and
rejected leads with the command to review them. `savepoint --verify` re-derives all the counts from
these same files and compares every rendered number against them, so the register cannot quietly go
stale; SessionStart cites the two counts in one line, read from the tracked files rather than from
`STATE.json`, so it needs no freshness caveat. The register is a **projection and never a source**: it
is regenerated, never hand-edited, nothing is decided in it, and the promotion gate above remains the
only door from a lead into this graph — a candidate appears there as a counted lead under the same
`UNVERIFIED LEAD` discipline, never as a row in the table.

The register reads the schema fields a promotion now writes (G7):

- **Verified vs unvouched.** The `verified lessons` count is entities with a stated `verifiedBy`; one
  without (hand-authored or legacy) renders in its own `## Unvouched` section with its file path and the
  note that it was never verified through a promotion, and is excluded from the verified table and count.
  The unvouched count is itself a verified claim, so a hand edit to it FAILs the same `rendered-claims`
  check the other counts do.
- **Derived supersession.** An entity X is superseded when ANY entity (promoted or hand-authored) carries
  `supersedes|X`; the reader computes it and the renderer marks X `superseded by <id>` in its row, while
  X's own file is never rewritten. A chain renders only the latest as current; a cycle marks every entity
  in it and names the cycle, never loops. Supersession is derived from the relations an operator writes,
  so an entity superseded only in prose still renders as current.
- **Stale by horizon.** A `## Stale by horizon` list carries the vouched entities whose `asOf` (or
  `promotedAt`) is more than `memory.staleHorizonDays` (default 180) older than the project's newest
  recorded lesson. It is a date comparison against the store's own newest date, not the wall clock, so a
  verify is stable; a horizon of `0` disables the list with a NOTE line rather than an empty section, and
  an entity with no date at all is never counted stale. The stale count is a verified claim too.
- **The future-`asOf` clamp (G14).** A hand-authored `asOf` in the future would otherwise become the
  newest date and age every sibling by the gap. The reference drops its newest vouched date (and uses the
  next-newest) when that date stands more than the horizon beyond the next-newest REMAINING vouched date
  and the entity has no alibi, and the drop REPEATS newest first so a chain of forged future dates is
  cleared, not only the newest. The alibi is a parseable `promotedAt` within the horizon of the `asOf`
  (clock-free, the signal the date is a legitimately recent lesson rather than in the future), so normal
  store-relative staleness is untouched. A vouched entity with no parseable `promotedAt` has NO alibi and
  is clamped on the gap alone: promotion always writes `promotedAt`, so its absence means a hand-authored
  file. Each excluded entity is named in the stale section as a verified claim. Promotion already refuses a
  future `--as-of`; this closes the direct-file-edit path for a future `asOf` over a past or missing
  `promotedAt`, and chains of them. It does NOT close a forged PAIR whose `asOf` and `promotedAt` are both
  set to the same future date: without a clock that pair cannot be told from a legitimately recent lesson,
  and a clock inside the verified block is the drift G4 closed, so the forged pair evades the clamp and
  ages its siblings. The clamp catches a future `asOf` beyond its own stamp; the forged pair is the
  disclosed clock-free limit, never silently corrected. G19 makes that pair visible anyway: beside the
  `_Generated` stamp, outside the generated block and never verified, the register renders an unverified
  line naming any vouched entity whose effective date lies after the render clock, so a forged pair is
  seen without a clock entering the verified block. The line is stripped from the corpus digest exactly
  as the age line is.
- **The dormant-project age line (G14).** Because staleness is store-relative, a project idle for a year
  reports nothing stale (everything is close to its own newest date). So beside the `_Generated` stamp,
  OUTSIDE the generated block and never verified, the register renders one unverified line, `_Newest
  vouched lesson dated N day(s) before this render..._` (or `_No vouched lesson carries a date._`),
  computed from the render clock, stripped from the corpus digest exactly as the stamp is. It shows the
  dormancy the store-relative stale list cannot, without putting a clock inside the verified block (G4).
- **The world-revision binding and the behind line (G8).** The table gains a `bound to` column
  (`commit <sha7>`, `doc <path>@<digest7>`, `estate <serial>`, `unbound`, or `malformed`), a verified claim
  derived from each entity's own frozen fields, so a hand edit of a cell FAILs `generated-block`. Beside the
  stamp and after the age line, OUTSIDE the block and never verified, one more unverified line reports how
  many vouched lessons are **behind** the current revision (`_N vouched lesson(s) bound to a revision behind
  the current one ...; re-verify before acting._`, or the none form), with a clause naming how many could
  not be compared. "Behind" is binary and advisory, computed WITHOUT network: a commit binding is behind
  when its sha is not in the EFFECTIVE source revision's chain (so a savepoint-only commit above the work the
  lesson was true in does not read it behind, the rule `stateFreshness` uses), a document binding when the
  file's current digest differs, an estate binding when the source file's first line differs. **Behind is a
  re-verify trigger, never a verdict that the lesson is wrong.** The behind line is a LIVE reading (like the
  age line) and is stripped from the corpus digest, so a HEAD or a bound file that moves between a `savepoint
  --write` and a bare `savepoint --verify` never fails the register. `doctor` carries the detail:
  `memory:behind-revision` (advisory), `memory:binding-malformed` (advisory), `memory:revision-undeterminable`
  (CANNOT_DETERMINE, exit 2, so a bound revision that cannot be read is never a silent PASS), and
  `memory:infra-reverify` (an estate-bound lesson whose promotion cycle is older than
  `memory.staleOpenLeadSessions` savepoint cycles, or named "not aged" when its promotion cycle is not on
  record (hand-authored, or a lineage target no longer in the store), the serial comparison still applying so
  it is never falsely current). **The honest estate degrade:** the pack cannot read a live estate over the
  network, so an estate binding is only ever as current as the tracked source file the project itself keeps;
  an absent or empty source is UNDETERMINABLE, never rendered "current". A document digest folds CRLF to LF
  before hashing (the pack's one EOL-normalisation rule), so a line-ending flip is not a move; any other byte
  is.

A superseded entity is still a **durable record** for the learning-qualification rule (D4): a lead
duplicating it is still "already recorded", because the knowledge is still in the graph, just marked.
That is deliberately unlike a `_retracted/` entity, which a fresh lead may legitimately raise again.

## The ledger: two write paths, one trust store (G6)

The candidate store and the graph are two write paths into one trust store, and the field measured the
gaps between them: verdicts with no author, a verified candidate that promoted nothing, an entity nobody
promoted, a rejected candidate whose entity stayed live, and open leads nobody resurfaced. `respawnpack
memory candidates --ledger` (text and `--json`) is the review's first command: it recomputes, from the
candidate records and the graph on every call, the verified / rejected / open counts and the promoted
total, then one line per anomaly naming the ids or files it found, bounded by the render cap with an
exact "N more":

- **verified-without-entity** — a verified candidate whose id no live entity names in `promotedFrom`. A
  broken promise: the store says "verified" and the graph has nothing. `doctor` FAILs it.
- **entity-without-lineage** — a live entity with no `promotedFrom` (hand-authored or legacy); the same
  set the register lists as **Unvouched**. Allowed: `doctor` PASSes with the count.
- **verdicts-without-author** — a decided record whose verdict carries no author (legacy). Allowed and
  counted, never repaired; `doctor` PASSes with the count.
- **lineage-target-missing** — a live entity whose `promotedFrom` names a candidate not in the store (a
  forged or orphaned lineage). Counted here, NOT as `promoted`.
- **retracted** — entities under `_retracted/`.
- **open-older-than-sessions** — an open lead that has sat unreviewed past `memory.staleOpenLeadSessions`
  savepoint cycles (default 3), counted in CYCLES the store has seen since its capture, with the
  wall-clock days printed beside it. `doctor` FAILs it only when the count exceeds
  `memory.staleOpenLeadFailAt` (default 10), and PASSes with the count under it.

`doctor` carries one `integrity` row per NON-ZERO anomaly (none for a zero, NOT_APPLICABLE for an absent
store), and the register's "Leads awaiting review" section renders one pointer row per open lead so the
backlog is visible rather than hidden behind a count.

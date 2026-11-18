---
name: review
description: The review role — runs the host's /code-review for the generic lenses and adds the pack's spine-consistency lens (does the change match the docs, resurrect a killed feature, or drift tokens?), adversarially verifies, then records a tree-bound review receipt. The other five lenses install as named agents.
when_to_use: "review", "review this", "review the diff", "review the PR", "code review", "check my changes", "/review"
---

# /review — change review: the host's lenses plus the pack's spine

**Thin wrapper.** The generic lenses are the host's `/code-review`; the pack adds the one lens nobody else has, the `spine-consistency-reviewer`, fanned out beside it, plus the scoping, the adversarial verify, and the review receipt. The host's command is the host's — the pack does not vouch for its output; the receipt and the spine lens are the pack's own claims. No `/code-review` on this host → say so and run the spine lens alone, never pretend the generic lenses ran.

## Step 1 — Scope the change
`git diff` for the change set (uncommitted, a branch range, or a PR). Note the risk surface — auth, payments, data mutations, external APIs, and migrations get extra scrutiny, and so do hot paths and growth surfaces (request-path code, lists that grow, high-traffic tables).

**Dependency changes get read, not waved through.** A diff that adds or bumps a dependency ideally moves one at a time; read the lockfile diff (new transitive packages, unexpected version jumps) rather than rubber-stamp it — a lockfile is where a supply-chain surprise hides.

**Prose lens.** When the diff touches prose (Markdown, docs, copy, scripts), apply the same precedence `/wordsmith` does: a project's versioned rules file (`docs/reference/wordsmith-rules.md` or `.claude/rules/writing*.md`) wins over the shipped `docs/reference/writing-standards.md` on any contradiction, and say which file you applied.

## Step 2 — Run the host's /code-review, and fan out the spine lens beside it
Run the host's `/code-review` on the change set for the generic lenses (correctness, security, performance, maintainability, and the design pass on UI-touching diffs). Its findings are the host's; the pack re-reports only what survives Step 3.

Beside it, fan out the one lens the host does not have, the pack's [`spine-consistency-reviewer`](../../agents/spine-consistency-reviewer.md) agent via the Agent tool: match against `docs/PRODUCT.md` + `docs/FEATURES-PAGES.md`, resurrected ⛔ killed features (`docs/DECISIONS.md` removals and the decision shard), hardcoded values contradicting the token/copy source, and routes missing a matrix row. The full mandate lives in that file; it is the source of truth.

The other five lenses (correctness, security, performance, maintainability, design) stay installed as agents under `.claude/agents/` and are directly invokable by name (see `agents/README.md`); `/review` no longer spawns them, because the host's `/code-review` now carries those dimensions. A knowledge or docs-only target with no software standards still gets this step: the host's `/code-review` runs, and the spine lens runs against the spine.

## Step 3 — Adversarially verify (before reporting)
For the spine lens's findings, and for any host finding the pack re-reports, run a skeptic pass that tries to **refute** it (default to "not a real issue" unless the evidence holds). Drop or downgrade findings that don't survive; force any you can't verify to low confidence. This is what keeps the re-reported review trustworthy.

## Step 4 — Report (+ optionally fix)
Report surviving findings ranked by severity, each with file:line and a concrete fix. Spine-consistency findings → propose the canonical edit (e.g. a missing `FEATURES-PAGES` row), don't just flag.

**Applying a batch of fixes? Isolate them in a worktree.** Reviewing reads; applying findings WRITES, and that write works in a worktree, never the live tree. One commit per finding (revertable in isolation); back a wrong fix out with `git revert`/`git reset`, never a corrective Write on top. A dispatched fixer names an agent definition that carries `isolation: worktree` in its frontmatter (Claude Code 2.1.198 or later gives each dispatch its own temporary git worktree); a bare-prompt fixer is told in the prompt to create and work inside its own worktree. One fix agent owns the whole findings list, not one per finding, which races on shared files. Leave a short recovery note (findings done, worktree path). The control plane stays closed to the fixer either way, by `permissions.deny` under `standard` and `light` and by the editor hooks under `strict`.

**Record the receipt: a review is a fact about the exact tree it judged.** Once reporting is done, stamp which tree this review covered: `node .claude/respawnpack/respawnpack.js review-receipt --write --verdict clean|findings --lenses "code-review;spine-consistency"`. The `--lenses` label names only the lenses that actually ran, so on a host without `/code-review` it reads `"spine-consistency"` alone — a receipt that names a lens that did not run is a false pack claim. It records HEAD plus a digest of the working tree and the git tree of the complete reviewed content (untracked content included), machine-local under `.respawnpack/runtime/`; if git cannot produce a complete snapshot it records nothing and says so (CANNOT_DETERMINE). The kernel computes the identity; this skill never writes the hashes itself. A review judges a *tree*, not only code: a software diff, a document set or an infrastructure manifest are all trees, and the receipt is the same for each. If you then fix findings, the tree moves, so re-review and write a fresh receipt: `/ship` refuses a receipt whose tree no longer matches, naming the stale review.

## Invariants
- The generic lenses are the host's `/code-review`; the pack owns only the spine-consistency lens beside it. No `/code-review` on this host → the spine lens runs alone and the report says so, never silently graded.
- Verify before reporting — no re-reported finding presented as high-confidence unverified.
- Always run the spine-consistency lens (it is the differentiator and has no host equivalent).
- Reviews propose canonical edits; they don't silently rewrite the spine.
- Applying fixes runs in a dedicated worktree — one commit per finding, roll back with git (never a corrective Write), one fix agent per findings list, plus a recovery note.
- A finished review records its receipt (`review-receipt --write`), binding the verdict to the tree it judged; fixing findings moves the tree, so a re-review writes a fresh one.

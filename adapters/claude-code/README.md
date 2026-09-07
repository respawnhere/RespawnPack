# RespawnPack · Claude Code adapters

Four packages, each with its own README. Everything host-neutral lives in `core/`; nothing here
re-implements a lifecycle rule.

```
interactive/     the INTERACTIVE HOOKS profile's capability declaration and activation probe
sdk-supervisor/  the MANAGED profile: automatic in-place rollover of one owned conversation
task-runner/     one FRESH session per task, built on sdk-supervisor's cli.js and stream.js
statusline/      an opt-in statusLine tee for HIGH-confidence context usage
```

| Package | What it is | Owns a conversation? | Live proof |
|---|---|---|---|
| `interactive/` | declares what `hooks/context-monitor.js`, `precompact-ledger-nudge.js` and `session-routing-nudge.js` can honestly claim, and how to prove they are running rather than merely installed | no, the host does | activation probe |
| `sdk-supervisor/` | measures occupancy, stops at a boundary, writes and verifies a handoff, drives `/compact` in place, checks identity, continues | yes, across rollovers | `canary.js` — three consecutive real rollovers |
| `task-runner/` | reads `docs/derived/state/tasks.json`, refuses on a stale projection, records a `contract delegate`, runs **one** fresh session, then runs the gates **out of band** and writes a receipt and a handoff | no, one turn and done | fixture-driven suite |
| `statusline/` | tees `{used_percentage, …}` from the host's own statusLine payload when it carries one | no | presence of a real payload |

`task-runner/` builds **on** `sdk-supervisor/`, not beside it: the executable resolution, the exact
argv, the stdin-carried prompt and the stream reader are all `sdk-supervisor/cli.js` and
`stream.js`. Its only additions are the queue, the freshness refusal, the delegation, the turn log,
and the out-of-band verdict — the gates, the `contract complete --met` attestation it reads back from
the kernel, the `task-attempt` receipt and the `core/state/handoff.js` handoff. It never asks the
session whether it succeeded. What it still does not do: scope the gate by the task's `gates.only`
(that is P4-K-08 — the request is recorded and the FULL gate runs), and it does not yet narrow what
`session-routing-nudge` and `stop-savepoint` do inside a task session (P5-T-16c).

**`interactive/`, `sdk-supervisor/` and `statusline/` install to a target now; `task-runner/` does
not.** `install/_sources.js`'s `ADAPTER_FILES` (P5-CT-4, decision 2.7) places all three under
`.claude/adapters/claude-code/`, and `doctor`'s `host-adapter:*` rows report them, placed is not
activated for any of the three, and `statusline` additionally stays opt-in at the settings level (its
`statusLine` slot in `.claude/settings.json` is never written or overwritten by the installer). `task-runner/`
is explicitly out of scope for this wave: it stays driven from this pack's own checkout against a
target `--dir` until a later task wires it in.

The shared vocabulary (context cycle, in-place rollover, the four-outcome and four-support vocabularies)
comes from the multi-host rollover design, a development record whose product-facing summary is
`docs/vision/ARCHITECTURE.md`; these adapters use it without re-explaining it.

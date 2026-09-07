# Claude Code interactive profile

This package declares what the INTERACTIVE HOOKS profile (`hooks/context-monitor.js`,
`hooks/precompact-ledger-nudge.js`, `hooks/session-routing-nudge.js`) can honestly claim about the seven
adapter capabilities (`core/policy/capabilities.js`), and how to prove it is actually running rather than
merely installed.

- **`profile.js`** — the capability declarations. `measureContext` and `probe` are
  `SUPPORTED_WITH_LIMITATIONS`; `settleOrStop`, `observeCompact`, `injectHandoff` and `resume` are
  `SUPPORTED`; `requestCompact` is `NOT_SUPPORTED` — a hook cannot invoke a slash command, so the honest
  claim is that this profile has no programmatic path to request compaction, not that it has one with
  caveats. The operator's own `/compact` is the real, named, manual fallback (see
  the "Interactive profile" section of the multi-host rollover design, a development record).
- **`probe.js`** — the activation canary. Checks THIS conversation's own runtime artifacts (the
  SessionStart baseline, context-monitor's per-cycle latch file when one exists) rather than trusting that
  installed files mean the hooks ran. See its own header for what counts as evidence and what does not.

## Using it

```js
const { probe } = require('./probe.js');
const { declareAll, matrix } = require('./profile.js');

const canary = probe({ projectDir, sessionId });
const declarations = declareAll(canary);   // one per capability
const row = matrix(canary);                // { profile, declarations, rolloverCapable, unmet, ... }
```

A declaration's `support` is never higher than what the canary actually observed — an unrun probe (or one
that did not pass) reports `CANNOT_DETERMINE` for every capability except `requestCompact`, which needs no
canary because it is declared `NOT_SUPPORTED` unconditionally.

## Relationship to the managed profile

`adapters/claude-code/sdk-supervisor/` is the OTHER Claude profile: a supervisor process that owns the
conversation and can therefore request compaction itself. The two share the same host-neutral core
(`core/`) and the same rollover machine per conversation — a conversation touched by both in its lifetime
(hooks most of the time, a supervisor-driven rollover occasionally) shares one `core/lifecycle/machine.js`
journal, one cycle id, one set of threshold latches. Nothing here assumes it is the only writer.

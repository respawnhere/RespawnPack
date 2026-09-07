# RespawnPack statusline tee (opt-in)

`statusline.js` is a Claude Code `statusLine` command. It prints one plain-text status line (what the
Claude Code UI shows at the bottom of the terminal) and, when the host's payload carries a real
context-usage block this call, atomically tees `{used_percentage, remaining_percentage,
context_window_size, at}` to `.respawnpack/runtime/context-usage-<safe session id>.json`.

`hooks/context-monitor.js` reads that file when its `at` timestamp is fresher than 60 seconds and treats
it as a `documented-api` (HIGH confidence) measurement — the best of the three sources it knows about,
ahead of the transcript-tail token reading (`internal-format`, LOW — the transcript JSONL shape is
explicitly internal) and the byte-size proxy (`byte-proxy`, PROXY).

## Placed by default; wiring the settings slot is still manual (P5-CT-4)

`install/install.js` places this file at `.claude/adapters/claude-code/statusline/statusline.js` in
every install now, the same as `interactive/` and `sdk-supervisor/`. It does NOT wire it into
`.claude/settings.json`. Two reasons, and only the first one is about this file specifically:

1. A `statusLine` command is a SINGLE slot in Claude Code's settings — writing one here would either
   silently overwrite a founder's own status line, or require merge logic this pack does not have for
   that setting (unlike the hooks block, which is additive by design). Placing the file is not activating
   it, and never will be by itself.
2. There is no activation canary yet that proves, on a real installed target, that the documented
   context-usage block actually arrives in this environment's Claude Code build in the shape this script
   expects. `adapters/claude-code/interactive/probe.js` reports its OWN capability declarations honestly
   as `CANNOT_DETERMINE` until a fresh tee file is observed; it does not assume this script is running.

`node .claude/respawnpack/respawnpack.js doctor` reports a `host-adapter:claude-statusline` row: `INSTALLED`
once the file is placed and loads, whether or not the settings slot names it; `CONFIGURED` once
`.claude/settings.json`'s `statusLine` actually points here (a structural read of the slot, not a fired
canary). It never reads `ACTIVE` from either doctor or a mere presence check — that would need the
canary this section still names as unshipped.

## Manual wiring

Add a `statusLine` entry to `.claude/settings.json` pointing at this script with an absolute path (or a
path resolved from `$CLAUDE_PROJECT_DIR`, which Claude Code exports before invoking hook and statusline
commands):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$CLAUDE_PROJECT_DIR/.claude/adapters/claude-code/statusline/statusline.js\""
  }
}
```

If you already have a `statusLine` command (from this pack's onboarding, from another tool, or hand
written), you have exactly one slot — decide which command owns it, or write a small wrapper script that
calls both and prints the line you want the UI to show. RespawnPack does not merge `statusLine` entries.

This script depends only on `core/_io.js` (a zero-dependency leaf — see its own header) for the atomic
write; it does not require the rest of `core/` or any hook. The installer already places both at the
matching depth (`.claude/adapters/claude-code/statusline/statusline.js` next to `.claude/core/_io.js`),
so a normal install needs nothing extra here. If you ever place this file by hand instead, carry
`core/_io.js` alongside it, or point the `require` at wherever your checkout keeps `core/`.

## What it does NOT do

- It does not request compaction, observe it, or touch the rollover machine
  (`core/lifecycle/machine.js`) in any way. It only measures and tees.
- It never fails the turn or blocks anything — a malformed payload or an unwritable runtime directory
  degrades to printing a plain `RespawnPack` status line and teeing nothing, never a crash or a stack
  trace in the UI.
- It writes NOTHING when the host's payload carries no recognizable context-usage block this call
  (documented to happen immediately after `/compact`, until the next statusline call) — a stale tee with
  no fresh timestamp is read by `context-monitor.js` as "no source", never as a measurement of 0% or 100%.

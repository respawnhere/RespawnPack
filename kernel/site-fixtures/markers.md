# The pack's own markers

A derived document draws a line between the half a human writes and the half the state compiler
rewrites. The renderer keeps that line visible instead of dropping it with the other comments.

<!-- RESPAWNPACK:NOTE — hand-written, preserved across regeneration -->
The human note. It survives regeneration, so a reader should be able to tell at a glance that this
paragraph is the one they may edit.

- and a note may hold a list
<!-- /RESPAWNPACK:NOTE -->

<!-- RESPAWNPACK:GENERATED — do not hand-edit below this line -->

**Source revision:** `0000000000000000000000000000000000000000`

## Status

| id | status |
| --- | --- |
| `REQ-1` | conformant |

- 2 mandatory requirements, of which 1 conformant

<!-- /RESPAWNPACK:GENERATED -->

## A marker inside a fenced block stays literal

```markdown
<!-- RESPAWNPACK:GENERATED — do not hand-edit below this line -->
this is documentation about the marker, not a generated block
<!-- /RESPAWNPACK:GENERATED -->
```

## A closing marker with nothing open

<!-- /RESPAWNPACK:GENERATED -->

The line above is an ordinary comment with no section to close, so it is dropped like any other.

## An opening marker with nothing closing it

<!-- RESPAWNPACK:NOTE — hand-written, preserved across regeneration -->
The document meant to open a section here and never closed it. The section runs to the end of the
file rather than the block being thrown away.

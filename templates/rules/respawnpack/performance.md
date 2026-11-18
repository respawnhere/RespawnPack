---
# RESPAWNPACK:RULE v<PACK_VERSION> : managed rule, source docs/reference/performance-standards.md. Edit the source, not this copy; the installer refreshes it on a pack version change or --force. A file whose header no longer carries RESPAWNPACK:RULE is treated as founder-owned and never overwritten.
paths:
  - "**/routes/**"
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/api/**"
  - "**/pages/**"
  - "**/app/**"
  - "**/cmd/**"
  - "**/internal/**"
  - "**/pkg/**"
  - "**/services/**"
  - "**/models/**"
  - "**/repositories/**"
  - "**/dao/**"
  - "**/db/**"
  - "**/queries/**"
  - "**/*.sql"
---

Performance baseline for request-path and data-access code (full rules: `docs/reference/performance-standards.md`). This rule loads only when you touch a request handler, a service, or data-access code, which is where latency and growth actually bite. A knowledge, docs-only or ops-infra project never receives this file at all; the installer drops it from `PROJECT_TYPE_DROPS`.

- No queries in loops. Batch, join, or precompute instead.
- Paginate anything that grows; never return an unbounded list.
- Select only the columns and fields you need.
- Pool connections rather than opening one per call.
- Time out every external call, and degrade rather than hang when it is slow.

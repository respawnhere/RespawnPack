---
# RESPAWNPACK:RULE v<PACK_VERSION> : managed rule, source docs/reference/testing-standards.md §9. Edit the source, not this copy; the installer refreshes it on a pack version change or --force. The YAML below is the marker line, so a file whose header no longer carries RESPAWNPACK:RULE is treated as founder-owned and never overwritten.
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/test/**"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/test_*.py"
  - "**/*_test.py"
  - "**/*_test.go"
  - "hooks/**"
  - "scripts/**"
  - ".github/workflows/**"
---

Safety-check baseline for verification code (full rules: `docs/reference/testing-standards.md` §9). This rule loads only when you touch a file that enforces something: a test, a hook, a script, or a CI workflow. A project with none of those paths never loads it.

- Zero checked subjects never pass. Compute the count after all filters and reads.
- Return one canonical outcome that agrees with the checks callers consume.
- Treat unreadable, skipped-by-limitation, malformed, partial, and unsupported inputs as non-passing; do not collapse them into absent.
- Resolve configured paths through `realpath` (nearest existing ancestor for missing outputs), bind freshness to configured inputs, and never infer ambiguous exclusions or installer ownership from names/content alone.
- For every fix, prove the original defect, the corrected case, and the nearest bypass. Runtime acceptance and declared schemas must agree both ways.
- At pre-push, trust Git's exact ref protocol rather than HEAD; inspect merge commits and ignored durable artifacts, and fail closed when scope cannot be established.

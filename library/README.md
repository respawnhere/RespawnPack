# RespawnPack: Library (vendored skills)

The skills RespawnPack actually **ships**. This is distinct from the [catalog](../catalog/README.md), which *references* third-party skills from their source.

Two things live here:
1. **RespawnPack-original skills**: authored for this framework, AGPL-3.0-or-later with the rest of the pack.
2. **Forked permissive skills**: third-party skills under a *confirmed* permissive license (MIT / Apache-2.0 / BSD) that we've chosen to vendor, each with its upstream credit and license preserved in [ATTRIBUTION.md](../ATTRIBUTION.md) and a `SOURCE:` header at the top of the skill file.

**The rule:** nothing lands in `library/` unless its license permits redistribution. Everything else is *referenced* in the [catalog](../catalog/README.md) (credit and link from source), never copied here. When in doubt, it goes in the catalog.

## What's here
- **[`compliance/`](compliance/)**: the compliance layer. Detailed per-requirement checklists for NA/EU frameworks ([`compliance/requirements/`](compliance/requirements/)) plus the downloaded authoritative source texts ([`compliance/references/`](compliance/references/), with [`SOURCES.md`](compliance/references/SOURCES.md) citing each). Worked through by the `/comply` skill.

RespawnPack's lifecycle role skills live in [`../skills/`](../skills/); `library/` holds RespawnPack-original content plus vetted permissive forks. The [catalog](../catalog/README.md) covers the broader third-party skill ecosystem by reference.

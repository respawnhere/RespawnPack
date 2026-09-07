# TodoApp: a reference filled-in spine

This is a reference example, not runnable code. "TodoApp" is a small fictional
product (Next.js plus Supabase) whose only purpose is to show what a
RespawnPack `docs/` spine looks like once it has been lived in for a few
sessions, instead of the empty `<PLACEHOLDER>` templates the installer lays
down.

Look at `docs/PRODUCT.md`, `docs/FEATURES-PAGES.md`, and `docs/DECISIONS.md`
here and compare them to the matching templates under `spine/` at the repo
root. Same column shapes, same sections, filled with realistic content:
shipped features, one in progress, one held behind a flag, and one killed
feature with a real removal entry in `DECISIONS.md`.

`package.json` and `respawnpack.config.json` are included so you can see what
the installer's stack detection and a filled-in config actually look like
side by side with the placeholder versions it writes on a fresh install.

There is no app behind this. No install script will run against it, and
nothing here is wired to build, test, or deploy.

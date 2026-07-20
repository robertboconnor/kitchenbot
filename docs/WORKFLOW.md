# How we work on KitchenBot (branches, deploys, context)

This is the playbook. It exists so that Rob on any device — and any fresh Claude session — follows
the same rules without re-deriving them. Short version: **`main` is production, everything else is
a safe workspace, and the "why / what's next" lives in `docs/` so it travels with the code.**

## Branches

- **`main` = production.** Render's service **Branch** setting points at `main`, so a push to `main`
  auto-deploys. Only finished, working code lands here — and only via a merge, never a direct push.
- **`dev` = the working branch.** All work-in-progress lives here (or on short-lived `feat/*`
  branches off it). Commit freely, push often, break things mid-refactor — **Render ignores every
  branch except `main`, so none of this deploys.** Pushing `dev` is how work gets backed up and
  reaches your other devices.

## Working across devices (the whole point)

```
desktop:  <work>  →  git add -A  →  git commit  →  git push        # on dev
laptop:   git fetch origin  →  git checkout dev  →  git pull        # continue where you left off
```

Nothing deploys during any of this, because you never touched `main`.

## Shipping to production (deploying)

When `dev` is working and you want it live:

```
git push origin dev                 # make sure dev is up to date on GitHub
# open a Pull Request: dev → main  (on github.com)
# review the diff, then Merge
```

The merge is a push to `main`, which Render picks up and deploys. **Merging to `main` = deploying.**
Do it deliberately. (A PR even as a solo dev is worth it: it's a deploy gate, gives a clean history,
and it's the habit real teams use.)

## Where "the context" lives (so a cold session can pick up)

Committed, in the repo, public (it's rationale, not secrets):

- **`docs/ROADMAP.md`** — where we are, what's next, open threads, the current goal. **Update it at
  the end of a work session** so the next device/session starts informed.
- **`docs/design-decisions.md`** — *why* we chose things (palettes, architecture calls), with the
  options that were on the table, so a past decision can be revisited.
- **`docs/WORKFLOW.md`** — this file.

Note: Claude's own memory (`~/.claude/…`) is **per-device and does not sync**. These `docs/` files
are the real source of truth across machines; the local memory is just a convenience cache.

## Guardrails

- **Secrets** (PIN, Anthropic key) live in `.env`, which is gitignored. Set them per-device and in
  Render's environment variables — never commit them.
- **`.claude/` is gitignored** (local session tooling, not shared).
- **A local "protect-main" hook** (`.claude/hooks/block-git-write.mjs`) blocks pushes to `main` and
  force-pushes from Claude's automation, so an accidental deploy can't happen from a Claude session.
  It's local-only and belt-and-suspenders.
- **Recommended (server-side, robust):** turn on GitHub **branch protection** for `main` (Settings →
  Branches → require a PR before merging). That enforces the "only merge to main" rule for everyone
  and every tool, not just this hook.

## Verify it's working

- Push `dev` → check Render's dashboard shows **no deploy** (proves branch isolation).
- On a second device, checkout `dev` → you have the full code **and** `docs/ROADMAP.md`.
- Later, merge `dev` → `main` → Render deploys.

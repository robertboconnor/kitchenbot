# Cooking-craft evals

**These call the real Anthropic API and spend real money.** Everything in `tests/` is hermetic and
free; this directory is the deliberate exception, which is why it is not part of `npm test` or
`npm run test:all`.

```bash
node evals/run.mjs --dry-run                 # free — scenario table + cost estimate
node evals/run.mjs --calibrate --yes         # ~$0.05 — prove the judge fails known-bad replies
node evals/run.mjs --yes                     # full run, ~$1–2
node evals/run.mjs --only succotash-hold --reps 1 --yes
node evals/run.mjs --compare evals/baselines/pre-craft.json --yes
```

`--yes` is required before anything is spent. Without it the runner prints the plan and exits.

## Why this exists

KitchenBot's system prompt had 30 principles and not one of them was about food. It gave Rob a
succotash recipe that put the vinegar in before a 30-minute hold, which turned the lima beans grey
and soft. The fix is cooking-craft guidance in the prompt — and the only way to know whether prompt
text actually changed behaviour, rather than just feeling like it should have, is to measure it.

## How it works

- Each scenario runs in its **own process against its own throwaway database** (`run-one.mjs`),
  because `db.mjs` binds `DB_PATH` at import time. `KB_TEST_GUARD=1` makes `db.mjs` throw rather
  than ever open the real `kitchenbot.db`.
- It drives the **real** `handleKbChatTurn` with the **real** dependency wiring from
  `kb-server-deps.mjs`, so what it measures is what the app actually does. The only substitution is
  a thin recording wrapper around the Anthropic client (`recorder.mjs`) so the tool trace and
  request shape can be observed.
- Anything a machine can decide is decided by a machine (`checks.mjs`): was a tool called, is the
  reply under N words, did the grocery list end up with the right items. The judge is only asked
  about cooking judgment.
- `judge.mjs` grades the reply against the criteria in `scenarios.mjs` using a forced tool call —
  the same shape as the truthfulness verifier in `kb-claim-guard.mjs`. Every verdict must carry a
  verbatim quote from the reply.

## `--calibrate` is not optional

Run it before you believe a single green result. It feeds the judge three hand-written **known-bad**
replies — including a faithful reconstruction of the answer that actually ruined the succotash — and
fails the run if the judge lets any of them pass.

This repo has already been bitten once by a verification tool that under-reported: a static checker
that said "clean" while silently skipping 80% of the file it was checking, hiding five real bugs.
A lenient judge is the same failure in a different costume. **A tool that under-reports is worse
than no tool, because you trust it.**

## Baselines

`evals/results/` holds raw runs and is gitignored. `evals/baselines/` holds *promoted* runs and is
committed — the git diff of a baseline file is the reviewable evidence that a prompt change worked.

Capture a baseline **before** changing the prompt. Once the change lands you cannot recreate it
without a git worktree.

## Reading a failure

The console names the criterion and quotes the judge's reasoning. The JSON artifact in
`evals/results/` has the full reply, the tool trace, per-call token usage and every verdict with its
evidence quote — that is where triage happens.

Two failure modes to keep separate:

- **The brain got it wrong** → fix the principles.
- **The rubric got it wrong** → fix the criteria, then re-baseline.

While a comparison against a baseline is red, only ever change the *principles*. Editing the rubric
to make a run go green is how an eval becomes decoration.

## Cost

Roughly $0.03–0.06 per scenario-rep; a full 13 × 3 run is about $1–2. The exact figure is reported
after every run from the app's own usage accounting (`anthropic-usage.mjs`), not estimated.

Eval spend lands in a temp database, so it never pollutes the household usage ledger the app
displays. It **will** appear in the org-level dollar figure on the usage page, because that reads
Anthropic's real cost API.

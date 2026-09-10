# KitchenBot

A household kitchen assistant that runs the actual kitchen: what we're eating this week, what's in
the pantry, what's on the grocery list, and the recipes themselves. It's a private app my wife and
I use every week — this repo is public because of *how* it was built, not because it's a product
you should deploy.

It's also the answer to a question I had no other way to answer: **can someone who doesn't write
code by hand build and operate a real application, agentically, and keep it working?** Everything
here was written with Claude Code, in conversation, over a couple of months of real use. The bugs
were real, the fixes were real, and the architecture got rewritten once when the first design
turned out to be wrong.

---

## What it does

You talk to it like a person. It cooks, plans, and keeps state:

- **Meal planning** — a visible weekly plan, refined in conversation ("swap Thursday, Elle's out")
- **Recipes** — a cookbook it writes to, plus import from a URL or a photo of a cookbook page
- **Pantry + grocery list** — a real inventory, shared and live across phones; it knows not to put
  something on the list if it's already in the pantry
- **Household context** — who lives here, allergies (hard constraints), per-person food profiles
- **Cooking craft** — how a dish behaves under the constraints you actually stated: a two-hour
  hold, a reheat, two sittings, one pan

## The one architectural idea

**Smart brain, dumb executors.** There is one agent loop that makes every decision — what you meant,
what to do, which items, which section, whether "this" refers to the thing three messages ago — and
a set of mechanical tools (`grocery.write`, `pantry.add`, `cookbook.save`, `thread.search`, …) that
only *do* what they're told.

This is worth stating because the first version was the opposite. It had a deterministic router that
picked one capability and handed it a thin input, so every executor had to re-read the chat and
re-plan on its own. The result was an app with a dozen small competing brains: "it can't actually do
that," "it redid the wrong thing," behavior nobody could steer. Replacing the router with a real
agent loop — and then hunting down the leftover intelligence in the executors — is most of the
interesting work in this repo.

The full rules are in [`KITCHENBOT_BRAIN_CONTRACT.md`](KITCHENBOT_BRAIN_CONTRACT.md), which is the
product contract: if the code and that document disagree, the code is considered suspect.

## Building it agentically — what I actually learned

- **The prompt is the product, and it needs tests.** KitchenBot's system prompt had 30 principles
  and not one of them was about food. It handed me a succotash recipe that put the vinegar in
  before a 30-minute hold, which turns lima beans grey. Prompt text that *feels* like it should
  change behavior often doesn't, so the fix shipped with an eval harness ([`evals/`](evals/)) and a
  recorded pre-change baseline. Never tune the rubric to go green.
- **A verification tool that under-reports is worse than none.** A static checker in this repo
  reported "clean" while silently skipping 80% of the file it was checking, hiding five real bugs.
- **Write down decisions, not just code.** [`docs/design-decisions.md`](docs/design-decisions.md)
  exists so a future "actually, let's change this" can see the options that were on the table.
- **Root-cause it.** A recurring recipe "truncation" I blamed on the model three times was a
  240-character storage cap chopping steps mid-word.

## Stack

Node 20+ · Express 5 · SQLite · WebSockets (Redis pub/sub when running more than one instance) ·
the [Anthropic API](https://docs.claude.com/en/api) for the agent loop · vanilla JS frontend as
feature modules around a small composition root. No build step, no framework.

Deployed on Render; `main` is production and a merge to it is the deploy.

## Running it

```bash
npm install
```

Then set, at minimum: `KITCHENBOT_SECRET` (cookie signing), `ANTHROPIC_API_KEY` (a shared fallback —
households can also carry their own key), and the four `INITIAL_*` variables
(`INITIAL_HOUSEHOLD_NAME`, `INITIAL_HOUSEHOLD_KEY`, `INITIAL_OWNER_NAME`, `INITIAL_OWNER_PIN`) which
seed the first household on an empty database. Optional: `REDIS_URL`, `DB_PATH`, `PORT`,
and Google Document AI credentials for OCR on photographed recipes.

```bash
npm start        # http://localhost:3000
npm test         # unit tests — hermetic, no API calls, no cost
npm run test:e2e # Playwright
```

The cooking-craft evals in [`evals/`](evals/) are the deliberate exception: they call the real API
and spend real money, so they're excluded from `npm test` and refuse to run without `--yes`.

## Docs

| File | What it is |
| --- | --- |
| [`KITCHENBOT_BRAIN_CONTRACT.md`](KITCHENBOT_BRAIN_CONTRACT.md) | What KitchenBot is and how the brain must work |
| [`docs/design-decisions.md`](docs/design-decisions.md) | Running log of product/design decisions and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What's next |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | Branches, deploys, how work moves between machines |
| [`evals/README.md`](evals/README.md) | The cooking-craft eval harness |

## Status

Personal project, in active weekly use by exactly one household. Not accepting contributions and
not licensed for reuse — but you're very welcome to read it, and the contract and decision docs are
the parts most likely to be useful to someone else.

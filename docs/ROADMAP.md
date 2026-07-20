# KitchenBot — Roadmap & Working State

The living "where we are / what's next" doc. Read this first when picking up on a new device or a
fresh session. **Update it at the end of a work session.** Last updated: **2026-07-19**.

## The goal

Get KitchenBot to where someone sees it in a public GitHub repo and says *"holy shit, this is a
legitimate application"* — both in how it **works** (one reasoning brain with tools) and how it
**looks/feels** (a specific visual identity, not a generic app). Auth stays intentionally janky;
it's never going to the app store, so no abuse/scale/cost threat-modeling. Family actually uses it
(Rob + Elle + a 4yo, Bizzy).

## Where we are now (working branch: `dev`)

**The brain (v3) — done & battle-tested.** Rewritten from a deterministic grounding→interpreter→
single-action pipeline into ONE native Anthropic tool-use loop (`kb-agent-loop.mjs`): the model
decides which tools to call. Red-teamed hard (truthfulness, injection, gaslighting all held).
Model = `claude-sonnet-5`. This is the real architectural leap.

**Latency UX — done.** True token streaming to both household members + whimsical per-tool progress
("Plotting something delicious…"), broadcast over WebSocket to co-viewers.

**Design system — done (this is where the last stretch of work went).**
- **Three user-selectable palettes**, per-user preference (`household_users.palette`, mirrors
  `chat_color`; Settings → My household → Appearance; follows the user across devices; default
  `sweetwater`): **cotton-candy** (pink, Tickle-Me-Pink scalpel), **sweetwater** (aqua, harbor),
  **sous-chef** (cream + coral + deep-navy). All token-driven; switching is instant.
- "**Color is a scalpel**": ~90% neutral, the one key action/state per screen gets the saturated
  pop. NO dark mode (removed). NO serifs. Full rationale + palette hexes in `docs/design-decisions.md`.

**Truthful writes + a real capability gap closed:** `grocery.update_item` lets the brain change the
quantity of an item already on the list (or a bought item) — it *asks* on the ambiguous bought-item
case. 136 tests green.

## Roadmap (phased) — what's left

- **Phase 1 — Look & feel.** ~80% done (palettes, scalpel, tokens). **Remaining:** nav/IA cleanup
  (one coherent way to reach chat/cookbook/groceries/pantry/settings), **make Settings reachable by
  non-owner members** (today it's behind an owner-only "Household" button), fold the standalone
  Recipe Importer into Cookbook, self-host the display font (currently `ui-rounded` = Apple-only),
  wire the reserved `--accent-warm` (Sundress yellow / Egg Yolk) as a surgical "joy-pop" on wins.
- **Phase 2 — Memory / people model (highest FUNCTIONAL value).** Today retrieval **silently drops
  any household member who isn't the person typing**, so "plan our family's dinners" loses Elle and
  Bizzy. Fixes: always-include the household's people in context; add a `memory.list`/`search`
  read-tool; add a `household_members` table so the non-login 4yo is a first-class member with
  structured preferences; fix a real bug where a person-save without a `key` silently no-ops. ~Medium.
- **Phase 3 — Recipe robustness.** Real **SSRF** in the chat fetch path (`recipe-url-ingestion.mjs`
  `fetchRecipePage` — no private-IP guard); no input caps / timeouts; two divergent import pipelines
  to unify. ~S–M each.
- **Phase 4 — Delete dead weight + split Settings.** Remove the orphaned deterministic follow-up /
  next-action state machine (elaborate, tested, unreachable). Split the Settings "disaster" (4
  audiences — your prefs / household admin / billing / God-Mode super-admin with plaintext PINs —
  in one panel) into sane surfaces. ~Medium.
- **Phase 5 — Frontend re-plumb (the long pole, Large).** The entire client is template strings
  inside the 212 KB `kitchenbot.mjs` + a 4,580-line global-scope `public/app.js`. Lift HTML/CSS out
  into real files/components, move JS off global scope, real responsive + a11y. Framework TBD
  (vanilla-modular / Svelte / React). This is the genuinely multi-week job.

## Open threads / known paper-cuts

- **Stored XSS:** assistant messages render via `marked.parse()` → `innerHTML` with no sanitizer and
  **no CSP header**. Imported-recipe / web-search text could inject script. Cheap fix, worth doing.
- **"Move to pantry"** still shows the red *delete*-style base in its default state (only the
  `-ready` variant got the neutral scalpel treatment). Minor CSS fix in `kitchenbot.mjs`.
- **Non-owner members can't reach Settings at all** (see Phase 1) — so the self-service palette
  picker is only reachable by owners today. Works for Rob + Elle (both owners).

## Recommended next step

Two good options depending on mood:
- **Biggest functional win:** Phase 2 (memory/people model) — makes family meal-planning actually
  reason about Elle and Bizzy.
- **Finish the "looks legit" story:** the Phase 1 remainder (nav/IA + Settings reachability + the XSS
  fix) — smaller, visible, and closes the most obvious "this is still a bit janky" gaps.

## Run it locally

`npm install` then set `.env` (household seed vars + `ANTHROPIC_API_KEY`). `npm start` →
`node kitchenbot.mjs` on `PORT`. `npm test` for the suite. Seeded login is in `.env`
(`INITIAL_*`). See `docs/WORKFLOW.md` for the branch/deploy rules.

## Pointers

- `docs/design-decisions.md` — the *why* (palettes, POV, the three-tries palette journey).
- `docs/WORKFLOW.md` — branches, deploys, cross-device.
- The brain: `kb-agent-loop.mjs` → `kb-tools.mjs` / `kb-skills.mjs` → executors.

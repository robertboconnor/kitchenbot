# KitchenBot — Roadmap & Working State

The living "where we are / what's next" doc. Read this first when picking up on a new device or a
fresh session. **Update it at the end of a work session.** Last updated: **2026-07-20**.

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

**"Smart brain, dumb executors" — completed 2026-07-20 (overnight one-brain rearchitecture).** After
finding a prod bug where a *haiku side-model*, not the brain, was choosing pantry categories, we swept
the whole loop for the same anti-pattern and pulled out every side-model that was making a *decision*:
- **Section classification** (haiku decided grocery/pantry categories) → brain names the section on the
  tool call; deterministic regex is the only fallback (`inventory-classification.mjs`).
- **Grocery-list generation** (a draft-model + a pantry-reconciliation model built the list) → the brain
  enumerates every item itself (scaled to portions, minus what `pantry.list` shows on-hand) and passes an
  explicit `items` array to `grocery.write`.
- **`meal.refine`** (a sub-brain re-detected intent to refine a plan) → deleted; refinement is just the
  brain continuing the conversation.
- **Memory scope** (haiku decided person-vs-household + reconciled notes) → the brain passes `scope`/
  `person`; storage is a deterministic append. Also fixed the old **person-save-without-`key` silent
  no-op** here.
- **Working-context** (a haiku call summarized the chat into a "what we're doing" blob) → removed from the
  live path.
The contract now permits side-model calls **only** for mechanical parse/shape helpers that never decide:
chat-title naming + recipe import structuring (OCR / URL → structured recipe). Codified in
`KITCHENBOT_BRAIN_CONTRACT.md` ("Smart Brain, Dumb Executors") and `anthropic-model-policy.mjs`.
Dead-code sweep removed ~690 lines of now-orphaned sub-brain scaffolding. These flows verified live
(memory person/household scope, grocery-from-meals, pantry add + recategorize, grocery quantity update)
with **zero side-model calls in any tool trace**. **On `dev`, not yet merged to prod** (Rob's call).

**Re-hunt (2026-07-20) — full audit of every side-model call site.** Confirmed the brain + two shape
helpers are the only model calls in memory/grocery/section/working-context, and surfaced the remaining
transcript-derivation in the recipe/cookbook path. Status of each finding:
- ✅ **`grocery-executor` residual "derive groceries from a transcript recipe"** branch + the dead
  grocery-generation system-prompt (re-wiring hazard) — removed (commit `4748084`).
- ✅ **`cookbook.save`**: `inferCookbookRecord` (side-model that synthesized a whole entry from the chat)
  deleted; the transcript-scan that picked "which recipe" removed; the brain now passes the recipe in a
  structured `recipe` field. Verified live (commit `1d602d2`).
- ⬜ **`recipe.revise`** (`recipe-executor.mjs resolveRecipeBase`) still scans the transcript
  (`findLatestExplicitRecipeCandidate` / `findLatestAssistantRecipeText`) to pick the base recipe when the
  brain passed no target — same violation as cookbook.save. **Open design question first:** with cookbook.save
  now recipe-aware, the brain can revise conversationally and re-save, which may make `recipe.revise`'s model
  call redundant — decide whether to give it a `recipe` field or remove the tool. (Roadmap task.)
- ⬜ Milder (`B4`, low): `kb-skills` prompt-regex fallbacks that pull a write payload from the current prompt
  when the brain sent none (grocery items / household defaults / pantry adds). Guarded, prompt-only, deterministic.
(Legit parse/shape, left as-is: recipe OCR/URL structuring, additive-edit extraction, cookbook category tagging,
chat titles, web-search execution.)

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
case. **131 tests green** (net −5 vs. 136: sub-brain tests deleted with their code, mechanical-contract
tests added).

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
  structured preferences. ~Medium. *(The person-save-without-`key` silent no-op and brain-owned memory
  scope were fixed in the 2026-07-20 one-brain pass.)*
- **Phase 2b — Week-long-thread memory ("This Week's Plan"). ✅ v1 built 2026-07-20 (on `dev`).**
  Rob's #1 real-usage gap: he runs ONE chat per week (~100 msgs/meal), but the brain only sees the last
  **16** messages (`HISTORY_MESSAGE_LIMIT`), so day-1 meals fell out of view. Built a first-class,
  per-chat, **visible** meal plan (not generic compaction): a "This Week" sub-tab in Kitchen shows the
  current chat's meals as cards (cooked checkbox + remove); the brain records them with `plan.add`,
  reads them with `plan.list`, edits with `plan.update`/`plan.remove` — same context-as-cognition
  pattern as grocery/pantry. Plus a `thread.search` read-tool: deterministic ranked retrieval over THIS
  chat's messages so the brain recalls an old detail (the toum fix, a lemon amount) without carrying the
  whole thread. One-brain throughout (brain decides + passes; executors mechanical; no side-model).
  Commits `de18f56` (backend + tools), `dfa350c` (UI + tests), and `279a2f2` (round 2). 137 tests green;
  verified live in the browser. **Round 2 (done, `279a2f2`):** (a) meals auto-link to a saved cookbook
  recipe by title (`enrichMealsWithRecipeLinks`, confident single match, resolved on read) — clickable
  "recipe" link in the panel + strip, and the brain sees `hasRecipe`; (b) a chat-embedded "This Week"
  strip pinned above the messages (chips, refreshed by loadHistory) — the plan right where you cook;
  (c) the cooked checkbox now uses the palette accent (`--accent-strong`), not browser blue.
  **Remaining polish:** a persisted meal→recipe pointer when the brain saves a recipe for a planned
  meal (today it's title-resolved on read, which is usually enough).
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

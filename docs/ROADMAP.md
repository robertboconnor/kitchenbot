# KitchenBot — Roadmap & Working State

The living "where we are / what's next" doc. Read this first when picking up on a new device or a
fresh session. **Update it at the end of a work session.** Last updated: **2026-07-23**.

## The goal

Get KitchenBot to where someone sees it in a public GitHub repo and says *"holy shit, this is a
legitimate application"* — both in how it **works** (one reasoning brain with tools) and how it
**looks/feels** (a specific visual identity, not a generic app). Auth stays intentionally janky;
it's never going to the app store, so no abuse/scale/cost threat-modeling. Family actually uses it
(Rob + Elle + a 4yo, Bizzy).

## ✅ Shipped to PROD on 2026-07-20 (main `27a3056`, Render live)

The whole overnight body of work is now **deployed**, not just on `dev`. In prod:
- **One-brain rearchitecture** ("smart brain, dumb executors") — every side-model that made a
  *decision* removed; details below.
- **This Week's Plan + `thread.search`** — the week-long-thread memory fix (Phase 2b below).
- **Truthful-writes guard** (`kb-claim-guard.mjs`) — catches a "Saved it!" claim with no matching
  tool call, wipes the streamed text, forces the model to actually do it or retract. Fixed a real
  trust bug from live use. ⚠️ *Maintenance note: the guard is per-capability-family; every NEW write
  capability needs a family added to `WRITE_FAMILIES` or its false claims slip through.*
- **Cookbook tags** — the brain can set/read/filter tags ("kid-approved"); also fixed `cookbook.list`
  hiding recipe titles from the brain.
- **Structured person profiles** — `person.profile.update`/`get` (accepted/rejected foods, allergies,
  notes); the brain's first memory READ tool; accept↔reject auto-reconciles. (This is a big chunk of
  old "Phase 2" — see below.)
- **Elle easter egg** — name-gated, tasteful, brain-generated flirtation for Rob's wife.
- **Deploy hygiene** — `app.js` is cache-busted so deploys never serve stale client JS.

**149 tests green.** Rollback tags: `pre-oneb-plan-2026-07-20`, `pre-trust-profiles-2026-07-20`.
`dev` == `main` right now. Everything below marked "on dev / not merged" is now **live**.

## 2026-07-23 — Phases 1 / 2 / 4 pass (on `dev`, NOT yet deployed)

A big pass across the roadmap. Shipped to `dev` (149 tests green, browser-verified):
- **Phase 1 (looks-legit):** top nav is now **Chat · Kitchen · Settings** with a real, member-reachable
  Settings tab (was owner-only behind a sidebar button); **self-hosted Nunito** (variable woff2) so every
  platform gets the rounded voice; **stored-XSS closed** (DOMPurify-sanitized markdown, marked + DOMPurify
  vendored locally) + a **hash-based CSP** and security headers; Move-to-pantry no longer wears the red
  delete base; the reserved **warm accent is a "joy-pop"** on marking a meal cooked.
- **Phase 2 (family) — COMPLETE:** the brain now **always sees every household member + their food profiles**
  (not just the person typing), and there's a visible, editable **Family food** surface in Settings.
- **Phase 4 — Settings split done:** Settings is now **My preferences (all) · Family food (all) · Household
  (owners) · Anthropic usage (owners) · God Mode (super-admin)**, role-gated; God-Mode gating untouched.
- **Phase 4 — dead next-action state machine REMOVED (2026-07-23):** the whole orphaned
  deterministic-follow-up / next-action machine is gone — the interpreters (`interpretKbSkillFollowUp`,
  `interpretWebSearchFollowUp`, `interpretGroceryWriteFollowUp`, `interpretCookbook*FollowUp`,
  `executeKbActions`), every `proposedNextAction` producer across the executors, the `kb-reply` /
  `kb-working-context` / `db` threading, and the whole `kb-next-action.mjs` module. Verified the brain's
  clarify behavior was **always** driven by the live `question`/`matches` passthrough fields, not by
  `proposedNextAction` (never a passthrough key) — so the removal is behavior-neutral. The
  `proposed_next_action_json` DB column is retained-but-inert (no migration; always `'{}'`). 144 tests
  green; server boots clean; a live ambiguous-grocery-remove smoke still surfaces `question` + `matches`
  with no `proposedNextAction`. **On `dev`, not yet deployed.**
- **Phase 3 — Recipe-fetch SSRF closed + fetch hardened (2026-07-23):** the "save this linked recipe"
  chat path is the one place our server fetches a **user-supplied** URL, and it did so with no guard. New
  shared `safe-fetch.mjs` (`safeFetch` / `assertAllowedUrl`) now refuses any URL that resolves to a
  private / loopback / link-local / reserved address (incl. the `169.254.169.254` cloud-metadata
  endpoint), re-validates **every redirect hop** (so a public page can't 302 to an internal one), bounds
  the request with an always-on timeout, and **caps the body read** with a streaming byte limit so a
  hostile/huge response can't exhaust memory. `fetchRecipePage` routes through it and returns a clean
  "that link points to a private/internal address" outcome instead of fetching. 18 new tests
  (`safe-fetch` + `recipe-url-ingestion`), 162 green total; server boots clean. The other two outbound
  fetches are **not** SSRF vectors and were left alone: the standalone importer hands the URL to a
  third-party scraper (`api.riveterhq.com`, fixed host), and `web.search` runs on Anthropic's servers.
  **On `dev`, not yet deployed.**

**Deferred (deliberate, with rationale):**
- **Unify the two recipe-import pipelines — NOT a security fix; needs a product call (deferred).** The
  chat path (direct free fetch + local JSON-LD/semantic extraction) and the standalone importer
  (Riveter-backed paid scraper that handles JS/bot-blocked sites) genuinely do different jobs. "Unifying"
  them means either routing chat saves through Riveter (costs money per fetch + needs `RIVETER_API_KEY`,
  which the chat path currently works without) or dropping one — a product decision, and it overlaps the
  already-deferred **W2 fold-importer-into-Cookbook** front-end merge. Both belong with Phase 5. The
  *security* half of Phase 3 (above) is done and did not require unifying them.
- **Fold Recipe Importer into Cookbook** — it's an app-merge (`recipe-importer.js` is a separate ~400-line
  client with its own page); that's Phase-5-scale (frontend re-plumb). The importer already works and
  returns to Cookbook. Better done as part of Phase 5.

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
- ✅ **`recipe.revise` — REMOVED** (2026-07-20, Rob chose option B; commits `6067569` + `870af0a`). The brain
  revises a recipe conversationally (it rewrites it) and re-saves: `cookbook.save` for a new/chat recipe,
  `cookbook.update` for a saved one. `cookbook.update` now takes the brain's full revised `recipe` (like
  cookbook.save) — one clean call instead of the old 7-call `reviseStructuredRecipe` thrash — plus a
  single-saved-recipe resolution fallback. `reviseStructuredRecipe` stays only as a bare-`request` fallback
  (an allowed transform). Removed the executor's transcript-scanning base resolver (−550 lines).
- ⬜ Milder (`B4`, low): `kb-skills` prompt-regex fallbacks that pull a write payload from the current prompt
  when the brain sent none (grocery items / household defaults / pantry adds). Guarded, prompt-only, deterministic.
  The last remaining (low-priority) one-brain item.
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
- **Phase 2 — Memory / people model (highest FUNCTIONAL value). PARTLY DONE 2026-07-20.**
  - ✅ **Structured per-person profiles** (`person_profiles` table + `person.profile.update`/`.get`):
    accepted/rejected foods, allergies, notes — queryable, appendable, accept↔reject auto-reconciles.
    This is the "first-class member with structured preferences" piece, and `person.profile.get` is the
    **memory read-tool** the brain never had. The non-login 4yo (Bizzy) is now a real, structured member.
  - ✅ Person-save-without-`key` silent no-op + brain-owned memory scope (one-brain pass).
  - ⬜ **Still open:** retrieval **silently drops any household member who isn't the person typing**, so
    "plan our family's dinners" can still lose Elle/Bizzy from *ambient* context — always-include the
    household's people; and a **visible UI surface** for person profiles (inspectable/editable, like the
    This Week panel — the "not silent" rule). A general `memory.list`/`search` over the freeform bucket is
    still absent (only the structured profile is queryable). ~Medium.
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
- **Phase 3 — Recipe robustness. ✅ SSRF + fetch hardening DONE (2026-07-23; see the dated pass above).**
  Private-IP/redirect guard, timeout, and streaming body cap now live in shared `safe-fetch.mjs`, used by
  `fetchRecipePage`. **Remaining (deferred, deliberately):** unifying the two import pipelines is a
  product call, not a security fix — see the Deferred note above (overlaps W2 / Phase 5).
- **Phase 4 — Delete dead weight + split Settings. ✅ DONE (2026-07-23).** The orphaned
  deterministic-follow-up / next-action state machine is removed (see the dated pass above), and the
  Settings "disaster" is split into role-gated surfaces (My preferences / Family food / Household /
  Anthropic usage / God Mode).
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

The big brain/one-brain arc and the two most-requested functional gaps (week-long-thread memory,
structured per-person prefs) are **shipped**. Good next moves, by mood:
- **Close the family-context gap (functional):** the Phase-2 remainder — always-include Elle & Bizzy
  in ambient context (not just the person typing), plus a **visible person-profile UI** (inspectable/
  editable, per the "not silent" rule). This is what makes "plan our family's dinners" fully reason
  about everyone.
- **Finish the "looks legit" story:** Phase 1 remainder (nav/IA + make Settings reachable to non-owner
  members + fold in the Recipe Importer) and the **XSS + CSP** paper-cut — small, visible, closes the
  most obvious "still a bit janky" gaps.
- **Quick + fun:** redo the **Elle easter-egg examples** (Rob: the test examples were "lame as hell";
  the feature works — it's the calibration/quality of the flirtation that needs a pass).

## Run it locally

`npm install` then set `.env` (household seed vars + `ANTHROPIC_API_KEY`). `npm start` →
`node kitchenbot.mjs` on `PORT`. `npm test` for the suite. Seeded login is in `.env`
(`INITIAL_*`). See `docs/WORKFLOW.md` for the branch/deploy rules.

## Pointers

- `docs/design-decisions.md` — the *why* (palettes, POV, the three-tries palette journey).
- `docs/WORKFLOW.md` — branches, deploys, cross-device.
- The brain: `kb-agent-loop.mjs` → `kb-tools.mjs` / `kb-skills.mjs` → executors.

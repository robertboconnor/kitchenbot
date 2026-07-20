# KitchenBot — Design Decisions

A running log of deliberate design/product decisions, kept so a future "actually, let's change
this" can reference the exact options and reasoning that were on the table at the time. Newest first.

---

## DD-001 — Visual point-of-view: **Playful sous-chef** (2026-07-18)

**Status:** POV active. The *palette* took three tries in one night before landing — see the
Palette Update below.

> **PALETTE UPDATE (2026-07-18):** The POV (Playful sous-chef) holds, but the color palette
> evolved through three attempts the same night:
> 1. **Warm cream + tomato** — REJECTED as too Anthropic (cream/almost-yellow bg + red accents).
> 2. **"Fresh market" basil green** — REJECTED as "I went to internet startup school in 2003."
> 3. **"Soft pastel / candy" (P-001 below) — ✅ ACTIVE.**
>
> Also locked the same night:
> - **NO dark mode.** KitchenBot is bright & friendly for cooking/entertaining. (Maybe a
>   candy-dark palette someday; the dark tokens were *removed*, not just disabled.)
> - **"Color is a scalpel"** — the ~90% of every screen stays soft/neutral-pastel; the ONE key
>   action or state per screen gets the saturated Tickle-Me-Pink pop; secondary actions stay
>   neutral; never rainbow. (Borrowed from Rob's GTM-ops data-viz philosophy in
>   `ops-house-style.md` — the *principle*, not that doc's actual colors.)
> - **Two standing vetoes:** no Anthropic cream+red; no serif fonts (rounded sans only).

> **RESOLUTION (2026-07-19):** Rob liked more than one, so we shipped **THREE user-selectable
> palettes** instead of picking one — a per-user preference (`household_users.palette`, mirrors
> `chat_color`), chosen in Settings → My household → **Appearance**, following each user across
> devices. **There is no single "active" palette** anymore; the default (pre-login / new user) is
> `sweetwater`. The three (each with its "color-is-a-scalpel" accent):
> - **`cotton-candy`** — pink→mint; Tickle Me Pink `#ff82bd` scalpel.
> - **`sweetwater`** — cool neutrals→pastels; aqua `#1f9e8e` scalpel (deepened from `#7fd4c1` for
>   white-text contrast); sundress `#f6e28a` reserved as `--accent-warm`.
> - **`sous-chef`** — cream + egg-yolk + cooked-coral + deep navy + soft sky; coral `#ee6c48`
>   scalpel (deepened from `#f4845f`); deep navy `#2f4257` ink; egg-yolk reserved.
>
> Implementation: CSS `:root[data-palette="…"]` token blocks (accent fully tokenized incl.
> `--accent-rgb` so glows flip); a no-flash `<head>` script pre-applies from localStorage; `/me`
> returns the user's palette; `POST /settings/me/palette` (self-service) persists it. Adding a 4th
> is: one `PALETTE_KEYS` entry (db.mjs + app.js), one CSS block, one `<option>`.

### What prompted it
As an end user the app "looks like someone took the safest path to *looks-like-a-modern-app*
(white, purple accents, rounded buttons) rather than design thought-through and specific to what
this app is." Before any redesign work, we needed a single point-of-view to execute everything
against. This decision is about the **look**; the **voice/whimsy** in the writing ("plotting
something delicious…") stays no matter which look we pick.

### The four options that were on the table

| # | Name | Feel | Palette (starting point) | Type direction |
|---|---|---|---|---|
| A | Warm family kitchen | Cozy heirloom recipe box, tactile, domestic | cream `#FAF4EA` · terracotta `#C8674B` · sage `#7C8B6F` · ink `#2E2A26` | Fraunces (titles) + Inter |
| B | Cooking-magazine editorial | Modern food publication, high-contrast, appetizing | paper `#FBFAF7` · near-black `#1A1A1A` · hot accent `#E4572E` | bold display serif + grotesque |
| C | Calm premium utility | Linear/Notion restraint, dark-mode-first, precise | near-white `#FCFCFD` / dark `#0E0E11` · accent `#3B82F6` | Inter, strict scale |
| **D ✅** | **Playful sous-chef** | **The whimsy, grown up — alive & fun, not childish** | **cream + tomato `#FF5A47` + basil `#2FA36B` (controlled)** | **rounded sans w/ character (General Sans / Cabinet Grotesk) + Inter** |

### The decision
**D — Playful sous-chef.**

**Rationale:** it keeps and *elevates* the personality the owner is already proud of, rather than
sanding it off toward safe-premium. The guardrail phrase is **"elevated, not childish."**

**What it touches:** the entire frontend design system — color tokens, typography, iconography,
motion/micro-interactions, component styling, empty/loading states, dark mode — applied across
every surface during the look-and-feel pass. It does **not** change the server, API, or data model.

### How to revisit
If we ever want to change direction, start here: re-read the four options above, and note that
A/B/C were all judged valid at decision time. A pivot means swapping the token set + type + icon
choices; the *architecture* of the design system (tokens driving both pages, one button system,
etc.) is POV-agnostic and carries over.

---

## Palettes considered / promoted

> Full swatches kept so any future pivot is one reference away. P-001 was parked, then PROMOTED to
> the ACTIVE palette the same night (Fresh market having been rejected — see DD-001's Palette Update).

### P-001 — "Soft pastel / candy" (✅ ACTIVE as of 2026-07-18)
A sweet, airy, candy-shop palette: cool mints/aquas flowing into warm peach and pinks, with a
hot-pink pop. A different mood from Fresh market's herby brightness — softer, more playful-cute.
(Note: it *does* lean pink — distinct from the vetoed Anthropic cream + red. The guardrail we're
holding: **"pink but not childish"**, enforced via "color is a scalpel" — soft pastels for the 90%,
hot Tickle-Me-Pink reserved for the one key action/state per screen.) Rob first parked this, then
chose it the same night after Fresh market was rejected; it is now the **active** palette.

**Token mapping (as implemented in kitchenbot.mjs):** `--accent` = Tickle Me Pink `#ff82bd`
(scalpel) · `--accent-strong` `#ec5aa4` (hover) · `--accent-soft` `#ffe1ef` · `--accent-blue`
(cool secondary, sparing) mint `#35c9bb` · bg = soft pink→mint wash · `--text-main` deep plum
`#3a2733` · white cards. The five source swatches below are the mood; the working tokens are tuned
for contrast/legibility from them.

| Name | Hex | RGB | Role sketch (tentative) |
|---|---|---|---|
| Ice Cold | `#b1f1e9` | rgb(177, 241, 233) | cool mint/aqua — could be a calm surface tint |
| Peppermint | `#e4f6e0` | rgb(228, 246, 224) | pale green — soft background |
| Pippin | `#ffe0dc` | rgb(255, 224, 220) | pale peach — warm surface |
| Pink | `#ffc4d7` | rgb(255, 196, 215) | light pink — secondary/soft accent |
| Tickle Me Pink | `#ff82bd` | rgb(255, 130, 189) | hot pink — the pop / primary accent |

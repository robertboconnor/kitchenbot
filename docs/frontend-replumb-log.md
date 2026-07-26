# Phase 5 — Frontend re-plumb, night 1 (2026-07-25)

Plain-language record of what changed, every judgment call made without asking, and how to reverse
any of it. Nothing here changes what the app *does* — no feature, no brain behaviour, no data.

**Everything is on `dev`. Nothing was pushed to `main`, so production is untouched.**

---

## Why this was worth doing

The entire user interface lived in two files that were never meant to hold it:

- **`kitchenbot.mjs`** — the whole page (markup *and* ~3,276 lines of CSS) sat inside a JavaScript
  backtick string. To an editor that is not a webpage, it is one enormous piece of text: no
  highlighting, no tag matching, no lint. A missing `</div>` was invisible until the page rendered
  wrong. This is why the `.g-item-name` alignment bug existed at all — there was nowhere to look.
- **`public/app.js`** — 4,994 lines, 153 top-level functions in one shared global scope, wired to
  the HTML by ~254 `getElementById('...')` string lookups. Rename an id and the JavaScript silently
  stops working, with nothing to catch it.

And the thing that made changing any of it genuinely risky: **182 tests, none covering the
frontend.**

## The order it was done in, and why

The safety net came first, deliberately. Every fast night on this project was fast *because* the
tests caught mistakes in seconds. Doing structural surgery on the one part of the codebase with no
tests would have been the opposite: mistakes land silently and surface a week later, mid-cooking.

| Step | What | Result |
|---|---|---|
| 1 | Frontend safety net | +6 tests |
| 2 | Delete dead memory-UI code the net found | −325 lines |
| 3 | CSS → real stylesheets | `kitchenbot.mjs` 6,530 → 3,252 |
| 4 | Markup → real HTML templates | `kitchenbot.mjs` 3,252 → 2,401 |
| 5 | `app.js` de-indent, module conversion, first extraction | `app.js` 4,994 → 4,473 |

**182 → 197 tests, all green.**

## What the safety net actually checks

`tests/frontend-shell.test.mjs` boots the **real server** on a throwaway database and asserts the
HTTP-level contract — never an internal function — so it keeps working no matter how the page is
assembled internally:

- every `getElementById` id in `app.js` exists in the served HTML
- the CSS the browser applies is byte-identical **including cascade order** (a rule that is lost,
  altered, or merely *reordered* fails the test)
- snapshot inventories of every CSS selector and element id
- core regions, all three palettes, the self-hosted font, the versioned script tags, the CSP header
- every referenced stylesheet/script actually resolves (no 404'd assets)

## It found a real bug on its first run

The id test failed immediately: 8 ids that `app.js` was still looking for did not exist. They were
leftovers from the **freeform memory feature deleted on 2026-07-24** — the UI was removed, but ~325
lines of client code that drove it were left behind, reading elements that no longer exist and
POSTing to `/settings/household/memory-notes`, a route that no longer exists. All of it was
null-guarded, so it never crashed; it simply never worked. Deleted.

## Judgment calls made without asking

1. **Did not adopt a framework.** Explicitly out of scope per your call, and nothing here needs one.
2. **Did not split `app.js` by feature** (chat / grocery / pantry / settings). 37 module-level
   variables are read *and written* across those features; splitting them changes real behaviour,
   and the net verifies structure, not runtime interaction — so a mistake would be invisible to it.
   This is the honest stopping point, and the next step.
3. **Kept `app.css` as one file.** Without a component system there is no natural boundary to split
   on, and multiple stylesheets add cascade-order risk for no gain. That split should follow
   whatever component structure a future framework decision establishes.
4. **`type="module"` is opt-in per page.** `app.js` opts in; `recipe-importer.js` deliberately does
   not — it was written as a classic script, and modules imply strict mode plus loss of global
   scope. Flipping it blindly could have broken the importer silently.
5. **Templates live in `views/`, not `public/`.** They are server-side templates, not static
   assets, and must not be independently fetchable.
6. **Placeholders are HTML comments** (`<!--KB:stylesheet-->`). An un-substituted one is inert in a
   browser instead of printing stray text, and the file stays valid HTML for tooling. A placeholder
   with no supplied value **throws** rather than rendering blank.
7. **Extraction targets were chosen by static analysis, not by feel.** The 22 functions in
   `cookbook-display.js` were verified to touch no shared state and no DOM, and their
   call-dependency closure pulled in exactly one external binding.

## How to reverse any of it

Each step is its own commit on `dev`, newest last:

```
b42e6db  docs: bring ROADMAP current
9d68a92  frontend safety net + delete dead memory-UI code
2d43053  lift all CSS into real stylesheets
03d9266  lift page markup into views/ templates
af88050  de-indent app.js, convert to module, extract cookbook-display
```

`git revert <hash>` undoes one step without touching the others. Reverting all of them returns the
frontend exactly to where it was this morning.

## UPDATE (same night): Playwright added — and it immediately caught a regression I caused

The gap below was closed. `@playwright/test` now drives a real Chromium against a real server
(`npm run test:e2e`, 10 tests, ~9s), logging into a **disposable test household** seeded in
`playwright.config.mjs` — no real credential is involved, and chat tests stub `/chat` so they
cost nothing.

**Within minutes it found a bug I introduced earlier that night.** Rob had noticed by eye that
`/recipe-importer` ignored his palette and asked that it be left alone. It turned out not to be a
pre-existing quirk — it was self-inflicted:

- The CSP pinned a **hardcoded sha256 of the inline palette pre-paint script**.
- Lifting the markup into `views/` **re-indented** that script, changing its bytes.
- The hash no longer matched, so the browser **blocked the script entirely**.
- The main app masked it (`app.js` re-applies the palette after `/me` loads); the importer has no
  such fallback, so it stayed on the default palette.

Confirmed by hashing the pre-extraction template (`sha256-2WlGCY…`, matching the CSP) against the
post-extraction one (`sha256-669et+…`, not matching).

**Fixed properly rather than by pasting a new hash:** `app-shell.inlineScriptCspHashes()` now
*derives* the hashes from the templates at startup, so editing an inline script can never again
silently break the policy. The former "known bug" test is now a passing regression guard.

This is the clearest possible argument for the harness: a real, user-visible bug, invisible to 197
structural tests, caught by a real browser within minutes.

**Render impact: none.** No Playwright package has an install script, so `npm install` never
downloads a browser — binaries arrive only via an explicit `npx playwright install`. No dashboard
change needed. Artifacts (`test-results/`, `playwright-report/`) are gitignored.

## ⚠️ Originally NOT verified — now largely covered by the above

**Static verification was thorough; runtime clicking was not possible.** The in-app browser preview
tool hung twice tonight (two 300-second timeouts), so I could not load the app and click through it.

What *was* verified: 197 automated tests, a clean strict-ES-module parse, no implicit globals, no
orphaned function calls, correct MIME types on the new module files, and byte-identical CSS.

What that cannot prove: that **interactions still behave** — the module conversion is the one change
that alters *how* the browser executes the code, and no test here exercises a real click.

**A 2-minute pass before merging to `main`:**

1. Open the app — does it look completely normal? (If the CSS lift broke, this is obvious instantly.)
2. Send a message in chat — does the reply stream in?
3. Tap 📎 — does the Camera / Photos / Files menu open?
4. Open Kitchen → tick a "This Week" meal, add a grocery item.
5. Open Cookbook → open a recipe, then **use the search box** (that logic moved into a module).
6. Open Settings → switch palette.
7. Visit `/recipe-importer` and confirm the page loads normally.

If anything misbehaves, the revert list above is the escape hatch — and the browser's developer
console will name the failing file directly, since the code now lives in real files.

## Where this leaves Phase 5

Roughly the mechanical two-thirds is done: the CSS, the markup, and the module groundwork. What
remains is the genuinely judgment-heavy part — untangling the 37 shared variables so `app.js` can
split by feature, and then deciding whether a framework earns its keep. Neither should start
without runtime tests or hands-on verification, for exactly the reason above.

# Phase 5 — Frontend re-plumb, night 2 (2026-07-26)

Companion to `frontend-replumb-log.md`. Same rules: plain language, every judgment call I made
without asking, and how to reverse any of it.

**Everything is on `dev`. `main` was not touched, so production is untouched.** There is a PR open
for you to read; nothing deploys until you click merge.

---

## Where this landed

`public/app.js` was 4,994 lines when this started, 2,209 at the end of night 1, and is now **144**.
It contains no feature logic at all any more — it builds the features, wires the two things that
genuinely span all of them, and starts the app.

| File | Lines | What it owns |
|---|---|---|
| `app.js` | 144 | composition root — build, wire, go |
| `modules/chat.js` | 1,018 | messages, history, chat list + sidebar, composer, realtime WebSocket |
| `modules/cookbook.js` | 863 | the cookbook |
| `modules/admin.js` | 843 | God Mode, household browser, usage reports |
| `modules/settings.js` | 657 | settings sub-views and their panels |
| `modules/inventory.js` | 442 | grocery list + pantry |
| `modules/auth.js` | 330 | login, first-run bootstrap, signed-out shell |
| `modules/cookbook-display.js` | 232 | pure text/search helpers |
| `modules/plan.js` | 217 | This Week |
| `modules/session.js` | 153 | who is signed in |
| `modules/navigation.js` | 137 | which tab you are on |
| `modules/attachments.js` | 183 | photo/file attach |
| `modules/palette.js` | 78 | colour theme |
| `modules/events.js` | 68 | the message bus |
| `modules/boot-data.js`, `device.js` | 37 | small shared facts |

Tests went **206 → 212** (node) and **22 → 23** (browser). All green.

## The shape you chose, in practice

You picked "each feature owns its state, talks via events" over one shared state file. That
decision held up. What it looks like now:

- Nothing reads another feature's variables. When settings changes your chat colour, it doesn't
  reach into chat — it updates `session.js` and announces it, and chat redraws itself.
- Navigation only says *where you went*. Features decide what that means for them. The Kitchen
  tab used to load groceries, pantry and cookbook every time; now each sub-view loads only when
  it's actually shown.
- Signing in, signing out, and God Mode's "exit impersonation" all travel the same path, because
  each one just announces "the identity changed" and `app.js` handles it in one place.

---

## The thing I'd want you to know about, if you only read one section

**The safety-net tool I built on night 1 was lying to me.**

`tools/check-client-refs.mjs` finds the one mistake that breaks this kind of refactor: code that
calls something which has moved to another file and wasn't imported back. In a browser that isn't a
subtle bug — the whole app fails to start.

It was stripping out comments and text using pattern matching. That works until it doesn't: a piece
of text containing certain nested characters made it lose track of where the text ended, so it
skipped **80% of `app.js`** and reported "all clear."

I only caught it because a result looked too clean to be true. When I rebuilt the checker properly
and re-ran it, it immediately found **five real defects that earlier green test runs had hidden**:

1. **The grocery list's "Clear" button visibility was broken** — the code that shows or hides it
   referenced something that had moved, and the error was being swallowed by a surrounding
   catch-all. Silently, invisibly broken.
2. The cookbook's hash-navigation guard referenced state that had moved.
3. Settings referenced five things that had moved.
4. God Mode's "exit impersonation" called into the login shell directly instead of announcing.
5. `app.js` called a settings function that had moved.

None of these were caught by 206 node tests and 22 browser tests, because the node tests never run
browser code and the browser tests didn't happen to click those exact controls.

The rebuilt checker now: uses a real tokenizer instead of pattern matching, checks plain references
as well as function calls, **refuses to report "all clear" if it can't read the whole file**, and
has its own tests (`tests/client-static-checks.test.mjs`). I also added a second checker for the
other way this breaks (`tools/check-client-imports.mjs`), and wired both into `npm test` so they
can't quietly rot again.

Twice more during the night the checker found a hole in itself the same way — it was reading
`if (something && ...)` as if `something` were being declared, which hid exactly the class of bug
it exists to find. Both holes are closed and covered by tests.

**The lesson, and it's not a small one:** a tool that under-reports is worse than no tool, because
you trust it. That's now written at the top of both files so the next person doesn't re-learn it.

---

## Judgment calls I made without asking

You said "anything iffy, still do it — use your best judgment." Here they are.

1. **Chat and realtime are one module, not two.** They look like two features but they share the
   same handful of variables (am I streaming, which bubble is live, is there unread content, where
   is the scroll). Splitting them would have meant exporting that state across a boundary, which
   is the exact coupling this whole refactor exists to remove. Same reasoning as grocery + pantry
   sharing `inventory.js`. It's the biggest module at 1,018 lines; I think that's correct rather
   than lazy, but it's the one I'd most expect you to push back on.

2. **I rebuilt the checker mid-refactor instead of pressing on.** It cost time. But every remaining
   step depended on it, and it had already been wrong once.

3. **Chat colours and the assistant's name moved into `session.js`.** They were being treated as
   chat state, but settings writes them and chat reads them — that's identity, not chat.

4. **`app.js` no longer sets the "who's speaking" label.** Chat watches for the signed-in user
   changing and sets it itself.

5. **Deleted 62 stale imports and 13 unused DOM lookups** from `app.js` — leftovers pointing at
   code that had moved. Also a duplicate copy of the settings sub-view map.

6. **Boot order is now explicit.** Before, `app.js` started checking your login *before* the
   features had finished setting themselves up, and only worked because of exactly how JavaScript
   schedules things. Now starting is the last line of the file.

7. **I updated four older tests** that asserted "this code is in `app.js`". They now assert the
   behaviour still exists wherever it lives. I did not delete any assertions.

8. **`reapplyVisibleAppTab` moved into navigation** and now reads the page directly instead of
   borrowing settings' internals.

---

## One real regression I caused, found, and fixed

Moving the Kitchen sub-tab buttons into navigation meant nothing was left subscribing to reload the
cookbook, so **opening the cookbook sub-tab showed an empty panel until a full page reload.**

All 22 browser tests still passed — because they asserted the panel was *visible*, not that it had
anything in it. Fixed, and `e2e/kitchen.spec.mjs` now asserts the recipes are actually there. That
test would have caught it.

## Pre-existing bugs found and deliberately NOT fixed

Per your "fix mine, log theirs" rule:

- **`/plan` routes still demand a `chatId`** they don't use. `GET`, `PATCH` and `DELETE` all return
  a 400 without one, even though the meal plan is household-wide now and the code that reads it
  ignores the value entirely. Harmless today because the UI always sends one. Vestigial from when
  plans were per-chat.

## How to undo any of it

Each commit is one module and was fully green before the next one started, so any single one can be
reverted on its own:

| Commit | What |
|---|---|
| `a79a369` | chat + auth + tab bar; `app.js` becomes a composition root |
| `7f4fed3` | settings; checker rebuilt |
| `9b38d8a` | God Mode / admin |
| `162d046` | session consolidation |
| `3e83d3e` | This Week |
| `b9b308b` | grocery + pantry |
| `b0c89db` | cookbook |
| `d181323` | navigation |

Tell me which one and I'll revert it for you — you don't need to run anything.

## What I checked before saying it works

- 212 node tests, 23 browser tests (real Chromium, real clicking), all green.
- Both static checkers clean.
- **Booted the real app in a browser against a copy of your actual database**: all 15 module files
  load, zero console errors, the login page renders correctly. The browser tests use a synthetic
  household, so this was the check that the real data shape doesn't break anything.

## What I could not check

I don't sign in with your PIN, so everything below the login screen was verified by the automated
browser tests (which use a disposable test household), not by me clicking as you. Worth five
minutes of your own clicking before you merge — chat especially: send a message, switch chats,
open the sidebar, and check This Week still appears above the messages.

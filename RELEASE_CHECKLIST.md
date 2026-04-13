# KitchenBot Live Release Checklist

## Pre-Deploy

- Back up the live SQLite database before deploying.
- For any local DB-mutating debug/test command, set an explicit non-default `DB_PATH` instead of touching `./kitchenbot.db`.
- Confirm the deploy environment points at the intended DB path and does not set `RESET_DB_ON_START=1`.
- Confirm `INITIAL_*` env vars are present only if bootstrap recovery is intentionally desired.
- Confirm the Anthropic server key and any production household BYO-key expectations are understood.
- Run `npm test`.
- Start the app locally against a realistic DB and verify it boots without triggering bootstrap unexpectedly.
- Verify the current build includes:
  - additive grocery writes by default
  - live duplicate checks for direct KB grocery adds
  - pantry-candidate inheritance and KB direct-add pantry highlighting
  - cookbook source/provenance display and smarter save shaping
  - transient KB progress narration during longer turns

## Smoke Test

### Auth and startup

- Log in as an owner.
- Log in as a non-owner.
- Log out and log back in.
- Verify the login screen renders correctly on desktop and mobile-width.

### Chat and realtime

- Open the same chat in two sessions.
- Send a message in session A and verify session B updates automatically.
- Scroll session B upward, send a new message from session A, and verify:
  - session B does not jump to the bottom
  - the `New message` indicator appears
  - tapping it jumps to the latest message
- Background and resume a mobile browser session and verify the current chat refreshes.
- During a longer KB turn, verify:
  - the sender sees truthful transient progress steps instead of only `Thinking…`
  - another live viewer in the same chat sees the same transient progress
  - the progress bubble turns into the streamed reply
  - the progress text does not remain in stored history after reload

### Pantry and grocery

- Add pantry items manually.
- Add grocery items manually.
- Move pantry -> grocery and grocery -> pantry.
- Check and uncheck grocery items.
- Generate a grocery list from chat and verify pantry-aware behavior still excludes on-hand items.
- Ask KB to add a direct pantry-ish item like `white pepper` or `powdered sugar` to the grocery list, check it off, and verify `Move to pantry` turns green.
- Ask KB to add a direct refrigerated item like `yogurt` or `cream cheese` to the grocery list, check it off, and verify `Move to pantry` does not turn green.
- Ask KB to add a direct duplicate grocery item that already exists and verify KB truthfully reports the live duplicate without adding another row.
- Ask KB to add grocery items in chunks across multiple turns and verify the list stays additive unless replace/reset was explicitly requested.

### Cookbook

- Save a cookbook recipe from pasted text.
- Save a cookbook recipe from a URL that succeeds.
- Try a blocked URL flow and verify KB pivots to manual paste truthfully.
- Open, edit, and save a cookbook recipe.
- Save an expanded recipe from chat after a cookbook clarification follow-up and verify the real recipe is saved, not a stale meal-plan item.
- Verify cookbook overview cards show `category • provenance • updated date`, plus a separate `Source:` row with a clickable link when a source URL exists.
- Verify category, tag, and search filters all work together on desktop and mobile-width.
- Delete a cookbook recipe.
- Use a cookbook recipe for planning and grocery generation.

### Settings and usage

- As owner, verify household Anthropic settings render correctly.
- Verify household Anthropic usage loads with date + web-search-used filters.
- As global admin, verify household selection, household detail, and Anthropic usage render correctly on mobile-width.
- Verify usage tables remain horizontally scrollable without widening the whole screen.

## Post-Deploy Checks

- Confirm the server starts cleanly with no migration/bootstrap errors.
- Confirm `/me`, `/chats`, `/history`, `/cookbook`, and usage/settings routes respond normally.
- Confirm Anthropic usage rows are still being recorded and attributed sanely.
- Confirm no unexpected `url_not_allowed`, auth, or missing-key errors are appearing for ordinary chat turns.
- Confirm long KB turns still complete even when multiple transient progress updates appear.

## Rollback Triggers

Rollback immediately if any of these happen:

- Login is broken for ordinary users.
- Chat turns stop persisting or rendering reliably.
- Concurrent chat viewing is stale or causes repeated jumps/duplicates.
- Live progress narration gets stuck, persists into history, or causes duplicate assistant bubbles.
- Pantry, grocery, or cookbook mutations fail or misreport success.
- Settings/admin screens are unusable on mobile.
- Startup triggers bootstrap unexpectedly against the live DB.

## Rollback Procedure

- Stop the new app version.
- Restore the prior application version.
- If the deploy included an unintended DB mutation, restore the pre-deploy DB backup.
- Re-run the auth and chat smoke checks before reopening access.

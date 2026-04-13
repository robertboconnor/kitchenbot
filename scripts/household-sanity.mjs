import 'dotenv/config';
import { RESOLVED_DB_PATH, listHouseholdDebugSummary } from '../db.mjs';

const rows = await listHouseholdDebugSummary();

console.log(`KitchenBot DB: ${RESOLVED_DB_PATH}`);
if (!rows.length) {
  console.log('No households found.');
  process.exit(0);
}

for (const row of rows) {
  console.log(
    [
      `#${row.id}`,
      row.name || 'Unnamed household',
      `key=${row.householdKey || '—'}`,
      `chats=${row.chatCount}`,
      `cookbook=${row.cookbookCount}`,
    ].join(' | ')
  );
}

// Boots the REAL KitchenBot server in a child process against a throwaway DB, so tests can
// assert on what the app actually serves over HTTP. Deliberately end-to-end: the frontend net
// must keep passing while the page's internals get re-plumbed (CSS/HTML/JS extracted into real
// files), so it tests the HTTP contract — never an internal render function.
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFileCb);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ask the OS for a free port, then release it. A racing process could steal it in the gap, so
// startKitchenbotServer's own 'error' path is what ultimately reports a collision.
async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Boot the server, hand `run` a fetch-ready base URL, then always tear it down.
 * The child gets its own temp DB_PATH, so it never touches the developer's kitchenbot.db.
 */
export async function withKitchenbotServer(label, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `kb-server-${label}-`));
  const dbPath = path.join(tempDir, `${label}.db`);
  const port = await findFreePort();

  const child = spawn(process.execPath, ['kitchenbot.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      KITCHENBOT_SECRET: 'test-secret-not-a-real-key',
      // Keep the boot hermetic: no redis, no env-seeded household, no live Anthropic calls.
      REDIS_URL: '',
      INITIAL_HOUSEHOLD_KEY: '',
      INITIAL_OWNER_PIN: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start in 20s. Output:\n${logs.join('')}`)),
      20000
    );
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Server running at')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}). Output:\n${logs.join('')}`));
    });
  });

  try {
    await ready;
    return await run({ baseUrl: `http://127.0.0.1:${port}`, dbPath, tempDir });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// ── Signing in, for tests that need a route behind requireAuth ───────────────────
// The server boots with no household (the helper above clears the INITIAL_* seed vars), so a test
// creates its own throwaway one over the app's real bootstrap + login routes. The PIN here is
// fixture data for a temp database that is deleted at the end of the test — it is not anyone's
// credential.
const FIXTURE = {
  householdName: 'Test Kitchen',
  householdKey: 'test-kitchen',
  ownerDisplayName: 'Tester',
  pin: '4321',
};

/**
 * Bootstrap a household and sign in. Returns `{ headers, householdId, userId }` — spread `headers`
 * into any fetch that needs to be authenticated.
 */
export async function signInAsFixtureOwner(baseUrl) {
  const boot = await fetch(`${baseUrl}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(FIXTURE),
  });
  if (!boot.ok) throw new Error(`bootstrap failed (${boot.status}): ${await boot.text()}`);

  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      householdKey: FIXTURE.householdKey,
      displayName: FIXTURE.ownerDisplayName,
      pin: FIXTURE.pin,
    }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status}): ${await login.text()}`);

  // node's fetch does not keep a cookie jar, so carry the session cookie by hand.
  const cookie = (login.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = { cookie };

  const me = await (await fetch(`${baseUrl}/me`, { headers })).json();
  return { headers, householdId: me.householdId, userId: me.userId };
}

/**
 * Run a snippet against the server's database, in its own process. Used to seed state that has no
 * HTTP route of its own (the meal plan is only ever written by the brain). `body` gets `db` and
 * whatever it needs from it.
 */
export async function runAgainstDb(dbPath, body) {
  const script = `
    const db = await import(new URL('./db.mjs?child=' + Date.now(), 'file://' + process.cwd() + '/').href);
    ${body}
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, DB_PATH: dbPath },
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

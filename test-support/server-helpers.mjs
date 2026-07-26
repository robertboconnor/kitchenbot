// Boots the REAL KitchenBot server in a child process against a throwaway DB, so tests can
// assert on what the app actually serves over HTTP. Deliberately end-to-end: the frontend net
// must keep passing while the page's internals get re-plumbed (CSS/HTML/JS extracted into real
// files), so it tests the HTTP contract — never an internal render function.
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function uniqueImportSuffix(label = 'test') {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function withTempDb(label, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `kb-${label}-`));
  const dbPath = path.join(tempDir, `${label}.db`);
  const previousDbPath = process.env.DB_PATH;
  const previousTestGuard = process.env.KB_TEST_GUARD;
  process.env.DB_PATH = dbPath;
  process.env.KB_TEST_GUARD = '1';
  try {
    return await run({
      tempDir,
      dbPath,
      importFresh: async (modulePath, suffix = label) => {
        const url = new URL(`${modulePath}?${uniqueImportSuffix(suffix)}`, import.meta.url);
        return await import(url.href);
      },
    });
  } finally {
    if (previousDbPath == null) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    if (previousTestGuard == null) delete process.env.KB_TEST_GUARD;
    else process.env.KB_TEST_GUARD = previousTestGuard;
  }
}

export async function execFileWithTempDb(label, args, options = {}) {
  return await withTempDb(label, async ({ tempDir, dbPath }) => {
    const cwd = options.cwd || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const env = {
      ...process.env,
      ...options.env,
      DB_PATH: dbPath,
      KB_TEST_GUARD: '1',
    };
    const result = await execFileAsync(process.execPath, args, { ...options, cwd, env });
    return { ...result, tempDir, dbPath };
  });
}

export async function startKitchenbotServerWithTempDb(label, setup) {
  return await withTempDb(label, async ({ tempDir, dbPath, importFresh }) => {
    if (typeof setup === 'function') {
      await setup({ tempDir, dbPath, importFresh });
    }
    const port = 3200 + Math.floor(Math.random() * 1000);
    const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const child = spawn(process.execPath, ['kitchenbot.mjs'], {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        KB_TEST_GUARD: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const readyDeadline = Date.now() + 15000;
    while (Date.now() < readyDeadline) {
      if (child.exitCode != null) {
        throw new Error(`KitchenBot server exited early.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      try {
        const response = await fetch(`${baseUrl}/bootstrap/status`);
        if (response.ok) {
          return {
            tempDir,
            dbPath,
            baseUrl,
            stdout,
            stderr,
            stop: async () => {
              if (child.exitCode != null) return;
              child.kill('SIGTERM');
              await new Promise((resolve) => child.once('exit', () => resolve()));
            },
          };
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', () => resolve()));
    throw new Error(`KitchenBot server did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
}

// The eval runner. THIS SPENDS REAL MONEY — see evals/README.md.
//
//   node evals/run.mjs --dry-run                      # free: scenario table + cost estimate
//   node evals/run.mjs --calibrate --yes              # ~$0.05: prove the judge fails known-bad replies
//   node evals/run.mjs --yes                          # full run
//   node evals/run.mjs --only succotash-hold --reps 1 --yes
//   node evals/run.mjs --compare evals/baselines/pre-craft.json --yes
//
// Exit codes: 0 clean · 1 a criterion regressed vs the baseline, or a scenario failed · 2 harness error.
import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

import { CALIBRATION, SCENARIOS } from './scenarios.mjs';
import { judgeReply } from './judge.mjs';
import { runChecks, runGlobalInvariants } from './checks.mjs';
import { compareToBaseline, countCleanReps, renderComparison, renderConsole } from './report.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COST_PER_SCENARIO_REP = 0.05; // conservative; the real figure is reported after the run

function parseArgs(argv) {
  const args = { reps: 3, concurrency: 4, only: null, label: '', compare: null, dryRun: false, calibrate: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--calibrate') args.calibrate = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--reps') args.reps = Number(argv[++i]) || 1;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || 1;
    else if (a === '--only') args.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--label') args.label = String(argv[++i] || '');
    else if (a === '--compare') args.compare = String(argv[++i] || '');
  }
  return args;
}

function selectedScenarios(args) {
  return args.only ? SCENARIOS.filter((s) => args.only.includes(s.id)) : SCENARIOS;
}

async function runChild(scenarioId, rep) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `kb-eval-${scenarioId}-`));
  const dbPath = path.join(tempDir, 'eval.db');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['evals/run-one.mjs', scenarioId, String(rep)],
      {
        cwd: ROOT,
        // Explicit env, never a mutated process.env — children run concurrently.
        env: { ...process.env, DB_PATH: dbPath, KB_TEST_GUARD: '1' },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 180000,
      }
    );
    return JSON.parse(stdout.trim());
  } catch (error) {
    return { scenarioId, rep, ok: false, error: String(error?.message || error) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Bounded-concurrency map. Keeps the API from being hit with 39 requests at once. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const scenarios = selectedScenarios(args);

  if (!scenarios.length) {
    console.error('No scenarios selected.');
    process.exit(2);
  }

  if (args.calibrate) return await calibrate(anthropicKey, args);

  const totalRuns = scenarios.length * args.reps;
  const estimate = (totalRuns * COST_PER_SCENARIO_REP).toFixed(2);

  console.log(`${scenarios.length} scenarios × ${args.reps} reps = ${totalRuns} runs`);
  for (const s of scenarios) console.log(`  ${s.id.padEnd(30)} ${s.title}`);
  console.log(`\nestimated cost: ~$${estimate} (real figure reported after the run)`);

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was called.');
    return;
  }
  if (!args.yes) {
    console.log('\nThis calls the real Anthropic API and spends money. Re-run with --yes to proceed.');
    process.exit(0);
  }
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(2);
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const started = Date.now();

  const jobs = [];
  for (const scenario of scenarios) {
    for (let rep = 1; rep <= args.reps; rep += 1) jobs.push({ scenario, rep });
  }

  let costUsd = 0;
  const runs = await mapLimit(jobs, args.concurrency, async ({ scenario, rep }) => {
    const child = await runChild(scenario.id, rep);
    if (!child.ok) {
      console.error(`  ✗ ${scenario.id} rep ${rep}: ${child.error}`);
      return { scenarioId: scenario.id, rep, ok: false, error: child.error, verdicts: [], checkResults: [], invariants: [] };
    }
    costUsd += child.usage?.totals?.estimatedCostUsd || 0;

    const checkResults = runChecks(scenario, child);
    const invariants = runGlobalInvariants(child);
    const judged = scenario.criteria?.length
      ? await judgeReply(anthropic, { prompt: scenario.prompt, reply: child.reply, criteria: scenario.criteria, priorTurns: scenario.history })
      : { verdicts: [], missing: [], costUsd: 0, error: null };
    costUsd += judged.costUsd;

    // A criterion the judge failed to return is a FAILURE, never a silent pass.
    const missingAsFailures = (judged.missing || []).map((id) => ({
      id, pass: false, evidence: '', rationale: 'judge returned no verdict for this criterion',
    }));

    process.stdout.write('.');
    return {
      scenarioId: scenario.id,
      rep,
      ok: true,
      reply: child.reply,
      toolTrace: child.toolTrace,
      usage: child.usage,
      verdicts: [...judged.verdicts, ...missingAsFailures],
      missing: judged.missing,
      checkResults,
      invariants,
      judgeError: judged.error,
    };
  });
  process.stdout.write('\n\n');

  const wallMs = Date.now() - started;
  console.log(renderConsole(runs, { costUsd, wallMs, label: args.label }));

  const artifact = {
    label: args.label || 'unlabelled',
    createdAt: new Date().toISOString(),
    reps: args.reps,
    scenarioCount: scenarios.length,
    costUsd,
    runs,
  };
  const outDir = path.join(ROOT, 'evals', 'results');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${artifact.createdAt.replace(/[:.]/g, '-')}-${artifact.label}.json`);
  await fs.writeFile(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);

  let exitCode = 0;
  const failedScenarios = scenarios.filter((s) => {
    const mine = runs.filter((r) => r.scenarioId === s.id);
    return countCleanReps(mine) < mine.length;
  });
  if (failedScenarios.length) exitCode = 1;

  if (args.compare) {
    const baseline = JSON.parse(await fs.readFile(path.resolve(ROOT, args.compare), 'utf8'));
    const comparison = compareToBaseline(runs, baseline);
    console.log(renderComparison(comparison));
    if (comparison.regressed > 0) exitCode = 1;
    else if (failedScenarios.length) {
      // Against a baseline, a still-failing scenario that did not get WORSE is not a regression —
      // report it, but do not fail the run for it.
      console.log('\n(scenarios still failing, but nothing regressed vs baseline)');
      exitCode = 0;
    }
  }
  process.exit(exitCode);
}

/**
 * Grade hand-written KNOWN-BAD replies. If the judge passes any of them it is too lenient, and
 * every green result it has ever produced is noise. Same lesson as the reference checker that
 * reported "clean" while skipping 80% of a file: a tool that under-reports is worse than none.
 */
async function calibrate(anthropicKey, args) {
  console.log(`Calibrating the judge against ${CALIBRATION.length} known-bad replies.`);
  if (args.dryRun) return console.log('--dry-run: nothing was called.');
  if (!args.yes) return console.log('Re-run with --yes to proceed (~$0.05).');
  if (!anthropicKey) { console.error('ANTHROPIC_API_KEY is not set.'); process.exit(2); }

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  let leniency = 0;
  let costUsd = 0;

  for (const item of CALIBRATION) {
    const scenario = SCENARIOS.find((s) => s.id === item.scenarioId);
    const judged = await judgeReply(anthropic, {
      prompt: scenario.prompt, reply: item.reply, criteria: scenario.criteria, priorTurns: scenario.history,
    });
    costUsd += judged.costUsd;

    const wronglyPassed = item.mustFail.filter((id) => judged.verdicts.find((v) => v.id === id)?.pass);
    const notReturned = item.mustFail.filter((id) => !judged.verdicts.some((v) => v.id === id));
    const bad = [...wronglyPassed, ...notReturned];
    leniency += bad.length;

    console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${item.label}`);
    for (const id of item.mustFail) {
      const v = judged.verdicts.find((x) => x.id === id);
      const mark = !v ? 'NO VERDICT' : v.pass ? 'WRONGLY PASSED' : 'correctly failed';
      console.log(`    ${id.padEnd(28)} ${mark}${v && !v.pass ? ` — ${v.rationale}` : ''}`);
    }
  }

  console.log(`\ncost $${costUsd.toFixed(2)}`);
  if (leniency > 0) {
    console.error(`\nJUDGE IS TOO LENIENT: ${leniency} criteria it should have failed, it did not.`);
    console.error('Fix the criteria wording or the judge prompt before trusting any green result.');
    process.exit(1);
  }
  console.log('\nJudge correctly failed every known-bad reply. Green results from it mean something.');
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

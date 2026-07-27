// The eval harness grades whether KitchenBot cooks well. These tests grade the harness.
//
// They are hermetic and free — no API calls. They exist because the eval's own failure modes are
// silent: a judge parser that drops verdicts, a check that always passes, or (worst) an eval file
// that `npm test` picks up and starts billing for on every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseJudgeResponse } from '../evals/judge.mjs';
import { runChecks, runGlobalInvariants } from '../evals/checks.mjs';
import { compareToBaseline, countCleanReps, tallyCriteria } from '../evals/report.mjs';
import { CALIBRATION, SCENARIOS } from '../evals/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('evals are NOT discovered by `npm test` (they would spend money on every run)', async () => {
  // `npm test` is `node --test` with no path, so it auto-discovers these patterns anywhere in the
  // tree. If an eval file ever matches one, every test run starts calling the real API.
  const names = await fs.readdir(path.join(ROOT, 'evals'));
  const discoverable = names.filter(
    (n) => /\.test\.[cm]?js$/.test(n) || /^test[-.]/.test(n) || /[-_]test\.[cm]?js$/.test(n) || n === 'test'
  );
  assert.deepEqual(discoverable, [], `these evals/ entries would be run by \`npm test\`: ${discoverable.join(', ')}`);

  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['eval:craft'], 'eval:craft script should exist');
  assert.doesNotMatch(pkg.scripts['test:all'] || '', /eval/, 'evals must never be part of test:all');
  assert.doesNotMatch(pkg.scripts.test || '', /eval/, 'evals must never be part of npm test');
});

test('judge parser: reads verdicts, and drops nothing silently', () => {
  const response = {
    content: [
      { type: 'text', text: 'ignored' },
      {
        type: 'tool_use',
        name: 'report_criteria_verdicts',
        input: {
          verdicts: [
            { id: 'acid-after-hold', pass: true, evidence: 'stir in the vinegar', rationale: 'held to the end' },
            { id: '', pass: true, evidence: '', rationale: 'no id — must be dropped' },
            { id: 'no-tips-section', pass: false, evidence: 'Tips:', rationale: 'has one' },
          ],
        },
      },
    ],
  };
  const verdicts = parseJudgeResponse(response);
  assert.equal(verdicts.length, 2, 'the id-less verdict is dropped');
  assert.equal(verdicts[0].pass, true);
  assert.equal(verdicts[1].pass, false);
});

test('judge parser: a malformed or missing tool call yields no verdicts (never a silent pass)', () => {
  assert.deepEqual(parseJudgeResponse({ content: [{ type: 'text', text: 'hi' }] }), []);
  assert.deepEqual(parseJudgeResponse({}), []);
  assert.deepEqual(parseJudgeResponse(null), []);
  // `pass` must be exactly true; anything else is a failure, so a garbled verdict cannot pass.
  const fuzzy = parseJudgeResponse({
    content: [{ type: 'tool_use', name: 'report_criteria_verdicts', input: { verdicts: [{ id: 'x', pass: 'yes' }] } }],
  });
  assert.equal(fuzzy[0].pass, false, '"yes" is not true');
});

test('deterministic checks decide what they claim to decide', () => {
  const scenario = {
    checks: [
      { kind: 'tool_called', name: 'grocery.write' },
      { kind: 'max_words', n: 5 },
      { kind: 'grocery_contains', items: ['buttermilk'] },
    ],
  };
  const good = runChecks(scenario, {
    reply: 'Added those three.',
    toolTrace: [{ name: 'grocery_write' }], // underscore form must match the dotted name
    finalState: { grocery: [{ name: 'Buttermilk' }] },
  });
  assert.deepEqual(good.map((c) => c.pass), [true, true, true]);

  const bad = runChecks(scenario, {
    reply: 'I have added all of the items you asked for to your grocery list just now.',
    toolTrace: [],
    finalState: { grocery: [] },
  });
  assert.deepEqual(bad.map((c) => c.pass), [false, false, false]);
});

test('claim_requires_tool pins the truthfulness contract, and passes vacuously when nothing is claimed', () => {
  const scenario = { checks: [{ kind: 'claim_requires_tool', phrase: /added .* to the plan/i, name: 'plan.add' }] };
  const lying = runChecks(scenario, { reply: 'I added them to the plan.', toolTrace: [] });
  assert.equal(lying[0].pass, false, 'claimed a write with no tool call');

  const honest = runChecks(scenario, { reply: 'I added them to the plan.', toolTrace: [{ name: 'plan_add' }] });
  assert.equal(honest[0].pass, true);

  const silent = runChecks(scenario, { reply: 'Here are three ideas.', toolTrace: [] });
  assert.equal(silent[0].pass, true, 'no claim made, so nothing to back up');
});

test('global invariant catches per-turn text being pushed into the cached system block', () => {
  const ok = runGlobalInvariants({ reply: 'hi', systemBlockCounts: [1, 1, 1] });
  assert.equal(ok.find((i) => i.id === 'system_is_one_cached_block').pass, true);

  const split = runGlobalInvariants({ reply: 'hi', systemBlockCounts: [1, 2] });
  assert.equal(split.find((i) => i.id === 'system_is_one_cached_block').pass, false);

  const empty = runGlobalInvariants({ reply: '', systemBlockCounts: [1] });
  assert.equal(empty.find((i) => i.id === 'reply_not_empty').pass, false);
});

test('a rep is clean only when EVERY criterion, check and invariant passed', () => {
  const base = { verdicts: [{ id: 'a', pass: true }], checkResults: [{ id: 'b', pass: true }], invariants: [{ id: 'c', pass: true }] };
  assert.equal(countCleanReps([base]), 1);
  assert.equal(countCleanReps([{ ...base, checkResults: [{ id: 'b', pass: false }] }]), 0);
  // A criterion the judge never returned a verdict for must not count as clean.
  assert.equal(countCleanReps([{ ...base, missing: ['d'] }]), 0);
});

test('baseline comparison flags a regression and does not flag an improvement', () => {
  const baseline = { runs: [{ scenarioId: 's', verdicts: [{ id: 'kept', pass: true }, { id: 'lost', pass: true }], checkResults: [] }] };
  const now = [{ scenarioId: 's', verdicts: [{ id: 'kept', pass: true }, { id: 'lost', pass: false }], checkResults: [] }];
  const cmp = compareToBaseline(now, baseline);
  assert.equal(cmp.regressed, 1);
  assert.equal(cmp.rows.find((r) => r.id === 'lost').direction, 'REGRESSED');

  const better = compareToBaseline(
    [{ scenarioId: 's', verdicts: [{ id: 'kept', pass: true }, { id: 'lost', pass: true }], checkResults: [] }],
    { runs: [{ scenarioId: 's', verdicts: [{ id: 'kept', pass: true }, { id: 'lost', pass: false }], checkResults: [] }] }
  );
  assert.equal(better.regressed, 0);
  assert.equal(better.improved, 1);
});

test('the scenario set keeps its over-correction traps and its regression guards', () => {
  // The likeliest way "teach it to cook" goes wrong is OVER-correction. If someone trims the
  // scenario set later, these are the ones that must not go.
  const ids = new Set(SCENARIOS.map((s) => s.id));
  for (const required of [
    'succotash-hold',
    'quick-pickle-early-acid',
    'yogurt-lemon-marinade',
    'braise-improves-ahead',
    'weeknight-no-constraint',
    'regression-grocery-add',
    'regression-allergy-plan',
    'regression-plan-recall',
  ]) {
    assert.ok(ids.has(required), `scenario "${required}" must exist`);
  }

  for (const scenario of SCENARIOS) {
    assert.ok(scenario.prompt?.trim(), `${scenario.id} needs a prompt`);
    const graded = (scenario.criteria?.length || 0) + (scenario.checks?.length || 0);
    assert.ok(graded > 0, `${scenario.id} grades nothing`);
    for (const c of scenario.criteria || []) {
      assert.ok(['must', 'must_not'].includes(c.kind), `${scenario.id}/${c.id} has an invalid kind`);
      assert.ok(c.text?.trim(), `${scenario.id}/${c.id} has no text`);
    }
  }
});

test('every calibration reply targets real criteria on a real scenario', () => {
  // A calibration item pointing at a criterion id that no longer exists would silently stop
  // guarding anything, which is exactly the failure mode calibration exists to prevent.
  for (const item of CALIBRATION) {
    const scenario = SCENARIOS.find((s) => s.id === item.scenarioId);
    assert.ok(scenario, `calibration references unknown scenario ${item.scenarioId}`);
    assert.ok(item.reply.trim().length > 40, `${item.label}: reply too short to be a realistic bad answer`);
    for (const id of item.mustFail) {
      assert.ok(
        scenario.criteria.some((c) => c.id === id),
        `calibration "${item.label}" expects criterion "${id}" which ${item.scenarioId} does not define`
      );
    }
  }
});

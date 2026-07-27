// Rendering and baseline comparison.
//
// The comparison is the point. A single run's score is nearly meaningless — the loop sets no
// temperature, so replies vary — but a per-criterion delta against a committed baseline is real
// evidence. That committed baseline JSON is the artifact a human reviews.

function pct(n, d) {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Collapse reps into per-criterion pass counts: { [scenarioId]: { [criterionId]: {pass, total} } }. */
export function tallyCriteria(runs) {
  const tally = {};
  for (const run of runs) {
    const bucket = (tally[run.scenarioId] ||= {});
    for (const v of [...(run.verdicts || []), ...(run.checkResults || [])]) {
      const cell = (bucket[v.id] ||= { pass: 0, total: 0 });
      cell.total += 1;
      if (v.pass) cell.pass += 1;
    }
  }
  return tally;
}

export function renderConsole(runs, { costUsd, wallMs, label }) {
  const tally = tallyCriteria(runs);
  const lines = [];
  let scenarioPass = 0;
  let scenarioTotal = 0;
  let critPass = 0;
  let critTotal = 0;

  for (const scenarioId of Object.keys(tally)) {
    const cells = tally[scenarioId];
    const ids = Object.keys(cells);
    const reps = Math.max(...ids.map((id) => cells[id].total), 0);
    const cleanReps = countCleanReps(runs.filter((r) => r.scenarioId === scenarioId));
    scenarioTotal += 1;
    if (cleanReps === reps && reps > 0) scenarioPass += 1;

    for (const id of ids) {
      critPass += cells[id].pass;
      critTotal += cells[id].total;
    }

    const mark = cleanReps === reps ? '✓' : '✗';
    lines.push(`${scenarioId.padEnd(30)} ${cleanReps}/${reps}  ${mark}`);
    for (const id of ids) {
      const cell = cells[id];
      if (cell.pass === cell.total) continue;
      const example = runs
        .filter((r) => r.scenarioId === scenarioId)
        .flatMap((r) => [...(r.verdicts || []), ...(r.checkResults || [])])
        .find((v) => v.id === id && !v.pass);
      const why = example?.rationale || example?.detail || '';
      lines.push(`  ${'↳'} ${id.padEnd(28)} ${cell.pass}/${cell.total}  ${why.slice(0, 90)}`);
    }
  }

  const wordCounts = runs.map((r) => String(r.reply || '').trim().split(/\s+/).filter(Boolean).length);
  lines.push('─'.repeat(64));
  lines.push(`scenarios ${scenarioPass}/${scenarioTotal}   criteria ${critPass}/${critTotal} (${pct(critPass, critTotal)})`);
  lines.push(`median reply length ${median(wordCounts)} words`);
  lines.push(`cost  $${costUsd.toFixed(2)}`);
  lines.push(`wall  ${Math.round(wallMs / 1000)}s${label ? `   label: ${label}` : ''}`);
  return lines.join('\n');
}

/** A rep is clean when every judged criterion AND every deterministic check passed. */
export function countCleanReps(scenarioRuns) {
  let clean = 0;
  for (const run of scenarioRuns) {
    const all = [...(run.verdicts || []), ...(run.checkResults || []), ...(run.invariants || [])];
    if (all.length && all.every((v) => v.pass) && !run.missing?.length) clean += 1;
  }
  return clean;
}

/**
 * Compare a run against a committed baseline. Returns { rows, regressed, improved }.
 * `regressed` is what makes the process exit non-zero — it is the whole reason the baseline exists.
 */
export function compareToBaseline(runs, baseline) {
  const now = tallyCriteria(runs);
  const before = tallyCriteria(baseline.runs || []);
  const rows = [];
  let regressed = 0;
  let improved = 0;

  const scenarioIds = [...new Set([...Object.keys(before), ...Object.keys(now)])];
  for (const scenarioId of scenarioIds) {
    const ids = [...new Set([...Object.keys(before[scenarioId] || {}), ...Object.keys(now[scenarioId] || {})])];
    for (const id of ids) {
      const b = before[scenarioId]?.[id];
      const n = now[scenarioId]?.[id];
      if (!b || !n) {
        rows.push({ scenarioId, id, note: !b ? 'NEW' : 'GONE', before: b, now: n });
        continue;
      }
      // At 3 reps a single flip is noise, not evidence — the loop sets no temperature and replies
      // vary run to run. Calling every 3/3 -> 2/3 a REGRESSION manufactures false alarms and invites
      // tuning the prompt against sampling jitter, which is worse than not measuring at all.
      // A regression needs a drop of at least 2 reps, or a fall to zero from a passing baseline.
      const drop = b.pass / b.total - n.pass / n.total;
      const repsLost = b.pass - n.pass;
      let direction = '';
      if (repsLost >= 2 || (n.pass === 0 && b.pass > 0)) { direction = 'REGRESSED'; regressed += 1; }
      else if (drop > 0) direction = 'noisy-down';
      else if (drop < 0) { direction = 'improved'; improved += 1; }
      rows.push({ scenarioId, id, before: b, now: n, direction });
    }
  }
  return { rows, regressed, improved };
}

export function renderComparison({ rows, regressed, improved }) {
  const lines = ['', 'vs baseline:', `${'criterion'.padEnd(44)} base → now`];
  for (const row of rows) {
    if (!row.direction && !row.note) continue;
    const label = `${row.scenarioId}/${row.id}`.slice(0, 43).padEnd(44);
    const b = row.before ? `${row.before.pass}/${row.before.total}` : '—';
    const n = row.now ? `${row.now.pass}/${row.now.total}` : '—';
    const mark =
      row.note ||
      (row.direction === 'REGRESSED' ? '▼  REGRESSED' : row.direction === 'noisy-down' ? '·  (1 rep, noise)' : '▲');
    lines.push(`${label}${b.padEnd(6)}→ ${n.padEnd(6)} ${mark}`);
  }
  lines.push('');
  const noisy = rows.filter((r) => r.direction === 'noisy-down').length;
  lines.push(`${improved} improved, ${regressed} regressed, ${noisy} down by a single rep (treated as noise)`);
  return lines.join('\n');
}

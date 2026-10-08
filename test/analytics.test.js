const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY, snapshot, sprintMetrics, capacity, flowMetrics, forecasts, monteCarlo, health, insights, analyze, toCsv } = require('../src/analytics');

const start = Date.parse('2026-01-01T00:00:00Z');
const todo = { id: '1', name: 'To Do', category: 'new' };
const doing = { id: '2', name: 'In Progress', category: 'indeterminate' };
const done = { id: '3', name: 'Done', category: 'done' };
const sprint = { id: 10, name: 'Sprint 10', state: 'closed',
  startDate: new Date(start).toISOString(), endDate: new Date(start + 10 * DAY).toISOString(),
  completeDate: new Date(start + 10 * DAY).toISOString() };
const event = (day, field, from, to) => ({ at: start + day * DAY, changes: [{ field, from, to }] });
const issue = (key, points, status = todo, history = [], sprintIds = ['10']) => ({
  key, points, status, history, sprintIds, created: new Date(start - DAY).toISOString(),
});

test('reconstructs sprint-start points, membership and status from later changes', () => {
  const item = issue('TEAM-1', 8, done, [
    event(2, 'points', 5, 8), event(3, 'status', todo, doing), event(8, 'status', doing, done),
    event(12, 'sprint', ['10'], ['10', '11']),
  ], ['10', '11']);
  assert.deepEqual(snapshot(item, start), { points: 5, status: todo, sprintIds: ['10'] });
  assert.equal(snapshot(item, start - 2 * DAY), null);
  const metrics = sprintMetrics(sprint, [item]);
  assert.equal(metrics.plannedPoints, 5);
  assert.equal(metrics.completedPoints, 8);
  assert.equal(metrics.commitmentReliability, 100);
  assert.equal(metrics.scopeChangePoints, 3);
  assert.equal(metrics.throughput, 1);
  assert.equal(metrics.series.length, 11);
  assert.equal(metrics.series[0].remaining, 5);
  assert.equal(metrics.series.at(-1).remaining, 0);
});

test('counts additions, removals, transient scope and committed spillover', () => {
  const items = [
    issue('TEAM-1', 5, done, [event(8, 'status', todo, done)]),
    issue('TEAM-2', 3, todo, [event(2, 'sprint', ['10'], [])], []),
    issue('TEAM-3', 2, done, [event(2, 'sprint', [], ['10']), event(6, 'status', todo, done)]),
    issue('TEAM-4', 1, todo, [event(3, 'sprint', [], ['10']), event(4, 'sprint', ['10'], [])], []),
  ];
  const metrics = sprintMetrics(sprint, items);
  assert.equal(metrics.plannedPoints, 8);
  assert.equal(metrics.completedPoints, 7);
  assert.equal(metrics.addedPoints, 3);
  assert.equal(metrics.removedPoints, 4);
  assert.equal(metrics.scopeChangePoints, -1);
  assert.equal(metrics.scopeChurnPercent, 87.5);
  assert.equal(metrics.commitmentReliability, 62.5);
  assert.equal(metrics.spilloverPoints, 3);
  assert.equal(metrics.throughput, 2);
});

test('active sprint ignores future changes and flags projected finish risk', () => {
  const active = { ...sprint, state: 'active' };
  const items = [
    issue('TEAM-1', 2, done, [event(3, 'status', todo, done)]),
    issue('TEAM-2', 8, done, [event(12, 'status', doing, done)]),
  ];
  const metrics = sprintMetrics(active, items, start + 5 * DAY);
  assert.equal(metrics.completedPoints, 2);
  assert.equal(metrics.remainingPoints, 8);
  assert.equal(metrics.risk, 'At risk');
  assert.equal(metrics.expectedFinish, new Date(start + 25 * DAY).toISOString());
});

test('empty and zero-velocity sprints do not produce NaN or false certainty', () => {
  const metrics = sprintMetrics(sprint, []);
  assert.equal(metrics.commitmentReliability, null);
  assert.equal(metrics.scopeChurnPercent, null);
  assert.equal(metrics.risk, 'Complete');
  assert.equal(forecasts([], 5, 10, start).velocity, null);
  assert.equal(forecasts([{ state: 'closed', velocity: 0 }], 5, 10, start).completionDate, null);
  assert.equal(sprintMetrics({ ...sprint, state: 'active' }, [issue('TEAM-1', 5)], start + DAY).expectedFinish, null);
  assert.throws(() => sprintMetrics({ ...sprint, startDate: null }, []), /valid start/);
});

test('capacity accounts for vacations, holidays and focus without inventing point conversion', () => {
  const result = capacity({ members: 5, workingDays: 10, hoursPerDay: 8, focus: 0.75,
    vacationDays: 5, holidayDays: 5, historicalHours: 240 }, 30);
  assert.equal(result.availableDays, 40);
  assert.equal(result.availability, 80);
  assert.equal(result.hours, 240);
  assert.equal(result.vacationImpactHours, 30);
  assert.equal(result.forecastPoints, 30);
  assert.equal(capacity().availability, null);
  assert.equal(capacity({ members: 5 }, 30).forecastPoints, null);
  for (const input of [{ focus: 2 }, { members: -1 }, { members: 1.5 }, { vacationDays: 1 }, { workingDays: NaN }]) {
    assert.throws(() => capacity(input));
  }
});

test('flow uses status durations, handles reopened work, and excludes waiting from efficiency', () => {
  const blocked = { id: '4', name: 'Blocked', category: 'indeterminate' };
  const item = { ...issue('TEAM-1', 5, done, [
    event(1, 'status', todo, doing), event(3, 'status', doing, blocked),
    event(4, 'status', blocked, doing), event(5, 'status', doing, done),
    event(6, 'status', done, doing), event(7, 'status', doing, done),
  ]), created: new Date(start).toISOString() };
  const active = issue('TEAM-2', 3, doing, [event(2, 'status', todo, doing)]);
  const result = flowMetrics([item, active], start + 10 * DAY);
  assert.equal(result.leadTimeDays, 7);
  assert.equal(result.cycleTimeDays, 6);
  assert.equal(result.wip, 1);
  assert.equal(result.aging[0].cycleAgeDays, 8);
  assert.ok(Math.abs(result.flowEfficiency - 400 / 7) < 0.00001);
  assert.ok(Math.abs(result.blockedTimeScore - 600 / 7) < 0.00001);
});

test('forecasts and Monte Carlo yield reproducible percentiles with explicit horizons', () => {
  const history = [10, 10, 10].map(velocity => ({ state: 'closed', velocity }));
  const result = forecasts(history, 25, 10, start, { random: () => 0.5 });
  assert.equal(result.velocity, 10);
  assert.equal(result.sprints, 3);
  assert.equal(result.completionDate, '2026-01-31');
  assert.equal(result.monteCarlo.p85, 3);
  assert.equal(result.monteCarlo.p95Date, '2026-01-31');
  assert.equal(monteCarlo([0, 0, 0], 10), null);
  assert.equal(monteCarlo([10, 10], 10), null);
  assert.deepEqual(monteCarlo([], 0), { p50: 0, p85: 0, p95: 0, trials: 1000, unfinishedPercent: 0 });
  const failed = monteCarlo([0, 1, 2], 10, { maxSprints: 1, random: () => 0 });
  assert.equal(failed.p50, null);
  assert.equal(failed.unfinishedPercent, 100);
  assert.throws(() => monteCarlo([-1, 2, 3], 10));
});

test('health excludes missing signals and insights use actual trends', () => {
  const metrics = { commitmentReliability: 91, scopeChurnPercent: 27, risk: 'At risk', unestimatedIssues: 1 };
  const forecast = { velocityStability: 84, sampleSize: 4 };
  const flow = { blockedTimeScore: 95, flowEfficiency: 82, cycleTimeDays: 2, aging: [{ cycleAgeDays: 5 }] };
  const result = health(metrics, forecast, flow);
  assert.equal(result.overall, 85);
  assert.equal(result.availableSignals, 5);
  assert.equal(health({ commitmentReliability: null, scopeChurnPercent: null },
    { velocityStability: null }, { blockedTimeScore: null, flowEfficiency: null }).overall, null);
  const messages = insights(metrics, [100, 95, 90, 82].map(velocity => ({ state: 'closed', velocity })),
    forecast, { forecastPoints: 63 }, flow);
  assert.ok(messages.some(message => message.includes('18%')));
  assert.ok(messages.some(message => message.includes('63 story points')));
  assert.ok(messages.some(message => message.includes('Scope churn')));
});

test('combined report includes epic forecast and CSV neutralizes spreadsheet formulas', () => {
  const report = analyze({ sprint: { ...sprint, name: '=HYPERLINK("bad")' }, sprints: [sprint],
    issues: [issue('TEAM-1', 5, done, [event(8, 'status', todo, done)])],
    epic: { key: 'TEAM-100', issues: [{ points: 8, fields: { status: { statusCategory: { key: 'new' } } } }] },
    now: start + 10 * DAY });
  assert.equal(report.epic.remainingPoints, 8);
  assert.equal(report.epic.sprints, 2);
  report.history[0].name = '=HYPERLINK("bad")';
  assert.ok(toCsv(report).includes(`"'=HYPERLINK(""bad"")"`));
});

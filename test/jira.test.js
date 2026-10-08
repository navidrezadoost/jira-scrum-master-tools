const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JiraClient, normalizeIssue, id, points, sprintIds } = require('../src/jira');
const route = (parts, ...values) => parts.reduce((text, part, index) =>
  text + part + (index < values.length ? encodeURIComponent(values[index]) : ''), '');
const response = data => ({ ok: true, json: async () => data });

test('pagination follows actual page sizes rather than requested sizes', async () => {
  const calls = [];
  const client = new JiraClient(async path => {
    calls.push(path);
    const startAt = Number(new URL(path, 'https://jira.invalid').searchParams.get('startAt'));
    return response({ values: [{ id: startAt + 1 }], total: 3 });
  }, route);
  assert.equal((await client.boards('TEAM')).length, 3);
  assert.ok(calls[2].includes('startAt=2'));
});

test('pagination refuses oversized, missing or partial datasets', async () => {
  const oversized = new JiraClient(async () => response({ values: [1, 2], isLast: true }), route);
  await assert.rejects(oversized.pages(() => '/page', 'values', 1), /safety limit/);
  const missing = new JiraClient(async () => response({}), route);
  await assert.rejects(missing.boards('TEAM'), /Unexpected/);
  const partial = new JiraClient(async () => response({ values: [], total: 1, isLast: false }), route);
  await assert.rejects(partial.boards('TEAM'), /incomplete/);
});

test('Jira failures are actionable and never treated as empty successful data', async () => {
  for (const [status, message] of [[429, /rate limit/], [403, /denied access/], [500, /No partial report/]]) {
    const client = new JiraClient(async () => ({ ok: false, status }), route);
    await assert.rejects(client.boards('TEAM'), message);
  }
});

test('normalization uses configured fields and changelog IDs, not display names', () => {
  const statuses = new Map([
    ['1', { name: 'To Do', statusCategory: { key: 'new' } }],
    ['2', { name: 'Done', statusCategory: { key: 'done' } }],
  ]);
  const item = { key: 'TEAM-1', fields: {
    created: '2026-01-01T00:00:00Z', customfield_10001: 8, customfield_10002: [{ id: 10 }],
    status: { id: '2', name: 'Done' },
  } };
  const histories = [{ created: '2026-01-05T00:00:00Z', items: [
    { fieldId: 'customfield_10001', from: '5', to: '8' },
    { fieldId: 'customfield_10002', from: '9', to: '9, 10' },
    { field: 'status', from: '1', to: '2' },
  ] }];
  const result = normalizeIssue(item, histories, 'customfield_10001', 'customfield_10002', statuses);
  assert.equal(result.points, 8);
  assert.deepEqual(result.sprintIds, ['10']);
  assert.deepEqual(result.history[0].changes[1].to, ['9', '10']);
  assert.equal(result.history[0].changes[2].from.category, 'new');
  assert.throws(() => normalizeIssue(item, histories, 'customfield_10001', 'customfield_10002', new Map()), /unavailable/);
});

test('input validation blocks unsafe IDs, JQL injection and invalid estimates', async () => {
  for (const value of ['../1', '-1', '', '1 OR 2', '0']) assert.throws(() => id(value), /Invalid/);
  assert.equal(id(10), '10');
  assert.equal(points(null), 0);
  assert.throws(() => points(-1));
  assert.throws(() => points('nonsense'));
  assert.deepEqual(sprintIds('1,2'), ['1', '2']);
  const client = new JiraClient(() => { throw new Error('Must not call Jira'); }, route);
  await assert.rejects(client.epic('TEAM-1 OR project=OTHER', 'customfield_1'), /valid epic key/);
  await assert.rejects(client.boards('TEAM OR 1'), /Jira project/);
});

test('epic enhanced search follows token pagination and excludes completed estimates', async () => {
  const calls = [];
  const client = new JiraClient(async path => {
    calls.push(path);
    if (path.startsWith('/rest/api/3/issue/')) return response({ fields: { issuetype: { hierarchyLevel: 1 } } });
    const second = path.includes('nextPageToken=');
    return response({ issues: [{ key: second ? 'TEAM-3' : 'TEAM-2',
      fields: { customfield_1: second ? 3 : 5, status: { statusCategory: { key: 'new' } } } }],
    nextPageToken: second ? undefined : 'opaque token', isLast: second });
  }, route);
  const result = await client.epic('TEAM-1', 'customfield_1');
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[1].points, 3);
  assert.ok(calls[2].includes('nextPageToken=opaque%20token'));
});

test('report integrates board config, paginated histories, and historical scope', async () => {
  const sprint = { id: 10, name: 'Sprint 10', state: 'closed', startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-01-11T00:00:00Z', completeDate: '2026-01-11T00:00:00Z' };
  const fields = [
    { id: 'customfield_1', schema: { type: 'number' } },
    { id: 'customfield_2', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  ];
  const statuses = [
    { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
    { id: '2', name: 'Done', statusCategory: { key: 'done' } },
  ];
  const client = new JiraClient(async path => {
    const url = new URL(path, 'https://jira.invalid');
    if (url.pathname === '/rest/agile/1.0/board') return response({ values: [{ id: 1 }], isLast: true });
    if (url.pathname.endsWith('/sprint')) return response({ values: [sprint], isLast: true });
    if (url.pathname.endsWith('/configuration')) return response({ estimation: { field: { fieldId: 'customfield_1' } } });
    if (url.pathname === '/rest/api/3/field') return response(fields);
    if (url.pathname === '/rest/api/3/status') return response(statuses);
    if (url.pathname.endsWith('/changelog')) return response({ values: [
      { created: '2026-01-09T00:00:00Z', items: [{ field: 'status', from: '1', to: '2' }] },
    ], total: 1 });
    if (url.pathname.endsWith('/issue')) return response({ issues: [{ key: 'TEAM-1', fields: {
      created: '2025-12-31T00:00:00Z', updated: '2026-01-09T00:00:00Z',
      status: statuses[1], customfield_1: 5, customfield_2: [{ id: 10 }],
    } }], total: 1 });
    throw new Error(`Unexpected path: ${path}`);
  }, route);
  const result = await client.report({ boardId: 1, sprintId: 10 }, 'TEAM');
  assert.equal(result.metrics.plannedPoints, 5);
  assert.equal(result.metrics.completedPoints, 5);
  assert.equal(result.metrics.commitmentReliability, 100);
  assert.ok(result.csv.includes('Sprint 10'));
  assert.ok(result.dataNotes.length > 0);
  await assert.rejects(client.report({ boardId: 2, sprintId: 10 }, 'TEAM'), /available in this project/);
});

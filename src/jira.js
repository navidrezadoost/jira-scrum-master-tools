const { analyze, toCsv } = require('./analytics');

function id(value) {
  const result = String(value ?? '');
  if (!/^[1-9]\d{0,14}$/.test(result)) throw new Error('Invalid board or sprint ID.');
  return result;
}

function sprintIds(value) {
  if (Array.isArray(value)) return value.map(item => String(typeof item === 'object' ? item.id : item));
  return value ? String(value).split(',').map(item => item.trim()).filter(item => /^\d+$/.test(item)) : [];
}

function points(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('An issue has an invalid story-point estimate.');
  return number;
}

function normalizeIssue(issue, histories, pointField, sprintField, statuses) {
  if (!Number.isFinite(new Date(issue.fields.created).getTime()) || !issue.fields.created
    || histories.some(history => !history.created || !Number.isFinite(new Date(history.created).getTime()))) {
    throw new Error(`Issue history dates for ${issue.key} are invalid. No partial report was generated.`);
  }
  const status = (value, name) => {
    const found = statuses.get(String(value));
    if (!found) throw new Error(`Status history for ${issue.key} is unavailable. No partial report was generated.`);
    return { id: String(value), name: found.name || name, category: found.statusCategory.key };
  };
  return {
    key: issue.key, created: issue.fields.created,
    points: points(issue.fields[pointField]),
    status: status(issue.fields.status.id, issue.fields.status.name),
    sprintIds: sprintIds(issue.fields[sprintField]),
    history: histories.map(history => ({
      at: new Date(history.created).getTime(),
      changes: history.items.flatMap(item => {
        if (item.fieldId === pointField) return [{ field: 'points', from: points(item.from), to: points(item.to) }];
        if (item.fieldId === sprintField || item.field === 'Sprint') {
          return [{ field: 'sprint', from: sprintIds(item.from), to: sprintIds(item.to) }];
        }
        if (item.field === 'status' || item.fieldId === 'status') {
          return [{ field: 'status', from: status(item.from, item.fromString), to: status(item.to, item.toString) }];
        }
        return [];
      }),
    })).filter(event => event.changes.length).sort((a, b) => a.at - b.at),
  };
}

class JiraClient {
  constructor(request, route) {
    this.request = request;
    this.route = route;
  }

  async get(path) {
    const response = await this.request(path);
    if (!response.ok) {
      if (response.status === 429) throw new Error('Jira rate limit reached. Wait and refresh the report.');
      if (response.status === 401 || response.status === 403) throw new Error('Jira denied access. Check your project permissions and app consent.');
      throw new Error(`Jira request failed (${response.status}). No partial report was generated.`);
    }
    return response.json();
  }

  async pages(path, property, limit = 2000) {
    const values = [];
    let startAt = 0;
    while (true) {
      const page = await this.get(path(startAt));
      const batch = page[property];
      if (!Array.isArray(batch)) throw new Error('Unexpected Jira pagination response.');
      values.push(...batch);
      if (values.length > limit) throw new Error(`Report exceeds the ${limit}-item safety limit. Narrow the board filter.`);
      if (page.isLast === true || (Number.isFinite(page.total) && startAt + batch.length >= page.total)) return values;
      if (!batch.length) {
        if (page.isLast === false || (page.total && startAt < page.total)) throw new Error('Jira returned an incomplete page.');
        return values;
      }
      startAt += batch.length;
    }
  }

  async boards(projectKey) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey || '')) throw new Error('Open this app from a Jira project.');
    return this.pages(startAt => this.route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum&startAt=${startAt}&maxResults=50`, 'values');
  }

  async sprints(boardId) {
    const board = id(boardId);
    return this.pages(startAt => this.route`/rest/agile/1.0/board/${board}/sprint?startAt=${startAt}&maxResults=50`, 'values');
  }

  async changelog(issueKey) {
    return this.pages(startAt => this.route`/rest/api/3/issue/${issueKey}/changelog?startAt=${startAt}&maxResults=100`, 'values', 5000);
  }

  async epic(epicKey, pointField) {
    if (!/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(epicKey)) throw new Error('Enter a valid epic key, such as TEAM-42.');
    const fields = `status,issuetype,${pointField}`;
    const epic = await this.get(this.route`/rest/api/3/issue/${epicKey}?fields=${fields}`);
    if (epic.fields.issuetype.hierarchyLevel !== 1) throw new Error('The selected issue must be an epic (hierarchy level 1).');
    const issues = [];
    let token;
    do {
      const jql = `parent = ${epicKey}`;
      const page = token
        ? await this.get(this.route`/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100&nextPageToken=${token}`)
        : await this.get(this.route`/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`);
      if (!Array.isArray(page.issues)) throw new Error('Unexpected epic search response.');
      issues.push(...page.issues.map(issue => ({ ...issue, points: points(issue.fields[pointField]) })));
      if (issues.length > 500) throw new Error('Epic exceeds the 500 direct-child safety limit.');
      if (page.nextPageToken && page.nextPageToken === token) throw new Error('Jira returned a repeated search page.');
      token = page.nextPageToken;
      if (page.isLast === false && !token) throw new Error('Jira returned an incomplete epic search.');
    } while (token);
    return { key: epicKey, issues };
  }

  async report({ boardId, sprintId, capacityInputs, epicKey }, projectKey) {
    const board = id(boardId);
    const selected = id(sprintId);
    if (!(await this.boards(projectKey)).some(item => String(item.id) === board)) {
      throw new Error('Select a Scrum board available in this project.');
    }
    const [allSprints, config, fields, statusList] = await Promise.all([
      this.sprints(board),
      this.get(this.route`/rest/agile/1.0/board/${board}/configuration`),
      this.get(this.route`/rest/api/3/field`),
      this.get(this.route`/rest/api/3/status`),
    ]);
    const sprint = allSprints.find(item => String(item.id) === selected);
    if (!sprint || sprint.state === 'future') throw new Error('Select an active or closed sprint on this board.');
    const pointField = config.estimation?.field?.fieldId;
    if (!pointField || !pointField.startsWith('customfield_') || fields.find(field => field.id === pointField)?.schema?.type !== 'number') {
      throw new Error('Configure this board to estimate using a numeric story-point field.');
    }
    const sprintField = fields.find(field => field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id;
    if (!sprintField) throw new Error('Jira Sprint field is unavailable.');
    const completedStatusIds = config.columnConfig?.columns?.at(-1)?.statuses?.map(status => String(status.id));
    if (!completedStatusIds?.length) throw new Error('Map completed statuses to the rightmost board column.');
    const reportNow = Date.now();
    const cutoff = sprint.state === 'closed' ? new Date(sprint.completeDate || sprint.endDate).getTime() : reportNow;
    const closedAt = at => allSprints.filter(item => item.state === 'closed' && item.startDate
      && new Date(item.completeDate || item.endDate).getTime() <= at)
      .sort((a, b) => new Date(b.completeDate || b.endDate) - new Date(a.completeDate || a.endDate)).slice(0, 6);
    const closed = closedAt(cutoff);
    const epicSprints = epicKey ? closedAt(reportNow) : [];
    const selectedSprints = [...new Map([...closed, sprint].map(item => [item.id, item])).values()];
    const loadedSprints = [...selectedSprints, ...epicSprints];
    const earliest = Math.min(...loadedSprints.map(item => new Date(item.startDate).getTime()));
    const requestedFields = `created,updated,status,${pointField},${sprintField}`;
    const candidates = await this.pages(startAt => this.route`/rest/agile/1.0/board/${board}/issue?fields=${requestedFields}&startAt=${startAt}&maxResults=100`, 'issues', 500);
    const sprintSet = new Set(loadedSprints.map(item => String(item.id)));
    const relevant = candidates.filter(issue => sprintIds(issue.fields[sprintField]).some(value => sprintSet.has(value))
      || new Date(issue.fields.updated).getTime() >= earliest
      || issue.fields.status.statusCategory.key !== 'done');
    const statuses = new Map(statusList.map(status => [String(status.id), status]));
    const issues = [];
    // Bound concurrency to avoid flooding Jira with per-issue history requests.
    for (let offset = 0; offset < relevant.length; offset += 5) {
      issues.push(...await Promise.all(relevant.slice(offset, offset + 5).map(async issue =>
        normalizeIssue(issue, await this.changelog(issue.key), pointField, sprintField, statuses))));
    }
    const epic = epicKey ? { ...await this.epic(epicKey.trim().toUpperCase(), pointField), asOf: reportNow } : null;
    const report = analyze({ sprint, sprints: selectedSprints, issues, capacityInputs,
      epic, epicSprints, completedStatusIds, now: cutoff });
    return {
      ...report, csv: toCsv(report),
      dataNotes: [
        'Reports cover issues currently visible in this board filter. Deleted issues, issues moved off the board, and issues hidden by permissions cannot be reconstructed.',
        'History uses up to six closed sprints ending on or before the selected sprint. Flow metrics cover the loaded board issue sample, not deployment events.',
        'Dates and durations use calendar days in UTC. Burndown predictions assume the observed completion rate continues.',
        'Blocked time recognizes statuses named Blocked or On Hold. Flow efficiency is a status-duration proxy, not measured hands-on time.',
        'Insights are explainable rules, not a generative AI service. Thresholds and health scores are coaching heuristics.',
        'Epic forecasts always use current visible direct children and the latest closed sprints, even when viewing a historical sprint. Subtasks are not double-counted; unestimated children contribute zero points.',
      ],
    };
  }
}

module.exports = { JiraClient, id, sprintIds, points, normalizeIssue };

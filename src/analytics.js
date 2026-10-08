const DAY = 86400000;
const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const percent = (part, total) => total > 0 ? 100 * part / total : null;
const clamp = value => Math.max(0, Math.min(100, value));
const time = value => value === null || value === undefined || value === '' ? NaN : new Date(value).getTime();
const isDone = state => state?.status?.category === 'done';

function snapshot(issue, at) {
  if (time(issue.created) > at) return null;
  const state = { points: issue.points, status: issue.status, sprintIds: [...issue.sprintIds] };
  for (const event of [...issue.history].sort((a, b) => b.at - a.at)) {
    if (event.at <= at) break;
    for (const change of [...event.changes].reverse()) {
      if (change.field === 'points') state.points = change.from;
      if (change.field === 'status') state.status = change.from;
      if (change.field === 'sprint') state.sprintIds = change.from;
    }
  }
  return state;
}

function sprintMetrics(sprint, issues, now = Date.now()) {
  const start = time(sprint.startDate);
  const end = sprint.state === 'closed' ? time(sprint.completeDate || sprint.endDate) : now;
  const duration = time(sprint.endDate) - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Sprint must have valid start and completion dates.');
  }
  const rows = issues.map(issue => ({ issue, before: snapshot(issue, start), after: snapshot(issue, end) }));
  const belongs = state => state?.sprintIds.includes(String(sprint.id));
  const planned = rows.filter(row => belongs(row.before) && !isDone(row.before));
  const scope = rows.filter(row => belongs(row.after) && !isDone(row.before));
  const completed = scope.filter(row => isDone(row.after));
  const plannedPoints = sum(planned.map(row => row.before.points));
  const completedPoints = sum(completed.map(row => row.after.points));
  let addedPoints = 0;
  let removedPoints = 0;
  for (const { issue } of rows) {
    const created = time(issue.created);
    if (created > start && created <= end) {
      const initial = snapshot(issue, created);
      if (belongs(initial)) addedPoints += initial.points;
    }
    for (const event of issue.history.filter(item => item.at > start && item.at <= end
      && item.changes.some(change => change.field === 'sprint'))) {
      const before = snapshot(issue, event.at - 1);
      const after = snapshot(issue, event.at);
      if (!belongs(before) && belongs(after)) addedPoints += after.points;
      if (belongs(before) && !belongs(after)) removedPoints += before.points;
    }
  }
  const committedDone = planned.filter(row => belongs(row.after) && isDone(row.after));
  const committedCompletedPoints = sum(committedDone.map(row => row.before.points));
  const remainingPoints = sum(scope.filter(row => !isDone(row.after)).map(row => row.after.points));
  const series = [];
  const days = Math.ceil((end - start) / DAY);
  if (days > 366) throw new Error('Sprint duration exceeds the supported one-year range.');
  for (let day = 0; day <= days; day++) {
    const at = Math.min(start + day * DAY, end);
    const states = issues.map(issue => snapshot(issue, at)).filter(belongs);
    series.push({
      date: new Date(at).toISOString(),
      ideal: duration > 0 ? plannedPoints * Math.max(0, 1 - (at - start) / duration) : null,
      remaining: sum(states.filter(state => !isDone(state)).map(state => state.points)),
      completed: sum(states.filter(isDone).map(state => state.points)),
      scope: sum(states.map(state => state.points)),
    });
  }
  const elapsedDays = (end - start) / DAY;
  const rate = elapsedDays > 0 ? completedPoints / elapsedDays : 0;
  const expectedFinish = remainingPoints === 0 ? new Date(end).toISOString()
    : rate > 0 ? new Date(end + remainingPoints / rate * DAY).toISOString() : null;
  return {
    id: sprint.id, name: sprint.name, state: sprint.state,
    startDate: sprint.startDate, endDate: sprint.endDate,
    plannedPoints, completedPoints, velocity: completedPoints,
    addedPoints, removedPoints, scopeChangePoints: sum(scope.map(row => row.after.points)) - plannedPoints,
    scopeChurnPercent: percent(addedPoints + removedPoints, plannedPoints),
    commitmentReliability: percent(committedCompletedPoints, plannedPoints),
    spilloverPoints: Math.max(0, plannedPoints - committedCompletedPoints),
    throughput: completed.length, remainingPoints, expectedFinish,
    risk: remainingPoints === 0 ? 'Complete' : !expectedFinish ? 'Insufficient progress'
      : time(expectedFinish) > time(sprint.endDate) ? 'At risk' : 'On track',
    unestimatedIssues: scope.filter(row => row.after.points === 0).length,
    series,
  };
}

function capacity({ members = 0, workingDays = 10, hoursPerDay = 8, focus = 0.7,
  vacationDays = 0, holidayDays = 0, historicalHours = 0 } = {}, velocity = null) {
  const inputs = { members, workingDays, hoursPerDay, focus, vacationDays, holidayDays, historicalHours };
  if (Object.values(inputs).some(value => !Number.isFinite(value) || value < 0)
    || !Number.isInteger(members) || members > 1000 || workingDays > 366 || hoursPerDay > 24 || focus > 1) {
    throw new Error('Capacity inputs must be non-negative numbers; focus must be between 0 and 1.');
  }
  const totalDays = members * workingDays;
  if (vacationDays + holidayDays > totalDays) throw new Error('Absences exceed total team working days.');
  const availableDays = totalDays - vacationDays - holidayDays;
  return {
    availableDays, availability: percent(availableDays, totalDays),
    hours: availableDays * hoursPerDay * focus,
    vacationImpactHours: vacationDays * hoursPerDay * focus,
    forecastPoints: historicalHours > 0 && velocity !== null
      ? velocity * availableDays * hoursPerDay * focus / historicalHours : null,
  };
}

function flowMetrics(issues, now = Date.now(), blockedStatuses = ['blocked', 'on hold']) {
  const blockedNames = new Set(blockedStatuses.map(name => name.trim().toLowerCase()));
  const completed = [];
  const aging = [];
  let activeDays = 0;
  let blockedDays = 0;
  let elapsedDays = 0;
  for (const issue of issues) {
    if (time(issue.created) > now) continue;
    const events = issue.history.filter(event => event.at <= now && event.changes.some(c => c.field === 'status'))
      .sort((a, b) => a.at - b.at);
    const initial = snapshot(issue, time(issue.created));
    let status = initial.status;
    let previous = time(issue.created);
    let started = status.category === 'indeterminate' ? previous : null;
    let finished = status.category === 'done' ? previous : null;
    let active = 0;
    let blocked = 0;
    const accumulate = until => {
      const days = Math.max(0, until - previous) / DAY;
      if (status.category === 'indeterminate' && !blockedNames.has(status.name.toLowerCase())) active += days;
      if (blockedNames.has(status.name.toLowerCase())) blocked += days;
      previous = until;
    };
    for (const event of events) {
      accumulate(event.at);
      status = event.changes.find(change => change.field === 'status').to;
      if (status.category === 'indeterminate' && started === null) started = event.at;
      finished = status.category === 'done' ? event.at : null;
    }
    accumulate(now);
    const current = snapshot(issue, now);
    if (isDone(current)) {
      const lead = finished === null ? null : (finished - time(issue.created)) / DAY;
      const cycle = finished !== null && started !== null ? (finished - started) / DAY : null;
      completed.push({ key: issue.key, leadDays: lead, cycleDays: cycle });
      if (lead !== null) {
        elapsedDays += lead;
        activeDays += active;
        blockedDays += blocked;
      }
    } else {
      aging.push({ key: issue.key, status: current.status.name, ageDays: (now - time(issue.created)) / DAY,
        cycleAgeDays: started === null ? null : (now - started) / DAY });
    }
  }
  return {
    wip: issues.filter(issue => snapshot(issue, now)?.status.category === 'indeterminate').length,
    leadTimeDays: mean(completed.map(issue => issue.leadDays).filter(value => value !== null)),
    cycleTimeDays: mean(completed.map(issue => issue.cycleDays).filter(value => value !== null)),
    flowEfficiency: elapsedDays > 0 ? clamp(percent(activeDays, elapsedDays)) : null,
    blockedTimeScore: elapsedDays > 0 ? clamp(100 - percent(blockedDays, elapsedDays)) : null,
    aging: aging.sort((a, b) => b.ageDays - a.ageDays), completed,
  };
}

function monteCarlo(samples, remaining, { trials = 1000, maxSprints = 100, random = Math.random } = {}) {
  if (!Number.isFinite(remaining) || remaining < 0 || samples.some(value => !Number.isFinite(value) || value < 0)
    || !Number.isInteger(trials) || trials < 1 || trials > 10000
    || !Number.isInteger(maxSprints) || maxSprints < 1 || maxSprints > 1000) {
    throw new Error('Invalid Monte Carlo inputs.');
  }
  if (remaining === 0) return { p50: 0, p85: 0, p95: 0, trials, unfinishedPercent: 0 };
  if (samples.length < 3 || !samples.some(value => value > 0)) return null;
  const results = [];
  for (let trial = 0; trial < trials; trial++) {
    let delivered = 0;
    let count = 0;
    while (delivered < remaining && count < maxSprints) {
      delivered += samples[Math.min(samples.length - 1, Math.floor(random() * samples.length))];
      count++;
    }
    results.push(delivered >= remaining ? count : Infinity);
  }
  results.sort((a, b) => a - b);
  const quantile = p => {
    const result = results[Math.ceil(results.length * p) - 1];
    return Number.isFinite(result) ? result : null;
  };
  return { p50: quantile(0.5), p85: quantile(0.85), p95: quantile(0.95), trials,
    unfinishedPercent: percent(results.filter(value => !Number.isFinite(value)).length, trials) };
}

function forecasts(history, remainingPoints, durationDays, now = Date.now(), options) {
  const samples = history.filter(sprint => sprint.state === 'closed').map(sprint => sprint.velocity);
  const velocity = mean(samples);
  const deviation = velocity === null ? null : Math.sqrt(mean(samples.map(value => (value - velocity) ** 2)));
  const sprints = velocity > 0 ? Math.ceil(remainingPoints / velocity) : remainingPoints === 0 ? 0 : null;
  const date = count => count !== null && Number.isFinite(durationDays) && durationDays > 0
    ? new Date(now + count * durationDays * DAY).toISOString().slice(0, 10) : null;
  const simulation = monteCarlo(samples, remainingPoints, options);
  return {
    sampleSize: samples.length, velocity, low: velocity === null ? null : Math.max(0, velocity - deviation),
    high: velocity === null ? null : velocity + deviation,
    velocityStability: samples.length < 2 || velocity <= 0 ? null : clamp(100 * (1 - deviation / velocity)),
    sprints, completionDate: date(sprints),
    monteCarlo: simulation && { ...simulation, p50Date: date(simulation.p50),
      p85Date: date(simulation.p85), p95Date: date(simulation.p95) },
  };
}

function health(metrics, forecast, flow) {
  const scores = {
    planningAccuracy: metrics.commitmentReliability,
    velocityStability: forecast.velocityStability,
    scopeStability: metrics.scopeChurnPercent === null ? null : clamp(100 - metrics.scopeChurnPercent),
    blockedTime: flow.blockedTimeScore, flowEfficiency: flow.flowEfficiency,
  };
  const available = Object.values(scores).filter(value => value !== null).map(clamp);
  return { ...scores, overall: mean(available), availableSignals: available.length };
}

function insights(metrics, history, forecast, teamCapacity, flow) {
  const messages = [];
  const closed = history.filter(sprint => sprint.state === 'closed');
  const last = closed.slice(-4).map(sprint => sprint.velocity);
  if (last.length === 4 && last[0] > 0 && last.slice(1).every((value, i) => value < last[i])) {
    messages.push(`Velocity decreased by ${Math.round(100 * (last[0] - last[3]) / last[0])}% across three consecutive sprint transitions. Review blockers and availability.`);
  }
  if (metrics.scopeChurnPercent > 20) messages.push('Scope churn exceeds the 20% heuristic. Review mid-sprint additions and removals.');
  if (metrics.commitmentReliability !== null && metrics.commitmentReliability < 80) messages.push('Commitment reliability is below 80%. Consider reducing commitments and refining work.');
  if (metrics.risk === 'At risk') messages.push('The current completion rate predicts a finish after the sprint end date.');
  if (teamCapacity.forecastPoints !== null) messages.push(`Available capacity supports approximately ${Math.round(teamCapacity.forecastPoints)} story points, using the supplied historical hours.`);
  if (forecast.sampleSize < 3) messages.push('Collect at least three closed sprints for Monte Carlo forecasting.');
  if (flow.cycleTimeDays !== null && flow.aging.some(issue => issue.cycleAgeDays > 2 * flow.cycleTimeDays)) {
    messages.push('Some active work is older than twice the average cycle time. Review aging items.');
  }
  if (metrics.unestimatedIssues) messages.push(`${metrics.unestimatedIssues} scope items have zero or missing estimates. Point-based metrics may understate work.`);
  return messages;
}

function analyze({ sprint, sprints, issues, capacityInputs, epic, now = Date.now(), simulationOptions }) {
  const metrics = sprintMetrics(sprint, issues, now);
  const history = sprints.filter(item => item.state === 'closed' && item.startDate)
    .sort((a, b) => time(a.completeDate || a.endDate) - time(b.completeDate || b.endDate))
    .map(item => sprintMetrics(item, issues, now));
  const flow = flowMetrics(issues, now);
  const durationDays = (time(sprint.endDate) - time(sprint.startDate)) / DAY;
  const forecast = forecasts(history, metrics.remainingPoints, durationDays, now, simulationOptions);
  const teamCapacity = capacity(capacityInputs, forecast.velocity);
  const epicForecast = epic ? {
    key: epic.key,
    remainingPoints: sum(epic.issues.filter(issue => issue.fields.status.statusCategory.key !== 'done')
      .map(issue => Number(issue.points) || 0)),
  } : null;
  if (epicForecast) Object.assign(epicForecast,
    forecasts(history, epicForecast.remainingPoints, durationDays, now, simulationOptions));
  return {
    generatedAt: new Date(now).toISOString(), metrics, history, flow, forecast, capacity: teamCapacity,
    health: health(metrics, forecast, flow), epic: epicForecast,
    insights: insights(metrics, history, forecast, teamCapacity, flow),
  };
}

function toCsv(report) {
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [
    ['Sprint', 'Planned points', 'Completed points', 'Added points', 'Removed points', 'Reliability %', 'Spillover points', 'Throughput'],
    ...[...report.history, ...(report.metrics.state === 'closed' ? [] : [report.metrics])]
      .map(sprint => [sprint.name, sprint.plannedPoints, sprint.completedPoints, sprint.addedPoints,
        sprint.removedPoints, sprint.commitmentReliability, sprint.spilloverPoints, sprint.throughput]),
  ].map(row => row.map(escape).join(',')).join('\n');
}

module.exports = { DAY, snapshot, sprintMetrics, capacity, flowMetrics, monteCarlo, forecasts, health, insights, analyze, toCsv };

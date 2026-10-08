import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button, DynamicTable, Heading, Label, LineChart, SectionMessage, Select,
  Spinner, Stack, Text, TextArea, Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const format = value => value === null || value === undefined ? 'Unavailable' : typeof value === 'number'
  ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(value);
const fields = [
  ['members', 'Team members', '0'],
  ['workingDays', 'Working days per member (exclude weekends)', '10'],
  ['hoursPerDay', 'Hours per working day', '8'],
  ['focus', 'Focus factor (0–1)', '0.7'],
  ['vacationDays', 'Total vacation person-days', '0'],
  ['holidayDays', 'Total holiday person-days', '0'],
  ['historicalHours', 'Average effective hours for the historical sprints (for point forecast)', '0'],
];

function Table({ headers, rows }) {
  return <DynamicTable
    head={{ cells: headers.map((content, index) => ({ key: String(index), content })) }}
    rows={rows.map((row, index) => ({
      key: String(index), cells: row.map((value, cell) => ({ key: String(cell), content: format(value) })),
    }))}
    rowsPerPage={10}
  />;
}

function Report({ report }) {
  const { metrics, history, flow, forecast, capacity, health, epic } = report;
  const burn = metrics.series.flatMap(point => [
    { date: point.date.slice(0, 10), points: point.remaining, series: 'Actual remaining' },
    ...(point.ideal === null ? [] : [{ date: point.date.slice(0, 10), points: point.ideal, series: 'Ideal remaining' }]),
  ]);
  const burnup = metrics.series.flatMap(point => [
    { date: point.date.slice(0, 10), points: point.completed, series: 'Completed' },
    { date: point.date.slice(0, 10), points: point.scope, series: 'Scope' },
  ]);
  return <Stack space="space.200">
    <Heading size="large">{metrics.name}</Heading>
    <Text>{`Report as of ${report.generatedAt}. Refresh after changing planning inputs.`}</Text>
    <Heading size="medium">Sprint metrics</Heading>
    <Table headers={['Metric', 'Value']} rows={[
      ['Velocity / completed story points', metrics.completedPoints],
      ['Planned story points', metrics.plannedPoints],
      ['Added / removed points', `${format(metrics.addedPoints)} / ${format(metrics.removedPoints)}`],
      ['Net scope change (points)', metrics.scopeChangePoints],
      ['Scope churn (%)', metrics.scopeChurnPercent],
      ['Commitment reliability (%)', metrics.commitmentReliability],
      ['Spillover (committed points not completed)', metrics.spilloverPoints],
      ['Throughput (completed issues)', metrics.throughput],
    ]} />
    {history.length > 0 && <LineChart title="Historical velocity" data={history.map(item => ({
      sprint: item.name, points: item.velocity,
    }))} xAccessor="sprint" yAccessor="points" />}
    <Heading size="medium">Analyzed burndown and burn-up</Heading>
    <Text>{`Risk: ${metrics.risk}. Expected finish: ${format(metrics.expectedFinish)}.`}</Text>
    <LineChart title="Burndown (calendar days, UTC)" data={burn} xAccessor="date" yAccessor="points" colorAccessor="series" />
    <LineChart title="Burn-up" data={burnup} xAccessor="date" yAccessor="points" colorAccessor="series" />
    <Heading size="medium">Forecasts</Heading>
    <Text>{`Based on ${forecast.sampleSize} closed sprints. Forecasts assume comparable team composition, sprint length, and work. Ranges are historical mean ± one standard deviation, not guarantees.`}</Text>
    <Table headers={['Forecast', 'Value']} rows={[
      ['Next sprint velocity (points)', forecast.velocity],
      ['Historical velocity range', `${format(forecast.low)} – ${format(forecast.high)}`],
      ['Remaining sprint scope (points)', metrics.remainingPoints],
      ['Velocity-based remaining sprints', forecast.sprints],
      ['Burn-up completion date (stable scope)', forecast.completionDate],
      ['Capacity-based next sprint points', capacity.forecastPoints],
    ]} />
    <Text>Monte Carlo resamples historical velocity, including zero-velocity sprints. At least three samples are required. Percentiles express simulated completion confidence; unavailable percentiles exceeded the 100-sprint horizon.</Text>
    <Table headers={['Scope', '50% sprints / date', '85% sprints / date', '95% sprints / date']} rows={[
      ['Remaining sprint scope', ...['p50', 'p85', 'p95'].map(p => `${format(forecast.monteCarlo?.[p])} / ${format(forecast.monteCarlo?.[`${p}Date`])}`)],
      ...(epic ? [[`${epic.key} (${format(epic.remainingPoints)} remaining points)`,
        ...['p50', 'p85', 'p95'].map(p => `${format(epic.monteCarlo?.[p])} / ${format(epic.monteCarlo?.[`${p}Date`])}`)]] : []),
    ]} />
    {epic && <Text>{`Epic velocity-based completion: ${format(epic.completionDate)} (${format(epic.sprints)} sprints).`}</Text>}
    <Heading size="medium">Team capacity and flow analytics</Heading>
    <Table headers={['Metric', 'Value']} rows={[
      ['Available person-days', capacity.availableDays], ['Availability (%)', capacity.availability],
      ['Effective capacity (hours)', capacity.hours], ['Vacation impact (effective hours)', capacity.vacationImpactHours],
      ['WIP (in-progress issues)', flow.wip], ['Average lead time (calendar days)', flow.leadTimeDays],
      ['Average cycle time (calendar days)', flow.cycleTimeDays], ['Flow efficiency proxy (%)', flow.flowEfficiency],
    ]} />
    <Table headers={['Aging item', 'Status', 'Age since creation (days)', 'Age since work started (days)']}
      rows={flow.aging.map(item => [item.key, item.status, item.ageDays, item.cycleAgeDays])} />
    <Heading size="medium">Sprint health</Heading>
    <Text>{`Overall: ${format(health.overall)} / 100, using ${health.availableSignals} of 5 available signals. This is a coaching heuristic, not a productivity ranking.`}</Text>
    <Table headers={['Signal', 'Score / 100']} rows={[
      ['Planning accuracy', health.planningAccuracy], ['Velocity stability', health.velocityStability],
      ['Scope stability', health.scopeStability], ['Blocked time', health.blockedTime],
      ['Flow efficiency proxy', health.flowEfficiency],
    ]} />
    <Heading size="medium">Automated coach</Heading>
    {report.insights.length ? report.insights.map((message, index) => <Text key={index}>{message}</Text>)
      : <Text>No heuristic alerts for this report.</Text>}
    <Heading size="medium">Report export</Heading>
    <Label labelFor="csv">Copy CSV to save or import the sprint report</Label>
    <TextArea id="csv" value={report.csv} isReadOnly isMonospaced minimumRows={5} />
    <Heading size="medium">Data coverage and assumptions</Heading>
    {report.dataNotes.map((note, index) => <Text key={index}>{note}</Text>)}
    <Text>DORA and release health require deployment, incident, and release data. This app does not infer those metrics from issue status.</Text>
  </Stack>;
}

function Dashboard() {
  const [boards, setBoards] = useState([]);
  const [board, setBoard] = useState(null);
  const [sprints, setSprints] = useState([]);
  const [sprint, setSprint] = useState(null);
  const [inputs, setInputs] = useState(Object.fromEntries(fields.map(([name, , value]) => [name, value])));
  const [epicKey, setEpicKey] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [loadingSprints, setLoadingSprints] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);

  useEffect(() => {
    let current = true;
    invoke('boards').then(data => { if (current) setBoards(data); })
      .catch(err => { if (current) setError(err.message || 'Unable to load boards.'); })
      .finally(() => { if (current) setLoadingBoards(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!board) return;
    let current = true;
    setLoadingSprints(true);
    setError('');
    invoke('sprints', { boardId: board.value }).then(data => {
      if (current) setSprints(data);
    }).catch(err => { if (current) setError(err.message || 'Unable to load sprints.'); })
      .finally(() => { if (current) setLoadingSprints(false); });
    return () => { current = false; };
  }, [board]);

  const calculate = async () => {
    setLoadingReport(true);
    setReport(null);
    setError('');
    try {
      if (Object.values(inputs).some(value => value.trim() === '')) throw new Error('Fill every capacity input (use zero when not applicable).');
      setReport(await invoke('report', {
        boardId: board.value, sprintId: sprint.value, epicKey,
        capacityInputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, Number(value)])),
      }));
    } catch (err) {
      setError(err.message || 'Unable to calculate the report.');
    } finally {
      setLoadingReport(false);
    }
  };

  return <Stack space="space.200">
    <Heading size="xlarge">Engineering Intelligence</Heading>
    <Text>Scrum analytics, capacity planning, forecasts, and explainable coaching inside Jira. Choose a Scrum board and sprint; no spreadsheets or external AI services are required.</Text>
    {error && <SectionMessage appearance="error" title="Report unavailable"><Text>{error}</Text></SectionMessage>}
    {loadingBoards && <Spinner label="Loading Scrum boards" />}
    {!loadingBoards && !boards.length && !error && <Text>No accessible Scrum boards in this project.</Text>}
    <Label labelFor="board">Scrum board</Label>
    <Select inputId="board" value={board} isDisabled={loadingBoards || loadingReport}
      options={boards.map(item => ({ label: item.name, value: String(item.id) }))}
      onChange={value => { setBoard(value); setSprint(null); setSprints([]); setReport(null); }} />
    <Label labelFor="sprint">Sprint</Label>
    <Select inputId="sprint" value={sprint} isLoading={loadingSprints} isDisabled={!board || loadingSprints || loadingReport}
      options={sprints.map(item => ({ label: `${item.name} (${item.state})`, value: String(item.id) }))}
      onChange={value => { setSprint(value); setReport(null); }} />
    {board && !loadingSprints && !sprints.length && <Text>No active or closed sprints on this board.</Text>}
    <Heading size="medium">Next sprint capacity inputs</Heading>
    <Text>Absences are aggregate person-days, not individual calendars. Historical effective hours must use the same focus-factor basis as next-sprint capacity. Inputs are not persisted.</Text>
    {fields.map(([name, label]) => <Stack key={name} space="space.050">
      <Label labelFor={name}>{label}</Label>
      <Textfield id={name} type="number" min={0} value={inputs[name]} isDisabled={loadingReport}
        onChange={event => setInputs(previous => ({ ...previous, [name]: event.target.value }))} />
    </Stack>)}
    <Label labelFor="epic">Optional epic key for completion forecast</Label>
    <Textfield id="epic" placeholder="TEAM-42" value={epicKey} isDisabled={loadingReport}
      onChange={event => setEpicKey(event.target.value)} />
    <Button appearance="primary" isDisabled={!sprint || loadingReport || loadingSprints} onClick={calculate}>Calculate / refresh</Button>
    {loadingReport && <Spinner label="Reading Jira issue histories and calculating metrics" />}
    {report && <Report report={report} />}
  </Stack>;
}

ForgeReconciler.render(<Dashboard />);

# Jira Scrum Master Tools

A modular **Engineering Intelligence** dashboard built with Atlassian Forge UI Kit. Open it from a Jira project's sidebar, select a Scrum board and active or closed sprint, and calculate reports directly in Jira.

## Features

- **Sprint analytics:** velocity, planned/completed story points, scope additions/removals and net change, commitment reliability, committed spillover, throughput.
- **Forecasting:** next-sprint historical velocity and range, velocity-based completion, epic direct-child completion, 1,000-trial Monte Carlo percentiles, burn-up and capacity-based forecasts.
- **Team analytics:** aggregate capacity, availability, vacation/holiday impact, WIP, lead/cycle time, aging work.
- **Sprint health:** planning accuracy, velocity stability, scope stability, blocked time and flow efficiency proxies, with an overall score using available signals only.
- **Analyzed burndown:** ideal/actual chart, expected finish, completion risk, and burn-up scope/completion chart.
- **Automated coach:** explainable trend, scope, capacity, risk and aging recommendations. No external AI service or credentials.
- **Reports:** historical velocity chart and copyable CSV export, including spreadsheet formula-injection protection.

## Setup

Requires Node.js 22, npm, the [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/), an Atlassian developer account, and a Jira Software Cloud site with a Scrum board. Jira's Free plan does not itself prevent app development; installation permissions, API permissions, Forge quotas and current platform billing still apply.

```sh
npm ci
forge login
forge register
forge lint
forge deploy
forge install
```

`forge register` creates your own app and replaces the **placeholder app ID** in `manifest.yml`; do not deploy with that placeholder. Choose Jira and your development site when installing. Approve the requested read scopes, and grant user consent when prompted. After scope changes, use `forge install --upgrade`. Run `forge tunnel` for interactive development.

Configure the board's estimation statistic to a numeric story-point custom field. The app discovers that field and the Sprint field rather than hard-coding custom-field IDs. No Jira issues are modified. All Jira requests use `asUser`, so reports respect the viewing user's access. No issue data, user calendars or planning inputs are persisted or sent to external services.

Open **Engineering Intelligence** in the project sidebar:

1. Choose a Scrum board and active or closed sprint.
2. Enter team size, working days, daily hours, focus factor and aggregate absence person-days. Exclude weekends from working days and do not subtract holidays twice.
3. Optionally enter average historical **effective** team hours to convert historical velocity into a capacity-based point forecast, and an epic key for its completion forecast.
4. Select **Calculate / refresh**. Copy the CSV report to export.

## Calculation definitions and limits

The app paginates board/sprint lists, issues, changelogs and epic searches. It reconstructs sprint membership, estimates and status at sprint start/end from changelogs rather than treating current fields as historical facts.

| Metric | Definition |
| --- | --- |
| Planned points | Start-of-sprint estimates for members not already Done |
| Velocity / throughput | End-of-sprint points / count of Done members not already Done at start |
| Commitment reliability | Start estimates of committed members completed and still in scope, divided by planned points |
| Spillover | Planned points minus completed committed start estimates; includes removed commitments |
| Net scope change | End-scope estimates minus planned points, including estimate changes |
| Scope churn | Points entering plus points leaving the sprint divided by planned points; includes transient scope |
| Capacity | `(members × working days − vacation person-days − holiday person-days) × daily hours × focus` |
| Capacity point forecast | Average historical velocity × next effective hours / supplied historical effective hours |
| Lead / cycle time | Creation / first In Progress to final Done; reopened work is included, calendar days |
| Flow efficiency proxy | Non-blocked In Progress duration / creation-to-completion duration for completed issues |
| Health | Equal-weight average of available, bounded 0–100 signals; missing signals are excluded |
| Burndown expected finish | Report time + remaining points / observed completed points per elapsed calendar day |

Historical velocity uses up to six closed sprints ending on or before the selected sprint. Next-sprint range is mean ± one standard deviation, not a confidence interval. Monte Carlo samples actual historical velocities, including zeros, and needs at least three closed sprints. It caps each simulation at 100 sprints; a percentile exceeding that horizon is unavailable, not silently dropped. Forecast dates assume consecutive sprints of the selected sprint's duration, stable scope, comparable work and unchanged team composition.

**Data coverage matters:** reports use issues currently visible in the board filter. Deleted issues, issues moved off the board, and permission-hidden issues cannot be recovered. Historical reports may therefore differ from Jira's own sprint reports. Flow analytics cover the loaded board issue sample (recently updated issues, members of sampled sprints, and unfinished work), not a complete organization-wide cohort. Changelogs are fully paginated; inaccessible status history fails the report instead of guessing.

Safety limits are 500 board issues, 5,000 changelog entries per issue, 2,000 board/sprint entries, 500 epic direct children, and one year per sprint. Over-limit or failed Jira reads produce an error, not a partial successful report. Large boards may also hit Forge invocation limits; narrow the board filter rather than interpreting a failed request as zero work.

Dates are UTC and duration calculations use calendar days, not business-time calendars. Zero/missing estimates contribute zero points and are highlighted. Blocked time recognizes statuses named **Blocked** or **On Hold**; teams with other workflows should adapt this rule in `src/analytics.js`. Flow efficiency is a status-duration proxy, not measured hands-on time. Scope churn >20% and reliability <80% are transparent coaching heuristics, not universal Scrum standards. Active-sprint health is provisional.

Epic forecasts use visible direct children of a hierarchy-level-1 epic, not recursive descendants, and do not double-count subtasks. Point forecasts are unavailable without positive historical delivery. No deployment or incident data is available: **DORA metrics and release health are intentionally not inferred from issue status**.

## Architecture and development

```text
Forge project page (src/frontend/index.jsx)
  → asUser resolvers (src/index.js)
  → paginated Jira board / sprint / issue / epic reads (src/jira.js)
  → pure analytics, forecasting, health and coaching (src/analytics.js)
  → dashboard charts, tables and CSV
```

The pure engine is separate from Jira access and the UI, so deployment/incident adapters, release health and optional AI providers can be added later without replacing Scrum calculations.

```sh
npm test        # Node's built-in runner: calculations and mocked Jira integration
npm run check  # Backend syntax and frontend JSX compilation check
npm run lint   # Forge manifest/application lint (requires installed Forge CLI)
npm audit
```

The lockfile includes an override for a patched `prosemirror-view`, a transitive Forge UI Kit dependency. UI Kit runs inside Jira; live end-to-end verification requires a registered app and development-site installation.

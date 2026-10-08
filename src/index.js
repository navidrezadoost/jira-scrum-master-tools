const Resolver = require('@forge/resolver').default;
const api = require('@forge/api');
const { JiraClient } = require('./jira');

const resolver = new Resolver();
const client = new JiraClient(path => api.default.asUser().requestJira(path), api.route);
const project = context => context.extension?.project?.key;

resolver.define('boards', async ({ context }) =>
  (await client.boards(project(context))).map(({ id, name }) => ({ id, name })));

resolver.define('sprints', async ({ payload, context }) => {
  const boards = await client.boards(project(context));
  if (!boards.some(board => String(board.id) === String(payload.boardId))) {
    throw new Error('Select a Scrum board available in this project.');
  }
  return (await client.sprints(payload.boardId))
    .filter(sprint => sprint.state !== 'future')
    .map(({ id, name, state }) => ({ id, name, state }));
});

resolver.define('report', async ({ payload, context }) => client.report(payload, project(context)));

exports.handler = resolver.getDefinitions();

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
require.extensions['.ts'] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
const { findTaskPullRequest } = require('./merged-pr-lookup.ts');
async function findMergedPullRequest(input) {
  const result = await findTaskPullRequest(input);
  return result?.state === 'merged' ? result.record : null;
}
const { detectForge } = require('../shared/forges.ts');
const since = '2026-10-01T00:00:00Z', createdAt = '2026-11-01T00:00:00Z', head = 'a'.repeat(40), branch = 'feature/task', target = 'main';
const ghRow = { number: 4, headRefOid: head, headRefName: branch, baseRefName: target, state: 'MERGED', isCrossRepository: false, createdAt };
const common = { branch, target, since, tools: { gh: {}, az: {}, auth: { header: 'test' } }, bitbucketApi: 'https://api.bitbucket.org/2.0' };
const toolRows = data => async () => ({ code: 0, stdout: JSON.stringify(data) });
const github = { ...common, repo: detectForge('https://github.com/sample/example.git') };

test('branch discovery requires one current, same-repository merged PR to the intended base', async () => {
  const expected = await findMergedPullRequest({ ...github, run: toolRows([ghRow]) });
  assert.equal(expected.url, 'https://github.com/sample/example/pull/4');
  for (const change of [{ state: 'CLOSED' }, { state: 'OPEN' }, { isCrossRepository: true }, { baseRefName: 'release' }, { headRefName: 'other' }, { createdAt: '2026-01-01' }]) {
    assert.equal(await findMergedPullRequest({ ...github, run: toolRows([{ ...ghRow, ...change }]) }), null);
  }
  assert.equal(await findMergedPullRequest({ ...github, run: toolRows([ghRow, { ...ghRow, number: 8, state: 'OPEN' }]) }), null);
  assert.equal(await findMergedPullRequest({ ...github, recorded: expected, run: toolRows({ ...ghRow, number: 8 }) }), null);
  assert.equal((await findMergedPullRequest({ ...github, recorded: expected, run: toolRows(ghRow) })).number, 4);
});

test('Azure DevOps Completed must have the expected repo, project and branches', async () => {
  const repo = detectForge('https://dev.azure.com/org/Project/_git/Repo');
  const row = { pullRequestId: 9, sourceRefName: `refs/heads/${branch}`, targetRefName: `refs/heads/${target}`, repository: { name: 'Repo', project: { name: 'Project' } }, creationDate: createdAt, status: 'completed', lastMergeSourceCommit: { commitId: head } };
  const lookup = value => findMergedPullRequest({ ...common, repo, run: toolRows([value]) });
  assert.equal((await lookup(row)).url, 'https://dev.azure.com/org/Project/_git/Repo/pullrequest/9');
  for (const change of [{ status: 'abandoned' }, { forkSource: { repository: {} } }, { repository: { name: 'Other', project: { name: 'Project' } } }]) assert.equal(await lookup({ ...row, ...change }), null);
});

test('Bitbucket checks forks, both branches and pagination before accepting a merge', async () => {
  const repo = detectForge('git@bitbucket.org:team/tool.git');
  const side = name => ({ branch: { name }, repository: { full_name: 'team/tool' }, commit: { hash: head } });
  const row = { id: 5, source: side(branch), destination: side(target), state: 'MERGED', created_on: createdAt };
  const lookup = data => findMergedPullRequest({ ...common, repo, http: async req => { assert.equal(req.method, 'GET'); return { status: 200, text: JSON.stringify(data) }; } });
  assert.equal((await lookup({ values: [row] })).url, 'https://bitbucket.org/team/tool/pull-requests/5');
  assert.equal(await lookup({ values: [row], next: 'some-next-page' }), null);
  assert.equal(await lookup({ values: [{ ...row, state: 'DECLINED' }] }), null);
  assert.equal(await lookup({ values: [{ ...row, source: { ...row.source, repository: { full_name: 'fork/tool' } } }] }), null);
});

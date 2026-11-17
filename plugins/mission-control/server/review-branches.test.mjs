import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { runGit } = require('./review.ts');
const { registerReview } = require('./review-rpc.ts');

// Use the same RPC contracts that the host bridge and the Review panel send over the wire.
test('reviews committed local and fetched branches against the configured default, with pinned previews and scoped comments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mc-branch-review-'));
  const vault = await mkdtemp(join(tmpdir(), 'mc-branch-review-vault-'));
  const worker = join(vault, 'worker');
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(vault, { recursive: true, force: true }); });
  const git = (...args) => runGit(root, args);
  await git('init', '-b', 'trunk');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Review tests');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'guide.md'), 'original\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  await git('branch', 'already-merged');
  await git('switch', '-c', 'topic');
  await writeFile(join(root, 'guide.md'), 'from topic\n');
  await git('commit', '-am', 'topic');
  const head = (await git('rev-parse', 'HEAD')).trim();
  await git('fetch', '.', 'refs/heads/topic:refs/remotes/origin/topic');
  await git('switch', 'trunk');
  await writeFile(join(root, 'main-only.txt'), 'trunk commit\n');
  await git('add', '.'); await git('commit', '-m', 'advance default');
  await git('worktree', 'add', worker, 'topic');
  await writeFile(join(root, 'guide.md'), 'dirty main checkout');
  await writeFile(join(worker, 'guide.md'), 'unstaged worker version');
  await writeFile(join(root, 'scratch.txt'), 'untracked');

  const workspace = { workspaceDirectory: root, projectId: 'project' };
  let recipient = 'wks_worker';
  let message;
  const paseo = { workspaces: { ref: id => ({ refresh: async () => id === 'wks_main' ? workspace : null }) }, agents: { ref: id => ({
    refresh: async () => ({ agent: { id, workspaceId: recipient, cwd: recipient === 'wks_worker' ? worker : vault, status: 'idle', pendingPermissions: [] } }),
    send: async m => { message = m; },
  }) } };
  const handlers = new Map();
  registerReview({ handle: (rpc, handle) => handlers.set(rpc.name, input => handle(rpc.input.parse(input), { paseo }).then(result => rpc.output.parse(result))) }, vault, {
    serverId: async () => 'host', configuredBranch: async project => { assert.equal(project, 'project'); return 'trunk'; },
  });
  const input = { serverId: 'host', workspaceId: 'wks_main' };
  const call = (name, fields = {}) => handlers.get(name)({ ...input, ...fields });
  const local = { branchRef: 'refs/heads/topic' }, remote = { branchRef: 'refs/remotes/origin/topic' };
  for (const name of ['review.discard.prepare', 'review.discard.apply', 'review.reveal', 'review.item-path']) {
    assert.throws(() => call(name, { ...local, path: 'guide.md', directory: false, token: 'a'.repeat(64) }), /branchRef/);
  }
  const choices = await call('review.branches');
  assert.deepEqual(choices, { defaultBranch: 'trunk', currentRef: 'refs/heads/trunk', branches: [{ ref: local.branchRef, name: 'topic', remote: false }, { ref: remote.branchRef, name: 'origin/topic', remote: true }] });
  for (const selection of [local, remote]) {
    const snapshot = await call('review.branch.snapshot', selection);
    assert.equal(snapshot.head, head);
    assert.equal(snapshot.comparison.ref, selection.branchRef);
    if (selection === local) assert.equal(resolve(snapshot.comparison.worktree), resolve(worker));
    assert.deepEqual(snapshot.files.map(f => f.path), ['guide.md']);
    assert.ok(snapshot.files[0].hunks[0].lines.some(line => line.kind === 'add' && line.text === 'from topic'));
  }
  await runGit(worker, ['commit', '-am', 'post-snapshot change']);
  assert.equal((await call('review.branch.file', { commit: head, path: 'guide.md' })).text, 'from topic\n');
  assert.equal(await readFile(join(root, 'guide.md'), 'utf8'), 'dirty main checkout');
  assert.equal((await git('symbolic-ref', '--short', 'HEAD')).trim(), 'trunk');
  await assert.rejects(call('review.branch.file', { commit: head, path: '../elsewhere.md' }), /inside this repository/);
  await assert.rejects(call('review.branch.snapshot', { branchRef: 'refs/heads/topic~1' }), /no longer available/);
  const saved = await call('review.comments.save', { ...local, path: 'guide.md', body: 'Clarify the example', anchor: null });
  assert.equal((await call('review.comments.list', remote)).comments.length, 0);
  assert.equal((await call('review.comments.list')).comments.length, 0);
  const send = { ...local, agentId: 'a1', commentIds: [saved.comments[0].commentId], workspaceName: 'project', scopeLabel: 'topic against trunk' };
  recipient = 'unrelated';
  await assert.rejects(call('review.comments.send', send), /belongs to another workspace/);
  recipient = 'wks_worker';
  await call('review.comments.send', send);
  assert.match(message, /topic against trunk/);
  assert.match(message, /Clarify the example/);
  assert.equal((await call('review.comments.list', local)).comments[0].status, 'sent');
  await assert.rejects(call('review.branches', { serverId: 'another-host' }), /this Mission Control host only/);
});

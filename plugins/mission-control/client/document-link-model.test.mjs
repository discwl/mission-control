import test from 'node:test';
import assert from 'node:assert/strict';
import { documentCandidates, documentLabel, wikiLink, markdownTableCells, resolveDocumentLink } from './document-link-model.ts';
const taskId = 'task_264d8373-7966-46ee-a208-659751e753bc';
function vault(paths, sourcePath = 'Projects/development-flow.md') {
 const calls = [];
 return { calls, root: 'C:/dev-vault', sourcePath,
  list: async folder => ({ entries: paths.filter(path => path.split('/').slice(0, -1).join('/') === folder).map(path => ({ path, kind: 'file' })) }),
  locate: async id => { calls.push(['locate', id]); return { path: `Tasks/${id}/task.md` }; },
  read: async path => { calls.push(['read', path]); if (!paths.includes(path)) throw new Error('ENOENT'); return { path }; }
 };
}
test('readable aliases and unnamed labels never expose a GUID path', () => {
 assert.equal(wikiLink(`[[${taskId}|Prove the agent bridge]]`).label, 'Prove the agent bridge');
 assert.equal(documentLabel(taskId), 'Task details'); assert.equal(documentLabel(`Tasks/${taskId}/task`), 'Task details');
 assert.equal(wikiLink(`[[Tasks/${taskId}/runs/run_abc/handoff|handoff]]`).label, 'View handoff');
});
test('shorthand task IDs use the verified task locator, including legacy files', async () => {
 const deps = vault([`Tasks/${taskId}.md`]); deps.locate = async id => ({ path: `Tasks/${id}.md` });
 assert.equal(await resolveDocumentLink(wikiLink(`[[${taskId}]]`), deps), `Tasks/${taskId}.md`);
 assert.deepEqual(deps.calls, [['read', `Tasks/${taskId}.md`]]);
});
test('explicit vault paths select the exact run with optional extension or backslashes', async () => {
 const handoff = `Tasks/${taskId}/runs/run_abc/handoff.md`, deps = vault([handoff, `Tasks/${taskId}/handoff.md`]);
 assert.equal(await resolveDocumentLink(wikiLink(`[[${handoff.replaceAll('/', '\\').replace(/\.md$/, '')}|handoff]]`), deps), handoff);
 assert.equal(await resolveDocumentLink(wikiLink(`[[${handoff}]]`), deps), handoff);
 assert.deepEqual(deps.calls.map(call => call[1]), [handoff, handoff]);
});
test('relative Markdown paths use the current source and normalize within this vault', () => {
 assert.deepEqual(documentCandidates('../report.md', `Tasks/${taskId}/runs/run_abc/handoff.md`, true), [`Tasks/${taskId}/runs/report.md`]);
 assert.deepEqual(documentCandidates('review.md', `C:\\dev-vault\\Tasks\\${taskId}\\task.md`, true, 'C:/dev-vault'), [`Tasks/${taskId}/review.md`]);
 assert.deepEqual(documentCandidates(`C:\\dev-vault\\Tasks\\${taskId}\\task.md`, '', false, 'C:/dev-vault'), [`Tasks/${taskId}/task.md`]);
 assert.throws(() => documentCandidates('../../outside.md', 'Project.md', true), /leaves the vault/);
 assert.throws(() => documentCandidates('C:/other-vault/report.md', '', false, 'C:/dev-vault'), /outside this vault/);
 assert.throws(() => documentCandidates('%ZZ'), /invalid encoding/);
});
test('missing and ambiguous basenames never select arbitrary records', async () => {
 const deps = vault(['report.md', 'Projects/report.md']);
 await assert.rejects(resolveDocumentLink(wikiLink('[[report]]'), deps), /more than one/); assert.equal(deps.calls.length, 0);
 await assert.rejects(resolveDocumentLink(wikiLink('[[missing]]'), deps), /not found/); assert.equal(deps.calls.length, 0);
 assert.equal(await resolveDocumentLink(wikiLink('[[Projects/report]]'), deps), 'Projects/report.md');
});
test('permissions and symbolic links cannot silently fall through to another file', async () => {
 const deps = vault(['report.md']); deps.list = async () => { throw new Error('Access denied'); };
 await assert.rejects(resolveDocumentLink(wikiLink('[[report]]'), deps), /Access denied/); assert.equal(deps.calls.length, 0);
 deps.list = async () => ({ entries: [{ path: 'Projects/report.md', kind: 'link' }] });
 await assert.rejects(resolveDocumentLink(wikiLink('[[Projects/report]]'), deps), /not found/);
});
test('table parser preserves wiki aliases, escaped pipes, and pipes in multi-backtick code', () => {
 assert.deepEqual(markdownTableCells('| [[Tasks/a/task|Readable title]] | A\\|B | ``a|b`` |'), ['[[Tasks/a/task|Readable title]]', 'A|B', '``a|b``']);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
const folder = await mkdtemp(join(tmpdir(), 'mc-runtime-tests-'));
after(() => rm(folder, { recursive: true, force: true }));
const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(folder, 'diagnostic.mjs');
const require = createRequire(import.meta.url);
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const shared = (await readFile(join(here, '../shared/runtime-diagnostic.ts'), 'utf8'))
  .replace('import { defineRpc } from "@getpaseo/plugin";', 'const defineRpc = x => x;')
  .replace('from "zod"', `from ${JSON.stringify(pathToFileURL(require.resolve('zod')).href)}`);
await writeFile(join(folder, 'shared.mjs'), transpile(shared));
const source = (await readFile(join(here, 'runtime-diagnostic.ts'), 'utf8'))
  .replace('from "../shared/runtime-diagnostic"', 'from "./shared.mjs"')
  .replace('import { defaultVaultPath } from "../shared/vault";', 'const defaultVaultPath = "C:/unused-test-vault";')
  .replace('import { daemonServerId } from "./agent-names";', 'const daemonServerId = async () => "srv-test";')
  .replace('import { localServerId } from "./tasks";', 'const localServerId = async () => "srv-test";');
await writeFile(bundle, transpile(source));
const { createRuntimeDiagnostic, localVolume, parseVolumeEvidence, registerRuntimeDiagnostic } = await import(pathToFileURL(bundle).href);
const input = { serverId: 'srv-test', acknowledgeSyntheticWrites: true };
const fakeVolume = async () => ({ id: 'fixture-volume', serial: '1', filesystem: 'NTFS', root: 'fixture-root' });
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(folder, 'case-'));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'Tasks'), { recursive: true });
  await writeFile(join(vault, 'Tasks', '.write.lock'), 'REAL-SENTINEL');
  return { root, vault, probe: createRuntimeDiagnostic({ vaultPath: vault, serverId: async () => 'srv-test', volume: fakeVolume, ...overrides }) };
}
async function pristine(f) {
  assert.equal(await readFile(join(f.vault, 'Tasks', '.write.lock'), 'utf8'), 'REAL-SENTINEL');
  assert.deepEqual(await readdir(f.root), ['vault']);
}
test('real SQLite and wx synthetic checks with runtime provenance and cleanup', async () => {
  const f = await fixture(); const r = await f.probe(input);
  assert.equal(r.status, 'passed', r.error); assert.equal(r.cleanup, 'removed');
  assert.equal(r.runtime.pid, process.pid); assert.equal(r.runtime.execPath, process.execPath);
  assert.equal(r.checks.length, 4); assert.match(r.directory, /\.mission-control-runtime-/);
  assert.ok(r.limitations.some(x => x.includes('all-writer'))); await pristine(f);
});
test('strict request rejects paths and missing acknowledgement', async () => {
  const f = await fixture();
  await assert.rejects(f.probe({ ...input, path: f.vault }));
  await assert.rejects(f.probe({ serverId: input.serverId })); await pristine(f);
});
test('host mismatch refuses before volume or writes', async () => {
  let calls = 0; const f = await fixture({ volume: async () => { calls++; return fakeVolume(); } });
  const r = await f.probe({ ...input, serverId: 'other' });
  assert.equal(r.status, 'failed'); assert.match(r.error, /host/); assert.equal(calls, 0); await pristine(f);
});
test('missing SQLite gives bounded failure before directory creation', async () => {
  const f = await fixture({ sqlite: async () => { throw new Error('missing sqlite ' + 'x'.repeat(2000)); } });
  const r = await f.probe(input); assert.equal(r.status, 'failed'); assert.equal(r.cleanup, 'not-created'); assert.equal(r.error.length, 500); await pristine(f);
});
test('unavailable/network volume refuses before SQLite or writes', async () => {
  let imports = 0; const f = await fixture({ volume: async () => { throw new Error('network/unknown volume'); }, sqlite: async () => { imports++; throw new Error('must not import'); } });
  const r = await f.probe(input); assert.match(r.error, /volume/); assert.equal(imports, 0); await pristine(f);
});
test('concurrent probe refused and local gate released after failure', async () => {
  let finish; const wait = new Promise(r => { finish = r; });
  const f = await fixture({ volume: async () => { await wait; throw new Error('metadata failure'); } });
  const first = f.probe(input); await assert.rejects(f.probe(input), /already active/);
  finish(); await first; assert.equal((await f.probe(input)).status, 'failed'); await pristine(f);
});
test('cooperative deadline before writes', async () => {
  let clock = 0; const f = await fixture({ now: () => clock, volume: async () => { clock = 30001; return fakeVolume(); } });
  const r = await f.probe(input); assert.match(r.error, /deadline/); assert.equal(r.cleanup, 'not-created'); await pristine(f);
});
test('SQLite IO failure closes both resources and cleans owned files', async () => {
  let closed = 0; class Broken { exec() { throw new Error('IO failure'); } close() { closed++; } }
  const f = await fixture({ sqlite: async () => ({ DatabaseSync: Broken }) }); const r = await f.probe(input);
  assert.equal(r.status, 'failed'); assert.match(r.error, /IO failure/); assert.equal(closed, 2); assert.equal(r.cleanup, 'removed'); await pristine(f);
});
test('unexpected contents retained rather than recursively removed', async () => {
  const { writeFileSync } = await import('node:fs');
  class Intruder { constructor(path) { writeFileSync(join(dirname(path), 'unexpected'), 'retain me'); } exec() { throw new Error('stop'); } close() {} }
  const f = await fixture({ sqlite: async () => ({ DatabaseSync: Intruder }) }); const r = await f.probe(input);
  assert.equal(r.cleanup, 'retained'); assert.equal(await readFile(join(r.directory, 'unexpected'), 'utf8'), 'retain me');
  assert.equal(await readFile(join(f.vault, 'Tasks', '.write.lock'), 'utf8'), 'REAL-SENTINEL');
});
test('replacement file retained', async () => {
  const { renameSync, writeFileSync } = await import('node:fs'); let replaced = false;
  class Replacer { constructor(path) { if (!replaced) { replaced = true; renameSync(path, join(dirname(dirname(path)), 'old-owned-probe')); writeFileSync(path, 'replacement'); } } exec() { throw new Error('stop'); } close() {} }
  const f = await fixture({ sqlite: async () => ({ DatabaseSync: Replacer }) }); const r = await f.probe(input);
  assert.equal(r.cleanup, 'retained'); assert.equal(await readFile(join(r.directory, 'probe.sqlite'), 'utf8'), 'replacement');
});
test('close failure retains evidence', async () => {
  class Broken { exec() { throw new Error('stop'); } close() { throw new Error('close failed'); } }
  const f = await fixture({ sqlite: async () => ({ DatabaseSync: Broken }) }); const r = await f.probe(input);
  assert.equal(r.status, 'failed'); assert.equal(r.cleanup, 'retained'); assert.match(r.error, /close failed/);
});
test('reparse vault rejected', async t => {
  const f = await fixture(); const alias = join(f.root, 'alias');
  try { await symlink(f.vault, alias, 'junction'); } catch (error) { if (error.code === 'EPERM') return t.skip('junction privilege unavailable'); throw error; }
  const probe = createRuntimeDiagnostic({ vaultPath: alias, serverId: async () => 'srv-test', volume: fakeVolume });
  assert.match((await probe(input)).error, /ordinary directory|alias/);
});
test('registers one typed RPC without executing it', () => {
  const handlers = []; registerRuntimeDiagnostic({ handle: (rpc, handler) => handlers.push({ rpc, handler }) });
  assert.equal(handlers.length, 1); assert.equal(handlers[0].rpc.name, 'diagnostics.run-lock-runtime');
  assert.equal(handlers[0].rpc.input.safeParse({ ...input, taskId: 'not-allowed' }).success, false);
});
test('volume evidence rejects mismatch, network/unknown filesystem and incomplete rows', () => {
  const row = { id: '\\\\?\\Volume{example}\\', serial: '123', filesystem: 'NTFS', root: 'C:\\' };
  assert.deepEqual(parseVolumeEvidence(JSON.stringify([row, row])), row);
  for (const changed of [{ ...row, id: 'network' }, { ...row, serial: '456' }, { ...row, filesystem: 'unknown' }, { ...row, root: 'D:\\' }, { ...row, serial: '' }]) {
    assert.throws(() => parseVolumeEvidence(JSON.stringify([row, changed])));
  }
  assert.throws(() => parseVolumeEvidence(JSON.stringify([row])));
});
test('actual local Windows volume metadata, not target plugin runtime', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); const v = await localVolume(f.vault, f.root);
  assert.equal(v.filesystem, 'NTFS'); assert.ok(v.id.startsWith('\\\\?\\Volume{')); await pristine(f);
});

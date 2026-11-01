import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('a fresh response between clock ticks is evaluated at render time, and timer ticks still expire cached data', t => {
  let now = 1000, state, tick, query = { data: undefined, isError: false };
  t.mock.method(Date, 'now', () => now);
  const evaluated = [];
  const imports = {
    '@getpaseo/plugin/client': { useRpc: () => async () => query.data },
    '@tanstack/react-query': { useQuery: () => query, useQueryClient: () => ({ getQueryData() {} }) },
    react: { useState: initial => { state ??= initial(); return [state, value => { state = value; }]; }, useEffect: effect => { if (!tick) effect(); }, useMemo: f => f() },
    '../shared/fleet': { readFleet: {} },
    './mission-control-v2-model': { retainV2Hosts: x => x, buildV2Tasks: (snapshot, options) => { evaluated.push(options.now - snapshot.observedAt); return []; } },
    './kanban-model': { kanbanTask: x => x },
  };
  const code = ts.transpileModule(readFileSync(new URL('./kanban-data.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', code)(name => imports[name], module, module.exports, callback => { tick = callback; return 1; }, () => {});
  module.exports.useKanbanData('srv_board');
  now = 5000; query = { ...query, data: { observedAt: 4900 } };
  assert.equal(module.exports.useKanbanData('srv_board').now, 5000);
  assert.equal(evaluated.at(-1), 100, 'new observations cannot appear in the future because the timer has not ticked');
  now = 100000; tick();
  module.exports.useKanbanData('srv_board');
  assert.equal(evaluated.at(-1), 95100, 'a hung refresh still ages out');
});

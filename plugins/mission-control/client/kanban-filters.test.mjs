import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file, imports = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { if (name in imports) return imports[name]; throw new Error('Unexpected import ' + name); }, module, module.exports);
  return module.exports;
}
const m = load('./kanban-filters-model.ts');
function task(host, project, ids, name = 'Main') {
  return { row: { serverId: host, hostLabel: host.toUpperCase(), entry: { task: { projectId: project, assignments: ids.map(workspaceId => ({ serverId: host, workspaceId })) } },
    host: { workspaces: ids.map(id => ({ id, name, projectName: project, branch: 'feature/test' })) } } };
}
const tasks = [task('a','same',['w']), task('b','same',['w']), task('a','other',['x','y']), task('a','empty',[])];
const hosts = [{serverId:'a',label:'A',snapshot:{complete:true}}, {serverId:'b',label:'B',snapshot:{complete:true}}, {serverId:'offline',label:'Offline',snapshot:null,error:'offline'}];
const empty = m.emptyKanbanScope;
const key = m.scopeKey;
test('host-qualified project and workspace IDs cannot bleed across hosts', () => {
  assert.deepEqual(tasks.filter(t => m.matchesKanbanScope(t, {...empty(),projects:[key('a','same')]})), [tasks[0]]);
  assert.deepEqual(tasks.filter(t => m.matchesKanbanScope(t, {...empty(),workspaces:[key('b','w')]})), [tasks[1]]);
});
test('multiselect ORs within a filter and intersects across filters', () => {
  const scope = {hosts:['a','b'], projects:[key('a','same'),key('b','same')],workspaces:[key('b','w')]};
  assert.deepEqual(tasks.filter(t => m.matchesKanbanScope(t,scope)),[tasks[1]]);
  assert.equal(tasks.filter(t => m.matchesKanbanScope(t,{...empty(),hosts:['a','b']})).length,4);
});
test('each saved workspace can find its task without duplicating the card', () => {
  assert.deepEqual(tasks.filter(t => m.matchesKanbanScope(t,{...empty(),workspaces:[key('a','x'),key('a','y')]})),[tasks[2]]);
});
test('foreign coordinator assignments never become local workspace matches', () => {
  const t = task('a','same',['w']);t.row.entry.task.assignments.push({serverId:'personal',workspaceId:'orchestrator'});
  assert.deepEqual(m.taskWorkspaceKeys(t),[key('a','w')]);
});
test('unassigned tasks remain filterable and All includes them', () => {
  assert.deepEqual(tasks.filter(t=>m.matchesKanbanScope(t,{...empty(),workspaces:[key('a',null)]})),[tasks[3]]);
  assert.equal(tasks.filter(t=>m.matchesKanbanScope(t,empty())).length,4);
});
test('options keep unavailable hosts and disambiguate duplicate names', () => {
  const options=m.kanbanFilterOptions(tasks,hosts,empty());
  assert.deepEqual(options.hosts.map(x=>x.count),[3,1,0]);assert.match(options.hosts[2].detail,/Unavailable/);
  assert.equal(options.projects.filter(x=>x.label==='same').length,2);
  assert.equal(options.workspaces.filter(x=>x.label==='Main').length,4);
});
test('dependent options narrow by hosts then projects and are searchable by context', () => {
  const options=m.kanbanFilterOptions(tasks,hosts,{hosts:['a'],projects:[key('a','other')],workspaces:[]});
  assert.equal(options.projects.length,3);
  assert.deepEqual(options.workspaces.map(x=>x.id).sort(),[key('a','x'),key('a','y')].sort());
  assert.match(options.workspaces[0].detail,/A · other · feature\/test/);
  assert.equal(m.searchFilterOptions(options.workspaces,' FEATURE/test ').length,2);
  assert.equal(m.searchFilterOptions(options.workspaces,'missing').length,0);
});
test('project display names use owned workspace metadata while IDs stay stable', () => {
  const t=task('a','prj_internal',['w']);t.row.host.workspaces[0].projectName='Customer portal';
  const option=m.kanbanFilterOptions([t],hosts,empty()).projects[0];
  assert.equal(option.label,'Customer portal');assert.equal(option.id,key('a','prj_internal'));
});
test('parent edits reset children; refresh does not broaden missing selections', () => {
  const scope={hosts:['a'],projects:[key('a','same')],workspaces:[key('a','w')]};
  assert.deepEqual(m.changeKanbanScope(scope,'hosts',['b']),{hosts:['b'],projects:[],workspaces:[]});
  assert.deepEqual(m.changeKanbanScope(scope,'projects',[]),{hosts:['a'],projects:[],workspaces:[]});
  assert.equal(tasks.filter(t=>m.matchesKanbanScope(t,{...scope,workspaces:['removed']})).length,0);
});
const jsx=(type,props)=>({type,props});
const modal=function Modal() {}; modal.Content='ModalContent';
function menu(props, query='') {
  let changed, closed;
  const {KanbanFilterMenu}=load('./kanban-filter-menu.tsx',{
    'react/jsx-runtime':{jsx,jsxs:jsx},'react':{useState:()=>[query,()=>{}]},
    'react-native':{Pressable:'Pressable',Text:'Text',View:'View',useWindowDimensions:()=>({width:1440,height:1000})},
    '@getpaseo/plugin/client/ui':{Icon:'Icon',Modal:modal,ScrollView:'ScrollView',TextInput:'TextInput'},
    './kanban-filters-model':m,
  });
  const tree=KanbanFilterMenu({title:'Host',icon:'Server',options:m.kanbanFilterOptions(tasks,hosts,empty()).hosts,selected:[],open:true,compact:false,colors:{},hint:'Host hint',onChange:x=>changed=x,onOpenChange:x=>closed=x,...props});
  const nodes=[]; const walk=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return;}nodes.push(n);walk(n.props?.children);};walk(tree);
  return {nodes,changed:()=>changed,closed:()=>closed};
}
test('dropdown supports multiselect, All reset, and explicit dismissal',()=>{
  const r=menu({selected:['a']});const checks=r.nodes.filter(n=>n.props?.accessibilityRole==='checkbox');
  assert.equal(checks.find(n=>n.props.accessibilityLabel.startsWith('A,')).props.accessibilityState.checked,true);
  checks.find(n=>n.props.accessibilityLabel.startsWith('B,')).props.onPress();assert.deepEqual(r.changed(),['a','b']);
  checks[0].props.onPress();assert.deepEqual(r.changed(),[]);
  r.nodes.find(n=>n.props?.accessibilityLabel==='Done selecting hosts').props.onPress();assert.equal(r.closed(),false);
});
test('search and Escape work; missing selections remain removable',()=>{
  const r=menu({selected:['gone']},'unavailable');
  assert.ok(r.nodes.some(n=>n.props?.accessibilityLabel?.startsWith('Selection unavailable')));
  r.nodes.find(n=>n.type==='TextInput').props.onKeyPress({nativeEvent:{key:'Escape'}});assert.equal(r.closed(),false);
  assert.equal(menu({},'zzzz').nodes.filter(n=>n.props?.accessibilityRole==='checkbox').length,1);
});
test('compact filter uses the host sheet and one bounded scrolling body',()=>{
  const r=menu({compact:true});assert.ok(r.nodes.some(n=>n.type===modal));
  assert.equal(r.nodes.find(n=>n.type==='ModalContent').props.scrollable,false);
  assert.equal(r.nodes.filter(n=>n.type==='ScrollView').length,1);
});

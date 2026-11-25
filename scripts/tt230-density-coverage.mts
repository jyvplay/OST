import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { makeHarness } from './harness.mts';
import { densityBoundFailures } from './density-bounds.mts';

const expected = ['editor','files','pdf','writer','beam','devices','vault','planner','terminal','ssh','recall','peek','whiteboard','lens','apps','clipboard','together','settings','books','capture'];
function caps(source: string): Map<string, number> {
  const tree = ts.createSourceFile('density.mts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let array: ts.ArrayLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'APPS' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) array = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!array) throw Error('APPS array not found');
  const found = new Map<string, number>();
  for (const entry of array.elements) {
    if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2 || !ts.isStringLiteral(entry.elements[0]) || !ts.isNumericLiteral(entry.elements[1])) throw Error('nonliteral density target');
    const name=entry.elements[0].text, cap=Number(entry.elements[1].text.replaceAll('_',''));
    if (found.has(name) || !Number.isFinite(cap) || cap <= 0) throw Error(`duplicate/invalid target ${name}`);
    found.set(name,cap);
  }
  return found;
}
function verify(source:string) {
 const found=caps(source);
 assert.deepEqual([...found.keys()].sort(),[...expected].sort(),'each TT125 target must be an executable APPS array entry');
}
const {test,finish}=makeHarness('tt230-density-coverage');
await test('all twenty density targets are declared in the executable array',{},()=>verify(readFileSync('scripts/tt125-density.mts','utf8')));
await test('a comment swallowing one target is rejected, even when nineteen execute',{},()=>{
 const entries=expected.map((id,i)=>`["${id}", ${i+1}]`);
 const source=`const APPS = [\n${entries.slice(0,9).join(',')}, // ${entries[9]}\n${entries.slice(10).join(',')}\n];`;
 assert.throws(()=>verify(source),/each TT125 target/);
});
await test('all violations and missing readings are reported rather than just the first',{},()=>{
 const failures=densityBoundFailures([['a',10],['b',10],['c',10],['d',10]],new Map([['a',{words:11}],['b',{words:12}],['d',{words:10}]]));
 assert.deepEqual(failures,['a: 11 words > bound 10','b: 12 words > bound 10','c: missing or invalid word count']);
 assert.deepEqual(densityBoundFailures([['ok',10]],new Map([['ok',{words:10}]])),[]);
 assert.equal(densityBoundFailures([['bad',10]],new Map([['bad',{words:NaN}]])).length,1);
});
finish();

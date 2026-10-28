import assert from 'node:assert/strict';
import {loadedPngDimensions} from '../src/lib/recall-memory.ts';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt103-memory-unit');
function header(w:number,h:number){const b=new Uint8Array(33);b.set([137,80,78,71,13,10,26,10]);const v=new DataView(b.buffer);v.setUint32(8,13);b.set([73,72,68,82],12);v.setUint32(16,w);v.setUint32(20,h);return b;}
await test('dimension-only admission includes exact 16MP, not decoder validity',{},()=>assert.deepEqual(loadedPngDimensions(header(4096,4096)),{width:4096,height:4096}));
await test('dimension-only admission rejects 16MP plus one row',{},()=>assert.throws(()=>loadedPngDimensions(header(4096,4097))));
await test('zero dimension fails',{},()=>assert.throws(()=>loadedPngDimensions(header(0,90))));
await test('uint32 dimension overflow cannot wrap into budget',{},()=>assert.throws(()=>loadedPngDimensions(header(0xffffffff,0xffffffff))));
await test('eight-byte PNG signature alone fails',{},()=>assert.throws(()=>loadedPngDimensions(header(8,8).slice(0,8))));
await test('wrong signature fails',{},()=>{const b=header(8,8);b[0]=0;assert.throws(()=>loadedPngDimensions(b));});
await test('IHDR must be first and thirteen bytes',{},()=>{const b=header(8,8);b[11]=12;assert.throws(()=>loadedPngDimensions(b));});
await test('wrong first chunk fails',{},()=>{const b=header(8,8);b[12]=0;assert.throws(()=>loadedPngDimensions(b));});
await test('byteOffset is honored',{},()=>{const b=new Uint8Array(40);b.set(header(16,9),7);assert.deepEqual(loadedPngDimensions(b.subarray(7)),{width:16,height:9});});
await test('over-eight-MiB fails before decode',{},()=>{const b=new Uint8Array(8388609);b.set(header(8,8));assert.throws(()=>loadedPngDimensions(b));});
finish();

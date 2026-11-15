import assert from 'node:assert/strict';
import {remoteAvailabilityLabel} from '../src/lib/remote-availability';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt177-beam-status');
await test('unknown, none and at least one remain distinct',{},()=>{
 assert.equal(remoteAvailabilityLabel(null),'unknown');
 assert.equal(remoteAvailabilityLabel(false),'none reported');
 assert.equal(remoteAvailabilityLabel(true),'at least one');
});
finish();

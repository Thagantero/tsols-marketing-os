import test from 'node:test';
import assert from 'node:assert/strict';
import {saveAndSubmit,scheduleIssue} from '../../src/publishing-flow.ts';
const now=Date.parse('2026-11-20T17:06:00Z');
const post={id:'post',revision:2,status:'approved',scheduled_at:null,schedule_cancelled_at:null,updated_at:'fresh',media_asset_id:null};
function setup(overrides={}){
 const calls=[];
 const options={mode:'schedule',date:'2026-11-20',time:'21:00',ids:['x','ig'],hasMedia:false,now,
 saveContent:async()=>{calls.push('save');return post;},
 ensureReady:async p=>{assert.equal(p.revision,2);calls.push('review');},
 savePlan:async(p,due)=>{assert.equal(p.updated_at,'fresh');calls.push('plan');return {...p,scheduled_at:due,updated_at:'planned'};},
 submit:async(p,mode,ids,due)=>{calls.push('submit');assert.equal(p.updated_at,'planned');assert.equal(due,'2026-11-20T18:00:00.000Z');assert.deepEqual(ids,['x','ig']);return 'queued';},...overrides};
 return {calls,run:()=>saveAndSubmit(options)};
}
test('saves source, checks current revision, saves plan, then submits selected destinations',async()=>{const x=setup();assert.equal(await x.run(),'queued');assert.deepEqual(x.calls,['save','review','plan','submit']);});
test('past EAT time and no destination stop before saving or submitting',async()=>{for(const overrides of [{time:'20:00'},{ids:[]}]){const x=setup(overrides);await assert.rejects(x.run());assert.deepEqual(x.calls,[]);}});
test('failed source save never submits',async()=>{const x=setup({saveContent:async()=>null});await assert.rejects(x.run(),/not saved/);assert.deepEqual(x.calls,[]);});
test('unapproved source and missing X approval stop before plan or provider',async()=>{let x=setup({saveContent:async()=>({...post,status:'draft'})});await assert.rejects(x.run(),/Approve/);x=setup({ensureReady:async()=>{throw new Error('X review required');}});await assert.rejects(x.run(),/X review/);assert.deepEqual(x.calls,['save']);});
test('matching saved plan does not rewrite the schedule',async()=>{const x=setup({saveContent:async()=>({...post,scheduled_at:'2026-11-20T18:00:00Z',updated_at:'planned'})});await x.run();assert.deepEqual(x.calls,['review','submit']);});
test('new media is checked after saving',async()=>{const x=setup({date:'2026-11-28',saveContent:async()=>({...post,media_asset_id:'new-media'})});await assert.rejects(x.run(),/seven days/);assert.deepEqual(x.calls,[]);});
test('publish now ignores calendar time and never saves a plan',async()=>{const x=setup({mode:'publish',time:'',submit:async(p,mode,ids,due)=>{assert.equal(mode,'publish');assert.equal(due,undefined);return 'sent';}});assert.equal(await x.run(),'sent');assert.deepEqual(x.calls,['save','review']);});
test('missing schedule time has a useful error',()=>assert.match(scheduleIssue('2026-11-20','',false,now),/Choose a publishing date and time/));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../accounts.mjs';
import { israelDate, shiftDate } from '../time.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('a request warms the coming week and saved days are served without waiting for a club login',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'arlo-perf-'));let now=Date.now(),logins=0,days=[];
  const clientFactory=()=>({session:null,dayCache:new Map(),
    async login(){logins++;await sleep(300);this.session={userId:1,token:'t',name:'M'};},
    async calendar(start){days.push(start);await sleep(5);return [];}});
  const accounts=new Accounts(dir,undefined,{clientFactory,now:()=>now});
  t.after(()=>{accounts.close();rmSync(dir,{recursive:true});});
  const ctx=await accounts.login('0500000001','x'),today=israelDate(now);
  assert.ok(!(await ctx.schedule(today)).stale);
  const week=Array.from({length:7},(_,i)=>shiftDate(today,i));
  for(let i=0;i<100&&!week.every(d=>ctx.store.get(`calendar:${d}:1`));i++)await sleep(20);
  assert.ok(week.every(d=>ctx.store.get(`calendar:${d}:1`)),'whole week saved in the background');
  assert.equal(days.filter(d=>d===today).length,1,'the requested day is not fetched twice');
  now+=60000;ctx.client.session=null;ctx.client.dayCache.clear();logins=0;
  const started=performance.now(),saved=await ctx.schedule(shiftDate(today,3));
  assert.equal(saved.stale,true);assert.ok(performance.now()-started<150,'saved day returned before the 300 ms login finished');
  assert.ok(!saved.failed,'an old copy is not reported as a failure');
  await sleep(450);assert.equal(logins,1,'the stale day is still refreshed in the background');
  ctx.client.calendar=async()=>{throw new Error('club down');};ctx.client.dayCache.clear();now+=60000;
  const failed=await ctx.schedule(shiftDate(today,3),1,true);
  assert.ok(failed.stale&&failed.failed,'a refresh that really failed is reported as failed');
});

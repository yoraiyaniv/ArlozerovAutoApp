import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../accounts.mjs';
import { createApplication } from '../server.mjs';
test('A/B variant is stable per account; events are validated and aggregated by variant',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'arlo-ab-'));
  const clientFactory=()=>({session:null,dayCache:new Map(),async login(phone){this.session={userId:Number(phone.slice(-1)),token:'t',name:'M'};}});
  const accounts=new Accounts(dir,undefined,{clientFactory,workers:false});const server=createApplication(accounts);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));accounts.close();rmSync(dir,{recursive:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function req(path,cookie,method='GET',data){
    const res=await fetch(origin+'/api/'+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  assert.equal((await req('ab/report')).status,401);
  const users=[];
  for(let i=1;i<=12;i++){const l=await req('auth',null,'POST',{phone:'050000000'+(i%10)+'0'.repeat(0)+i,password:'x'});users.push(l.cookie);}
  const variants=[];
  for(const c of users){
    const v=(await req('state',c)).data.abVariant;assert.ok(['A','B'].includes(v));
    assert.equal((await req('state',c)).data.abVariant,v);variants.push(v);
    assert.equal((await req('ab/event',c,'POST',{event:'dialog_opened'})).status,200);
    assert.equal((await req('ab/event',c,'POST',{event:'rule_created'})).status,200);
  }
  assert.ok(new Set(variants).size===2,'expected both variants across 12 accounts');
  assert.equal((await req('ab/event',users[0],'POST',{event:'bogus'})).status,400);
  const report=(await req('ab/report',users[0])).data;
  for(const v of ['A','B']){const n=variants.filter(x=>x===v).length;assert.equal(report[v].dialog_opened||0,n);assert.equal(report[v].conversion,n?1:null);}
});

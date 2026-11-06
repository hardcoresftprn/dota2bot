import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './helpers/d1.js';
import { rankCounters, parseCounterPage, loadCounters, normalizeCells } from '../src/counters.js';
const hero=(id,pos=[50,30,20,0,0])=>({id,name:`Hero ${id}`,slug:`hero-${id}`,pos});
const data={heroes:[hero(1),hero(2),hero(3),hero(4,[0,0,0,80,20]),hero(5)],cells:{1:{2:[8,58,1000],3:[4,54,500],4:[6,56,700],5:[10,60,1000]},5:{2:[-6,44,900],3:[3,53,500],4:[2,52,700]}},patch:'7.41f',checkedAt:100};
test('counter direction, role filtering, exclusion and whole draft coverage',()=>{
 assert.equal(rankCounters(data,[1],1).heroes[0].id,5);
 const r=rankCounters(data,[1,5],1);assert.equal(r.heroes[0].id,3);assert.equal(r.heroes[0].advantage,3.5);assert.equal(r.heroes[0].pairs[0].winrate,54);
 assert.deepEqual(rankCounters(data,[1,5],4).heroes.map(h=>h.id),[4]);
 const d=structuredClone(data);delete d.cells[5][3];assert.ok(!rankCounters(d,[1,5],1).heroes.some(h=>h.id===3));
 for(const [ids,pos] of [[[1,1],1],[[999],1],[[],1],[[1],0],[[1],6],[[1,2,3,4,5,6],1]])assert.throws(()=>rankCounters(data,ids,pos));
});
test('public catalogue parsed as JSON; malformed source rejected',()=>{
 const heroes=Array.from({length:100},(_,i)=>hero(i+1));
 const record='aa:'+JSON.stringify(['$','$L1',null,{data:{heroes,fetchedAt:'2026-11-06T12:00:00Z'}}])+'\n';
 const html='<title>Counter picker 7.41f</title><script>self.__next_f.push([1,'+JSON.stringify(record)+'])</script>';
 assert.equal(parseCounterPage(html).heroes.length,100);assert.equal(parseCounterPage(html).patch,'7.41f');
 assert.throws(()=>parseCounterPage('<script>throw new Error()</script>'));assert.throws(()=>parseCounterPage(html.replace('fetchedAt','missing')));
});
test('small or malformed matchup samples excluded',()=>{
 const heroes=Array.from({length:100},(_,i)=>hero(i+1));
 const cells=Object.fromEntries(heroes.map(e=>[e.id,Object.fromEntries(heroes.filter(h=>h.id!==e.id).map(h=>[h.id,[1,51,200]]))]));
 cells[1][2]=[2,55,149];cells[1][3]=[2,101,1000];cells[1][4]=['2',55,1000];
 const c=normalizeCells(cells,heroes);assert.equal(c[1][2],undefined);assert.equal(c[1][3],undefined);assert.equal(c[1][4],undefined);assert.deepEqual(c[2][1],[1,51,200]);assert.throws(()=>normalizeCells({},heroes));
});
test('cache, stale fallback, backoff and expiration',async t=>{
 const db=new D1(),timestamp=100000;db.db.prepare('INSERT INTO meta VALUES(?,?)').run('counters:v3',JSON.stringify({...data,checkedAt:timestamp,catalogueUpdatedAt:timestamp}));
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('offline');});
 assert.equal((await loadCounters(db,timestamp+100)).stale,false);assert.equal(calls,0);
 assert.equal((await loadCounters(db,timestamp+3601)).stale,true);assert.equal(calls,2);await loadCounters(db,timestamp+3602);assert.equal(calls,2);
 await assert.rejects(loadCounters(db,timestamp+3*86400));db.db.close();
});

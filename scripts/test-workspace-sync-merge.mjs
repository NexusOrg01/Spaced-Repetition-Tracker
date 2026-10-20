import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const merge=require('../workspace-sync-merge.js');
const snap=(state,featureState={})=>({app:'Nexus',schema:4,exportedAt:'2026-10-20T00:00:00.000Z',state:{schema:3,streams:[{id:'s',name:'General'}],subjects:[{id:'sub',name:'Commerce',streamId:'s',order:0}],topics:[],history:[],exams:[],settings:{theme:'system',intervalCap:120},...state},featureState:{journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[],settings:{dailyMinutes:90},...featureState}});
{
 const base=snap({topics:[]});
 const local=snap({topics:[{id:'a1',name:'Offline topic',subjectId:'sub'}]});
 const remote=snap({topics:[{id:'a2',name:'Online topic',subjectId:'sub'}]});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.state.topics.map(x=>x.id).sort(),['a1','a2'],'independent offline/online additions must merge without a choice');
 assert.equal(result.conflicts.length,0);
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-11-01'}]});
 const local=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'offline notes',dueDate:'2026-11-01'}]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base',dueDate:'2026-12-01'}]});
 const result=merge.merge(base,local,remote),row=result.payload.state.topics[0];
 assert.equal(row.notes,'offline notes','offline edit to one field is retained');
 assert.equal(row.dueDate,'2026-12-01','cloud edit to a different field is incorporated');
 assert.equal(result.conflicts.length,0);
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base'}]});
 const local=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'local'}]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'remote'}]});
 const result=merge.merge(base,local,remote);
 assert.equal(result.payload.state.topics[0].notes,'local','same-field collisions use documented local-device precedence');
 assert.ok(result.conflicts.some(c=>c.path.includes('topics[t1].notes')&&c.local==='local'&&c.remote==='remote'),'conflicting alternatives must be recorded');
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub'}]});
 const local=snap({topics:[]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub'}]});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.state.topics,[],'a deletion on one device is honored when the other device did not change the record');
}
{
 const base=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'base'}]});
 const local=snap({topics:[]});
 const remote=snap({topics:[{id:'t1',name:'Topic',subjectId:'sub',notes:'remote edit'}]});
 const result=merge.merge(base,local,remote);
 assert.equal(result.payload.state.topics[0].notes,'remote edit','an edit concurrent with deletion is preserved');
 assert.ok(result.conflicts.some(c=>c.path==='state.topics[t1]'),'delete-versus-edit must be recorded for recovery');
}
{
 const base=snap({}, {selectedTopicIds:['t1']});
 const local=snap({}, {selectedTopicIds:[]});
 const remote=snap({}, {selectedTopicIds:['t1','t2']});
 const result=merge.merge(base,local,remote);
 assert.deepEqual(result.payload.featureState.selectedTopicIds,['t2'],'independent additions and removals in a set merge correctly');
}
console.log('Automatic three-way workspace merge tests passed.');

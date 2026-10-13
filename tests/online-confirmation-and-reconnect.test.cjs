const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const legacy=fs.readFileSync(path.join(__dirname,'offline-sync.test.cjs'),'utf8');
const preamble=legacy.slice(0,legacy.indexOf('const tests = [];'));
function fixture(){
 const h=new Function('require','__dirname',preamble+';return {api,context,records,listeners,request,pendingEntry,setRemote(fn){remoteFetch=fn;}};')(require,__dirname);
 vm.runInContext('__syncTest.save=saveLocallyThenSend;',h.context);return h;
}
const tick=()=>new Promise(setImmediate);
test('en línea devuelve el resultado real y no presenta la operación como guardado offline',async()=>{
 const h=fixture();h.setRemote(async request=>Response.json({...JSON.parse(await request.text()),name:'Confirmado por backend'},{status:201}));
 const response=await h.api.save(h.request('menu_items','POST',{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Local'}));
 assert.equal(response.status,201);assert.equal(response.headers.get('X-Offline-Queued'),null);assert.equal((await response.json()).name,'Confirmado por backend');
 assert.equal((await h.api.listEntries())[0].status,'confirmed');
});
test('sin internet conserva el mismo UUID y al volver confirma el envío sin duplicarlo',async()=>{
 const h=fixture();vm.runInContext('networkAvailable=false;',h.context);let calls=0;
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';h.setRemote(async request=>{calls++;assert.equal(JSON.parse(await request.text()).id,id);return Response.json({id},{status:201});});
 const response=await h.api.save(h.request('menu_items','POST',{id,name:'Pendiente'}));assert.equal(response.headers.get('X-Offline-Queued'),'1');assert.equal(calls,0);
 vm.runInContext('networkAvailable=true;',h.context);await h.api.flushQueue(true);await h.api.flushQueue(true);
 assert.equal(calls,1);assert.equal((await h.api.listEntries())[0].status,'confirmed');
});
test('una escritura lenta no retiene otro producto y la recuperación no duplica envíos activos',async()=>{
 const h=fixture();let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 h.setRemote(async request=>{const row=JSON.parse(await request.text());calls.push(row.id);if(row.name==='Lento')await gate;return Response.json(row,{status:201});});
 const slow=h.api.save(h.request('menu_items','POST',{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Lento'}));await tick();
 const fast=await h.api.save(h.request('menu_items','POST',{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Rápido'}));assert.equal(fast.status,201);
 await h.api.recoverInterruptedEntries();await h.api.flushQueue(true);assert.equal(calls.length,2);
 release();assert.equal((await slow).status,201);assert.equal(calls.length,2);
});
test('reconectar procesa registros independientes a la vez y mantiene el orden del mismo producto',async()=>{
 const h=fixture();let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 for(const [index,id] of [[1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],[2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],[3,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']])await h.api.putEntry(h.pendingEntry({id:'entry-'+index,recordId:id,recordIds:[id],payload:{id,name:String(index)},body:JSON.stringify({id,name:String(index)}),createdOrder:index}));
 h.setRemote(async request=>{const row=JSON.parse(await request.text());calls.push(row.name);if(row.name==='1')await gate;return Response.json(row,{status:201});});
 const flushing=h.api.flushQueue(true);await tick();await tick();assert.ok(calls.includes('1')&&calls.includes('2'));assert.ok(!calls.includes('3'));
 release();await flushing;assert.equal(calls.filter(name=>name==='1').length,1);assert.ok(calls.indexOf('3')>calls.indexOf('1'));
});
test('un rechazo real vuelve al formulario y no queda como caché pendiente',async()=>{
 const h=fixture();h.setRemote(async()=>Response.json({message:'No autorizado'},{status:403}));
 const response=await h.api.save(h.request('menu_items','POST',{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Local'}));
 assert.equal(response.status,403);assert.equal(response.headers.get('X-Offline-Queued'),null);assert.equal((await h.api.listEntries()).length,0);
});

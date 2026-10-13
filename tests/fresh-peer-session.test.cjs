const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const s=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function harness(){
 let now=1000;const state={confirmedRemoteRows:new Map()},context=vm.createContext({state,Map,Number,JSON,String,Date:{now:()=>now},applyCancelledSessionExpectations:row=>row});
 const a=s.indexOf('  class OptimisticSessionMap'),b=s.indexOf('  const rememberRemoteConfirmation',a);
 const match=s.match(/^const REMOTE_CONFIRMATION_HOLD_MS = [0-9]+;/m);assert.ok(match,'La constante también debe existir en BCA, sin inyectarla desde el test.');
 const start=s.indexOf('  const sessionItemMatches ='),end=s.indexOf('\n  const ',s.indexOf('  const mergeOptimisticSessions =',start)+35);
 vm.runInContext(match[0]+s.slice(a,b)+s.slice(start,end)+';globalThis.api={Overlay:OptimisticSessionMap,merge:mergeOptimisticSessions};',context);
 state.optimisticSessionStates=new context.api.Overlay();return {state,api:context.api,setNow:value=>now=value};
}
const line=quantity=>({id:'line',item_name:'Agua',quantity,unit_price:1000,notes:'',status:'served'});
test('una lectura posterior a la confirmación acepta cambios del otro equipo sin volver a imponer la copia local',()=>{
 const h=harness();h.state.optimisticSessionStates.set('s',{mode:'upsert',session:{id:'s',session_items:[line(2)]},expectedItems:[line(2)]});
 h.state.confirmedRemoteRows.set('session_items:line',{row:line(2),at:1500});h.setNow(2000);
 const fresh=h.api.merge([{id:'s',session_items:[line(7)]}],{readStartedAt:1800});assert.equal(fresh[0].session_items[0].quantity,7);assert.equal(h.state.optimisticSessionStates.size,0);
});
test('una lectura iniciada antes del guardado conserva el consumo local pendiente',()=>{
 const h=harness();h.state.optimisticSessionStates.set('s',{mode:'upsert',session:{id:'s',session_items:[line(2)]},expectedItems:[line(2)]});
 h.state.confirmedRemoteRows.set('session_items:line',{row:line(2),at:1500});h.setNow(2000);
 assert.equal(h.api.merge([{id:'s',session_items:[line(1)]}],{readStartedAt:500})[0].session_items[0].quantity,2);
});
test('otro cobro confirmado no restaura una cuenta que el backend ya cerró',()=>{
 const h=harness();h.state.optimisticSessionStates.set('s',{mode:'upsert',session:{id:'s',session_items:[line(2)]},expectedItems:[line(2)]});
 h.state.confirmedRemoteRows.set('session_items:line',{row:line(2),at:1500});h.setNow(2000);
 assert.equal(h.api.merge([],{readStartedAt:1800}).length,0);
});

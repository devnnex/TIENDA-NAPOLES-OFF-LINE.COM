const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const source=fs.readFileSync(path.join(__dirname,"../app.js"),"utf8");
test("dos inicios simultaneos despues del guardado durable no procesan la cola dos veces",async()=>{
  let finishSave,finishStatus,reads=0;
  const saving=new Promise(resolve=>{finishSave=resolve;}),status=new Promise(resolve=>{finishStatus=resolve;});
  const state={appsScriptOutboxBusy:false};
  const context=vm.createContext({state,Date,performance:{now:()=>0},isAppsScriptConfigured:()=>true,flushDurableWrites:()=>saving,
    readAppsScriptOutbox:()=>[],getOfflineSyncStatus:()=>{reads++;return status;},nextReadyAppsScriptJob:()=>null,
    setInventorySyncStatus(){},updateGlobalSyncStatus(){}});
  const from=source.indexOf("  const runAppsScriptOutbox ="),to=source.indexOf("  const flushAppsScriptOutbox =",from);
  vm.runInContext(source.slice(from,to)+";globalThis.send=runAppsScriptOutbox;",context);
  const first=context.send(),second=context.send();finishSave(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.equal(state.appsScriptOutboxBusy,true);
  finishStatus({});assert.equal(await first,true);assert.equal(await second,false);assert.equal(state.appsScriptOutboxBusy,false);
});

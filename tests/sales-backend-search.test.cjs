const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),SalesShift=require('../sales-shift.js');
function block(name){const a=source.indexOf('  const '+name+' ='),b=source.indexOf('\n  const ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
function between(from,to){const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);}
const filters={dateFrom:'2026-01-01',dateTo:'2026-10-31',paymentMethod:'all',saleType:'all',query:'soda/ginger',limit:300};
const sale=(id,quantity=1)=>({saleId:id,date:'2026-10-20T12:00:00-05:00',invoice:'TN-'+id,total:quantity*100+900,cost:quantity*20+100,
 profit:quantity*80+800,items:[{name:'SODA/GINGER',quantity,total:quantity*100,cost:quantity*20},{name:'Otro',quantity:1,total:900,cost:100}],payments:[]});
const report=(records,revision='r1',limit=300)=>({ok:true,revision,records:records.slice(0,limit),recordRows:records.map((row,i)=>({saleId:row.saleId,row:i+2})),totalRecords:records.length,
 truncated:records.length>300,totals:{income:records.reduce((sum,row)=>sum+row.total,0),cost:0,profit:0,sales:records.length}});
function harness(rows=[sale('real',32)]){
 const state={page:'admin',activeAdminSection:'income',incomeRequestId:0,invoiceHistory:[{id:'local-fake'}],items:[{id:'p',name:'SODA/GINGER'}],inventoryMeta:{},syncFresh:{},
  incomeReport:{filters,records:[sale('cached',999)],totals:{income:99999},revision:'r1'},incomeReportSnapshots:new Map([['stale',{records:[sale('cached',999)]}]])};
 const nodes=new Map();for(const id of ['#income','#incomeKpis','#incomePaymentBreakdown','#incomeRecords','#incomeFilterSummary','#moreIncomeRecords'])nodes.set(id,{innerHTML:'',querySelectorAll:()=>[]});
 let current={...filters},backendRows=rows,revision='r1',handler=null;const calls=[],timers=[],notices=[];
 const context=vm.createContext({state,SalesShift,$:id=>nodes.get(id),canAccessAdminSection:()=>true,isAppsScriptConfigured:()=>true,
  window:{setTimeout(fn,delay){const job={fn,delay,cancelled:false};timers.push(job);return job;},clearTimeout(job){if(job)job.cancelled=true;}},
  clearTimeout(){},Date,Map,Set,Number,Object,JSON,navigator:{onLine:true},APPS_SCRIPT_TIMEOUT_MS:1000,INCOME_REPORT_CACHE_KEY:'forbidden-cache',
  incomeFiltersFromForm:()=>({...current}),incomeRecordSaleType:row=>row.saleType||'table',renderSalesShift(){},refreshIcons(){},isBoss:()=>false,
  incomePaymentLabel:String,incomeSaleTypeLabel:String,formatIncomeDate:String,escapeHTML:String,icon:()=>'',money:String,emptyState:(a,b)=>a+' '+b,
  setIncomeReportStatus:(...args)=>notices.push(args),toast(){throw Error('No debe mostrar un error al usuario durante el reintento');},
  readLocalJson(){throw Error('No debe leer datos guardados');},readAppsScriptStatus(){throw Error('No debe validar una búsqueda usando un estado guardado');},
  readAppsScriptOutbox(){throw Error('No debe mezclar operaciones locales');},persistDurableJson(){throw Error('No debe guardar la búsqueda en caché');},
  mergeIncomeReport(){throw Error('No debe mezclar facturas locales');},
  appsScriptRequest:async(action,payload)=>{
   calls.push({action,payload});
   if(handler)return handler(action,payload);
   if(action==='status')return {ok:true,historyRevision:revision};
   if(payload.filters.pageRows)return {ok:true,revision,records:payload.filters.pageRows.map(key=>backendRows.find(row=>row.saleId===key.saleId)).filter(Boolean)};
   return report(backendRows,revision,payload.filters.limit);
  }});
 vm.runInContext(block('normalizeText')+between('filterIncomeReportBySaleType','incomeSaleTypeFiltersKey')+
  between('renderIncomeReport','refreshBackgroundReports')+';globalThis.api={load:loadIncomeReport,summary:incomeProductSummary};',context);
 return {state,context,api:context.api,nodes,calls,timers,notices,setRows:value=>{backendRows=value;},setRevision:value=>{revision=value;},setFilters:value=>{current={...current,...value};},setHandler:value=>{handler=value;},retry:()=>{const timer=timers.findLast(job=>!job.cancelled);assert.ok(timer);timer.cancelled=true;return timer.fn();}};
}
test('la misma búsqueda consulta otra vez al backend aunque la revisión no cambie y nunca lee ni suma datos locales',async()=>{
 const h=harness();assert.equal(await h.api.load(),true);
 assert.equal(h.api.summary(h.state.incomeReport).quantity,32);assert.equal(h.state.incomeReport.backendSearch,true);
 assert.equal(h.state.incomeReport.records[0].saleId,'real');assert.equal(h.state.incomeSaleTypeSnapshot,null);
 h.setRows([sale('real',40)]);assert.equal(await h.api.load(),true);
 assert.equal(h.api.summary(h.state.incomeReport).quantity,40);
 assert.equal(h.calls.filter(call=>call.action==='get_income_report'&&!call.payload.filters.pageRows).length,2);
 assert.ok(h.calls.every(call=>call.payload.backendOnly||call.payload.filters?.backendOnly));
});
test('hasta 500 facturas de un producto se confirman con una sola llamada al backend y ninguna lectura adicional de estado',async()=>{
 for(const count of [0,32,300,450,500]){
  const h=harness(Array.from({length:count},(_,i)=>sale(String(i))));
  assert.equal(await h.api.load(),true);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].action,'get_income_report');assert.equal(h.calls[0].payload.filters.limit,500);
  assert.equal(h.api.summary(h.state.incomeReport).quantity,count);assert.equal(h.api.summary(h.state.incomeReport).income,count*100);
 }
});
test('1501 facturas se consultan completas con hasta cuatro páginas en paralelo, sin mostrar un total parcial',async()=>{
 const rows=Array.from({length:1501},(_,i)=>sale(String(i))),h=harness(rows);let active=0,peak=0;
 h.setHandler(async(action,payload)=>{
  if(action==='status')return {ok:true,historyRevision:'r1'};
  if(!payload.filters.pageRows)return report(rows,'r1',payload.filters.limit);
  active++;peak=Math.max(peak,active);
  assert.equal(h.state.incomeReport.awaitingBackend,true);assert.doesNotMatch(h.nodes.get('#incomeKpis').innerHTML,/Unidades vendidas/);
  await new Promise(resolve=>setImmediate(resolve));active--;
  return {ok:true,revision:'r1',records:payload.filters.pageRows.map(key=>rows[Number(key.saleId)])};
 });
 assert.equal(await h.api.load(),true);assert.equal(peak,4);
 assert.equal(h.calls.length,5);
 assert.equal(h.calls.some(call=>call.action==='status'),false);
 assert.equal(h.api.summary(h.state.incomeReport).quantity,1501);assert.equal(h.api.summary(h.state.incomeReport).income,150100);
 assert.equal(new Set(h.state.incomeReport.records.map(row=>row.saleId)).size,1501);
});
test('dos fallos consecutivos se reintentan automáticamente con pausas cortas y sin mostrar cifras locales ni avisos de error',async()=>{
 const h=harness();let remaining=2;
 h.setHandler(async action=>{if(remaining-->0)throw Error('network');return action==='status'?{ok:true,historyRevision:'r1'}:report([sale('real',32)]);});
 assert.equal(await h.api.load(),false);assert.equal(h.state.incomeReport.awaitingBackend,true);
 assert.doesNotMatch(h.nodes.get('#incomeKpis').innerHTML,/999|Ventas sin confirmar/);
 assert.equal(h.timers.at(-1).delay,200);assert.equal(await h.retry(),false);assert.equal(h.timers.at(-1).delay,400);
 assert.equal(await h.retry(),true);assert.equal(h.api.summary(h.state.incomeReport).quantity,32);assert.equal(h.state.incomeBackendRetryCount,0);
 assert.ok(h.notices.every(notice=>notice[1]!=='warning'));
});
test('una página incompleta no se presenta como total y se vuelve a consultar toda la búsqueda',async()=>{
 const rows=Array.from({length:650},(_,i)=>sale(String(i))),h=harness(rows);let incomplete=true;
 h.setHandler(async(action,payload)=>{
  if(action==='status')return {ok:true,historyRevision:'r1'};
  if(!payload.filters.pageRows)return report(rows);
  return {ok:true,revision:'r1',records:incomplete?[]:payload.filters.pageRows.map(key=>rows[Number(key.saleId)])};
 });
 assert.equal(await h.api.load(),false);assert.equal(h.state.incomeReport.awaitingBackend,true);assert.equal(h.state.incomeReport.records.length,0);
 incomplete=false;assert.equal(await h.retry(),true);assert.equal(h.api.summary(h.state.incomeReport).quantity,650);
});
test('si el backend detecta cambios en una página, repite desde el principio antes de confirmar el resultado',async()=>{
 const rows=Array.from({length:650},(_,i)=>sale(String(i),2)),h=harness(rows);let stale=true;
 h.setHandler(async(_action,payload)=>{
  if(!payload.filters.pageRows)return report(rows,stale?'r1':'r2',payload.filters.limit);
  if(stale){stale=false;return {ok:true,stale:true,records:[]};}
  return {ok:true,revision:'r2',records:payload.filters.pageRows.map(key=>rows[Number(key.saleId)])};
 });
 assert.equal(await h.api.load(),true);assert.equal(h.api.summary(h.state.incomeReport).quantity,1300);
 assert.equal(h.state.incomeRevision,'r2');assert.equal(h.calls.length,4);
});

test('una respuesta anterior y un reintento de un filtro abandonado nunca reemplazan la nueva búsqueda',async()=>{
 const h=harness();let release;
 h.setHandler(async(action,payload)=>action==='status'?{ok:true,historyRevision:'r1'}:payload.filters.query==='soda/ginger'?new Promise(resolve=>{release=resolve;}):report([sale('latest',7)]));
 const old=h.api.load();h.setFilters({query:'soda'});assert.equal(await h.api.load(),true);
 release(report([sale('old',999)]));await old;assert.equal(h.state.incomeReport.records[0].saleId,'latest');
 h.setHandler(async()=>{throw Error('offline');});await h.api.load();const before=h.calls.length;h.setFilters({query:'otro'});await h.retry();assert.equal(h.calls.length,before);
});
test('sin conexión no usa datos guardados: conserva la consulta pendiente hasta recuperar el backend',async()=>{
 const h=harness();h.context.navigator.onLine=false;h.setHandler(async()=>{throw Error('offline');});
 await h.api.load();assert.equal(h.state.incomeReport.awaitingBackend,true);assert.equal(h.state.incomeReport.records.length,0);
 h.setHandler(null);await h.retry();assert.equal(h.api.summary(h.state.incomeReport).quantity,32);
});
test('la sincronización local no modifica una búsqueda confirmada o pendiente del backend',()=>{
 const h=harness();h.context.reportMirror=()=>{throw Error('No debe consultar la réplica local');};
 vm.runInContext(block('mergeConfirmedIncomeReport')+';globalThis.merge=mergeConfirmedIncomeReport;',h.context);
 for(const awaitingBackend of [true,false]){const value={backendSearch:true,awaitingBackend,records:[sale('backend')]};assert.equal(h.context.merge(value,filters),value);}
});
test('las solicitudes de búsqueda y comprobación de revisión desactivan la caché HTTP',async()=>{
 const requests=[],context=vm.createContext({state:{authToken:'test'},location:{origin:'https://test.local'},AbortController,clearTimeout(){},
  window:{setTimeout:()=>1,clearTimeout(){}},isAppsScriptConfigured:()=>true,getAppsScriptUrl:()=> 'https://test.local/backend',
  APPS_SCRIPT_TIMEOUT_MS:1000,fetch:async(url,options)=>{requests.push(options);return {ok:true,text:async()=>JSON.stringify({ok:true,revision:'r1'})};}});
 vm.runInContext(block('appsScriptRequest')+';globalThis.request=appsScriptRequest;',context);
 await context.request('get_income_report',{filters:{query:'soda/ginger',backendOnly:true}});
 await context.request('status',{backendOnly:true});
 assert.deepEqual(requests.map(request=>request.cache),['no-store','no-store']);
});
if(source.includes('  const runRefreshAction ='))test('Actualizar en OFFLINE mantiene silencioso el reintento de una búsqueda pendiente, incluso sin red',async()=>{
 for(const online of [true,false]){
  const context=vm.createContext({state:{incomeReport:{backendSearch:true,awaitingBackend:true}},navigator:{onLine:online},
   icon:()=>'',refreshIcons(){},toast(){throw Error('No debe anunciar ni un error ni una actualización confirmada durante el reintento');}});
  vm.runInContext(block('runRefreshAction')+';globalThis.refresh=runRefreshAction;',context);
  const button={id:'refreshIncomeReport',disabled:false,innerHTML:'Actualizar'};
  assert.equal(await context.refresh(button,async()=>!online,'Ventas actualizadas'),false);assert.equal(button.disabled,false);
 }
});

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const filters={dateFrom:'2026-10-19',dateTo:'2026-10-19',saleType:'all',paymentMethod:'all',query:''};
const report=(total,revision='new')=>({ok:true,filters,records:[{saleId:'sale',total,profit:total,cost:0,items:[],payments:[],date:'2026-10-19T12:00:00Z'}],recordRows:[{saleId:'sale',row:2}],recordKeys:['sale'],totalRecords:1,revision,totals:{income:total,profit:total,cost:0,sales:1},generatedAt:'2026-10-19T12:00:00Z'});
function fixture({cached=null,initial=null,online=true}={}) {
 const state={page:'admin',authToken:'boss',currentUser:{id:'boss'},incomeAwaitingRemote:true,incomeReport:initial,incomeRequestId:0,
  activeAdminSection:'income',incomeRangePreset:'today',incomeVisibleCount:60,syncFresh:{}};
 const histories=[],nodes=new Map(),requests=[],statusReads=[],saved=[];let status=deferred();
 for(const id of ['#income','#incomeKpis','#incomePaymentBreakdown','#incomeRecords','#incomeFilterSummary','#moreIncomeRecords']) {
  nodes.set(id,{markup:'',querySelectorAll:()=>[],set innerHTML(value){this.markup=value;histories.push([id,value]);},get innerHTML(){return this.markup;}});
 }
 const context=vm.createContext({state,navigator:{onLine:online},Date,clearTimeout,window:{setTimeout},
  $:id=>nodes.get(id),canAccessAdminSection:()=>true,incomeFiltersFromForm:()=>({...filters}),
  readAppsScriptOutbox:()=>[],INCOME_REPORT_CACHE_KEY:'cache',readLocalJson:()=>cached,
  mergeIncomeReport:(value,current)=>({...value,filters:current}),localIncomeReport:()=>({...report(111,'local'),localOnly:true}),
  isAppsScriptConfigured:()=>true,APPS_SCRIPT_TIMEOUT_MS:45000,
  readAppsScriptStatus:()=>{statusReads.push('status');return status.promise;},
  appsScriptRequest:(action)=>{if(action==='status'){statusReads.push(action);return status.promise;}const gate=deferred();requests.push(gate);return gate.promise;},
  persistDurableJson:async(key,value)=>{saved.push(structuredClone(value));},updateGlobalSyncStatus(){},toast(){},
  renderSalesShift(){},isBoss:()=>false,formatIncomeDate:String,incomePaymentLabel:String,incomeSaleTypeLabel:String,incomeRecordSaleType:()=> 'table',
  escapeHTML:String,icon:()=>'',money:String,emptyState:(title,description)=>title+' '+description,refreshIcons(){},setIncomeReportStatus(){},
  syncConfirmedReports:async()=>false,flushAppsScriptOutbox:async()=>true
 });
 vm.runInContext(section('  const renderIncomeReport =','  const refreshBackgroundReports =')
  +';globalThis.api={render:renderIncomeReport,load:loadIncomeReport};',context);
 return {state,context,histories,nodes,requests,status,statusReads,saved};
}
test('al abrir con red no pinta cifras del historial local ni de una copia sin verificar',async()=>{
 const f=fixture({cached:{filters,report:report(999,'old')}});
 const reading=f.context.api.load({force:true});
 assert.equal(f.state.incomeAwaitingRemote,true);
 assert.match(f.nodes.get('#incomeKpis').markup,/is-loading/);
 assert.ok(f.histories.every(([,markup])=>!markup.includes('999')&&!markup.includes('111')));
 f.requests[0].resolve(report(54321));assert.equal(await reading,true);
 assert.equal(f.state.incomeAwaitingRemote,false);
 assert.match(f.nodes.get('#incomeKpis').markup,/54321/);
 assert.equal(f.saved.at(-1).report.totals.income,54321);
});
test('una copia con la misma revisión solo aparece después de comprobar la revisión remota',async()=>{
 const f=fixture({cached:{filters,report:report(4321,'same')}});
 const reading=f.context.api.load({background:true});
 assert.match(f.nodes.get('#incomeKpis').markup,/is-loading/);
 assert.doesNotMatch(f.nodes.get('#incomeKpis').markup,/4321/);
 f.status.resolve({ok:true,historyRevision:'same'});assert.equal(await reading,true);
 assert.equal(f.requests.length,0);
 assert.match(f.nodes.get('#incomeKpis').markup,/4321/);
});
test('el refresco en segundo plano conserva el DOM si los datos no cambiaron y actualiza el conjunto si cambiaron',async()=>{
 const f=fixture();let reading=f.context.api.load({force:true});f.requests[0].resolve(report(500));await reading;
 const writes=f.histories.length;
 reading=f.context.api.load({background:true,force:true});
 assert.equal(f.histories.length,writes);
 f.requests[1].resolve({...report(500),generatedAt:'2026-10-19T12:00:05Z'});await reading;
 assert.equal(f.histories.length,writes,'La revisión de los mismos valores no reconstruye tarjetas ni detalles.');
 reading=f.context.api.load({background:true,force:true});f.requests[2].resolve(report(900,'changed'));await reading;
 assert.match(f.nodes.get('#incomeKpis').markup,/900/);
});
test('si la consulta inicial falla, muestra la copia como local sin dejar la pantalla en carga',async()=>{
 const f=fixture({cached:{filters,report:report(999,'old')}});const reading=f.context.api.load({force:true});
 f.requests[0].reject(Error('Red interrumpida'));assert.equal(await reading,false);
 assert.equal(f.state.incomeAwaitingRemote,false);assert.equal(f.state.incomeReport.localOnly,true);
 assert.match(f.nodes.get('#incomeKpis').markup,/999/);
});
if(source.includes('  const refreshSalesAfterResume ='))test('al volver a PWA invalida la lectura anterior y agrupa eventos de foco y visibilidad',async()=>{
 const f=fixture({initial:report(100,'old')});
 vm.runInContext(section('  let salesResumeAt =','  const resumeRealtimeReception =')+';globalThis.resume=refreshSalesAfterResume;',f.context);
 const old=f.context.api.load({background:true,force:true});
 const resumed=f.context.resume();assert.equal(f.context.resume(),resumed);
 assert.match(f.nodes.get('#incomeKpis').markup,/is-loading/);
 f.requests[0].resolve(report(200,'stale'));assert.equal(await old,false);
 assert.doesNotMatch(f.nodes.get('#incomeKpis').markup,/200/);
 f.requests[1].resolve(report(700,'fresh'));assert.equal(await resumed,true);
 assert.match(f.nodes.get('#incomeKpis').markup,/700/);
});

 test('si falla la comprobacion ligera intenta el informe remoto completo',async()=>{
 const f=fixture({cached:{filters,report:report(4321,'old')}});const reading=f.context.api.load();
 f.status.reject(Error('Comprobacion interrumpida'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests.length,1);
 f.requests[0].resolve(report(8000,'new'));assert.equal(await reading,true);
 assert.match(f.nodes.get('#incomeKpis').markup,/8000/);
 });

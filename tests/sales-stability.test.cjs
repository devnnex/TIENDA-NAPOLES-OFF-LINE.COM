const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),SalesShift=require('../sales-shift.js');
const part=(from,to)=>{const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const fixed=new Date('2026-10-27T17:00:00-05:00');class Clock extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return +fixed;}}
const filters={dateFrom:'2026-10-27',dateTo:'2026-10-27',paymentMethod:'all',saleType:'all',query:'',limit:300};
const invoice={id:'paid',sessionId:'paid',createdAt:'2026-10-27T15:00:00Z',totals:{subtotal:200,total:200},payments:[{method:'cash',amount:200}],items:[{menu_item_id:'p',item_name:'Agua',quantity:2,unit_price:100,unit_cost:40}]};
const sale=(id='paid',date=invoice.createdAt,total=200)=>({saleId:id,invoice:'TN-'+id,date,total,subtotal:total,cost:80,profit:total-80,payments:[{method:'cash',amount:total}],items:[{menuItemId:'p',name:'Agua',quantity:2,total,cost:80}]});
const report=(records=[sale()],range=filters)=>({ok:true,intervalApplied:true,filters:range,generatedAt:'2026-10-27T22:00:00Z',revision:'same',records,recordRows:records.map((row,i)=>({saleId:row.saleId,row:i+2})),totalRecords:records.length,totals:{income:records.reduce((n,row)=>n+row.total,0),sales:records.length,profit:records.reduce((n,row)=>n+row.profit,0),cost:records.reduce((n,row)=>n+row.cost,0)}});
function harness(initialCache=null){
 const state={page:'admin',currentUser:{id:'staff'},invoiceHistory:[],inventoryMeta:{},incomeRequestId:0,incomeVisibleCount:60,activeAdminSection:'income',syncFresh:{}},jobs=[],responses=[],calls=[],renders=[];let cached=initialCache,current={...filters};
 const nodes=new Map();for(const id of ['#income','#incomeKpis','#incomePaymentBreakdown','#incomeRecords','#incomeFilterSummary','#moreIncomeRecords'])nodes.set(id,{markup:'',writes:0,querySelectorAll:()=>[],set innerHTML(value){this.markup=value;this.writes++;},get innerHTML(){return this.markup;}});
 const context=vm.createContext({state,SalesShift,Date:Clock,Map,Set,Number,Object,JSON,clearTimeout,navigator:{onLine:true},window:{setTimeout:()=>1},
  normalizeText:value=>String(value||'').toLowerCase(),incomeRecordSaleType:()=> 'table',incomeFiltersFromForm:()=>({...current}),$:id=>nodes.get(id),canAccessAdminSection:()=>true,
  readAppsScriptOutbox:()=>jobs,INCOME_REPORT_CACHE_KEY:'cache',readLocalJson:()=>cached,mergeConfirmedIncomeReport:value=>value,
  isAppsScriptConfigured:()=>true,APPS_SCRIPT_TIMEOUT_MS:1000,toast(){},updateGlobalSyncStatus(){},renderSalesShift(){},setIncomeReportStatus(){},isBoss:()=>false,incomePaymentLabel:String,incomeSaleTypeLabel:String,formatIncomeDate:String,
  escapeHTML:String,icon:()=>'',money:String,emptyState:(a,b)=>a+' '+b,refreshIcons(){},
  readAppsScriptStatus:async()=>{calls.push('status');return {ok:true,historyRevision:'same'};},
  persistDurableJson:async(_key,value)=>{cached=structuredClone(value);return true;},
  appsScriptRequest:async(action)=>{calls.push(action);const next=responses.shift();if(next instanceof Error)throw next;if(!next)throw Error('Unexpected network read');return typeof next==='function'?next():structuredClone(next);}});
 vm.runInContext(part('incomeTotalsFromRecords','setIncomeReportStatus')+part('renderIncomeReport','refreshBackgroundReports')+';globalThis.api={load:loadIncomeReport,merge:mergeIncomeReport,render:renderIncomeReport};',context);
 return {state,jobs,responses,calls,nodes,context,api:context.api,setFilters:value=>{current={...value};},clearCache:()=>{cached=null;},cache:()=>cached};
}
test('Hoy cuenta el día completo de Bogotá aunque el turno empiece más tarde; el turno explícito mantiene sus horas',()=>{
 const state={salesShift:{id:'shift',date:'2026-10-27',startMinutes:1140,endMinutes:60},salesShiftHistory:[],selectedSalesShiftId:'shift'};state.salesShiftHistory=[state.salesShift];
 const context=vm.createContext({state,SalesShift,Date:Clock});vm.runInContext(part('incomeRangeDates','markIncomeRangePreset')+';globalThis.range=incomeRangeDates;',context);
 const today=context.range('today'),shift=context.range('shift');assert.equal(today.startAt,'2026-10-27T05:00:00.000Z');assert.equal(today.endAt,'2026-10-28T05:00:00.000Z');
 assert.equal(SalesShift.matches('2026-10-27T10:00:00-05:00',today),true);assert.equal(SalesShift.matches('2026-10-27T10:00:00-05:00',shift),false);
 assert.equal(context.range('yesterday').dateFrom,'2026-10-26');assert.equal(context.range('7days').dateFrom,'2026-10-21');
});
test('una factura protegida solo en la cola no desaparece del informe online ni se cuenta dos veces fuera de página',()=>{
 const h=harness();h.jobs.push({action:'record_sale',payload:{invoice}});for(const visible of [[sale()],[]]){const raw=report();raw.records=visible;const merged=h.api.merge(raw,filters);assert.equal(merged.totals.income,200);assert.equal(merged.totalRecords,1);assert.equal(merged.records.length,1);}
});
test('un marcador incompleto no retira una factura válida del servidor',()=>{
 const h=harness();h.jobs.push({action:'record_sale',payload:{invoice:{id:'paid'}}});assert.equal(h.api.merge(report(),filters).totals.income,200);
});
test('una consulta fallida conserva los KPI verificados del mismo periodo; una consulta inicial fallida muestra ausencia de confirmación',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.clearCache();h.responses.push(Error('sin respuesta'));await h.api.load({force:true});
 assert.equal(h.state.incomeReport.totals.income,200);assert.match(h.nodes.get('#incomeKpis').markup,/200/);assert.doesNotMatch(h.nodes.get('#incomeKpis').markup,/is-loading/);
 const empty=harness();empty.responses.push(Error('sin respuesta'));await empty.api.load({force:true});assert.match(empty.nodes.get('#incomeKpis').markup,/—/);assert.doesNotMatch(empty.nodes.get('#incomeKpis').markup,/<strong>0<\/strong>/);
});
test('la copia guardada se muestra de inmediato y una revisión igual no reconstruye los KPI',async()=>{
 const h=harness({filters,report:report()});let release;h.context.readAppsScriptStatus=()=>new Promise(resolve=>{release=resolve;});
 const loading=h.api.load();assert.match(h.nodes.get('#incomeKpis').markup,/200/);assert.doesNotMatch(h.nodes.get('#incomeKpis').markup,/is-loading/);const writes=h.nodes.get('#incomeKpis').writes;
 release({ok:true,historyRevision:'same'});await loading;assert.equal(h.nodes.get('#incomeKpis').writes,writes);assert.equal(h.calls.filter(call=>call==='get_income_report').length,0);
});
test('volver a consultar sin cambios conserva los nodos y solo un importe nuevo reconstruye los indicadores',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});const writes=h.nodes.get('#incomeKpis').writes;
 h.responses.push(report());await h.api.load({background:true,force:true});assert.equal(h.nodes.get('#incomeKpis').writes,writes);
 h.responses.push(report([sale('paid',invoice.createdAt,350)]));await h.api.load({background:true,force:true});assert.equal(h.nodes.get('#incomeKpis').writes,writes+1);assert.match(h.nodes.get('#incomeKpis').markup,/350/);
});
test('de una semana completa se obtiene Hoy y Ayer inmediatamente sin mezclar sus facturas',async()=>{
 const week={...filters,dateFrom:'2026-10-21'},rows=[sale('today'),sale('yesterday','2026-10-26T23:00:00-05:00',300),sale('older','2026-10-24T15:00:00Z',400)];
 const h=harness({filters:week,report:report(rows,week)});await h.api.load();assert.equal(h.state.incomeReport.totals.income,200);assert.equal(h.state.incomeReport.totalRecords,1);
 h.setFilters({...filters,dateFrom:'2026-10-26',dateTo:'2026-10-26'});await h.api.load();assert.equal(h.state.incomeReport.totals.income,300);assert.equal(h.state.incomeReport.records[0].saleId,'yesterday');
});
test('un cero confirmado por el servidor se acepta tras un borrado real',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.responses.push(report([]));await h.api.load({force:true});assert.equal(h.state.incomeReport.totals.income,0);assert.match(h.nodes.get('#incomeKpis').markup,/<strong>0<\/strong>/);
});
test('sin internet conserva las cifras y al reconectar actualiza solamente los valores recibidos',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.context.navigator.onLine=false;h.context.readAppsScriptStatus=async()=>({ok:false});await h.api.load();assert.equal(h.state.incomeReport.totals.income,200);
 h.context.navigator.onLine=true;h.responses.push(report([sale('paid',invoice.createdAt,450)]));await h.api.load({force:true});assert.equal(h.state.incomeReport.totals.income,450);
});
if(source.includes('formatConsumptionTimestamp.dateFormatter'))test('formatear mil líneas reutiliza dos formateadores y conserva fecha y hora en Colombia',()=>{
 let allocations=0;const context=vm.createContext({Date,Intl:{DateTimeFormat:function(...args){allocations++;return new Intl.DateTimeFormat(...args);}}});
 vm.runInContext(part('formatConsumptionTimestamp','renderLastConsumptionTime')+';globalThis.format=formatConsumptionTimestamp;',context);
 const expected=context.format('2026-10-27T15:00:00Z');for(let i=0;i<1000;i++)assert.equal(context.format('2026-10-27T15:00:00Z'),expected);assert.equal(allocations,2);assert.match(expected,/27/);
});


test('al pasar medianoche se desplazan Hoy, Ayer, semana, mes y año; el rango personalizado permanece intacto',()=>{
 let time=Date.parse('2026-12-31T23:59:59-05:00');class MutableClock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 for(const preset of ['today','yesterday','7days','month','year','custom']){
  time=Date.parse('2026-12-31T23:59:59-05:00');const state={incomeRangePreset:preset,activeAdminSection:'income'},nodes=new Map();let loads=0;
  for(const id of ['#incomeDateFrom','#incomeDateTo','#incomePaymentMethod','#incomeSaleType','#incomeSearch'])nodes.set(id,{value:id.includes('Date')?'2026-12-25':id.includes('Search')?'':'all'});
  const context=vm.createContext({state,SalesShift,Date:MutableClock,$:id=>nodes.get(id),$$:()=>[],window:{setTimeout:()=>1,clearTimeout(){}},renderSalesShift(){},loadIncomeReport(){loads++;},dateInputValue:()=> '2026-12-25'});
  vm.runInContext(part('incomeRangeDates','incomeSaleTypeLabel')+part('refreshSalesShiftRange','syncSalesShift')+';globalThis.api={set:setIncomeRange,refresh:refreshSalesShiftRange,filters:incomeFiltersFromForm};',context);
  if(preset!=='custom')context.api.set(preset,false);const before=context.api.filters();context.api.refresh();assert.equal(loads,0);
  time=Date.parse('2027-01-01T00:00:00-05:00');context.api.refresh();const after=context.api.filters();
  if(preset==='custom'){assert.equal(loads,0);assert.equal(after.dateFrom,before.dateFrom);}else{assert.equal(loads,1,preset);assert.equal(after.dateTo,preset==='yesterday'?'2026-12-31':'2027-01-01');context.api.refresh();assert.equal(loads,1);}
  if(preset==='today'){assert.equal(SalesShift.matches('2027-01-01T00:00:00-05:00',after),true);assert.equal(SalesShift.matches('2026-12-31T23:59:59-05:00',after),false);}
 }
});

test('una respuesta tardía del periodo anterior no reemplaza el periodo recién seleccionado',async()=>{
 const h=harness();let release;h.responses.push(()=>new Promise(resolve=>{release=resolve;}));const old=h.api.load({force:true});
 const yesterday={...filters,dateFrom:'2026-10-26',dateTo:'2026-10-26'};h.setFilters(yesterday);h.responses.push(report([sale('yesterday','2026-10-26T15:00:00Z',600)],yesterday));await h.api.load({force:true});
 release(report());await old;assert.equal(h.state.incomeReport.totals.income,600);assert.equal(h.state.incomeReport.filters.dateFrom,'2026-10-26');assert.match(h.nodes.get('#incomeKpis').markup,/600/);
});

test('una consulta fallida vuelve a intentar aun con igual revisión y sin un status disponible',async()=>{
 const h=harness();h.state.incomeReport={...report(),localOnly:true,error:'falló la lectura'};h.state.incomeFetchedAt=0;h.state.incomeRevision='same';h.state.backgroundReportCheckedAt=0;
 h.context.canAccessAdminSection=section=>section==='income';h.context.readAppsScriptStatus=async()=>({ok:false});
 const end=source.includes('  const loadMoreIncomeRecords =')?'loadMoreIncomeRecords':'resetSectionData';
 vm.runInContext(part('refreshBackgroundReports',end)+';globalThis.refresh=refreshBackgroundReports;',h.context);
 h.responses.push(report([sale('paid',invoice.createdAt,700)]));assert.equal(await h.context.refresh(),true);assert.equal(h.state.incomeReport.totals.income,700);assert.equal(h.state.incomeReport.localOnly,false);
});

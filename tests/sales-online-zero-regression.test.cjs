const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),SalesShift=require('../sales-shift.js');
const block=(a,b)=>{const start=source.indexOf('  const '+a+' ='),end=source.indexOf('  const '+b+' =',start+1);assert.ok(start>=0&&end>start,a);return source.slice(start,end);};
const filters={dateFrom:'2026-10-27',dateTo:'2026-10-27',saleType:'all',paymentMethod:'all',query:'',limit:300};
const invoice={id:'paid',sessionId:'paid',createdAt:'2026-10-27T15:00:00Z',totals:{subtotal:200,total:200},payments:[{method:'cash',amount:200}],items:[{menu_item_id:'p',item_name:'Agua',quantity:2,unit_price:100,unit_cost:40}]};
const record={saleId:'paid',date:invoice.createdAt,total:200,subtotal:200,cost:80,profit:120,payments:invoice.payments,items:[{menuItemId:'p',name:'Agua',quantity:2,total:200,cost:80}]};
const report=()=>({ok:true,filters,generatedAt:'2026-10-27T15:05:00Z',revision:'same',records:[structuredClone(record)],recordRows:[{saleId:'paid',row:2}],totalRecords:1,totals:{income:200,subtotal:200,sales:1,cost:80,profit:120,cash:200}});
function harness(){
 const state={invoiceHistory:[],inventoryMeta:{},incomeRequestId:0,incomeLoading:false,incomeAwaitingRemote:false,activeAdminSection:'income',syncFresh:{}},jobs=[],responses=[],renders=[];
 let cached=null,currentFilters={...filters};
 const context=vm.createContext({state,SalesShift,Date,Map,Set,Number,Object,JSON,clearTimeout,navigator:{onLine:true},window:{setTimeout:()=>1},
  normalizeText:s=>String(s||'').toLowerCase(),incomeRecordSaleType:()=> 'table',incomeFiltersFromForm:()=>({...currentFilters}),
  $:()=>({}),canAccessAdminSection:()=>true,readAppsScriptOutbox:()=>jobs,INCOME_REPORT_CACHE_KEY:'cache',readLocalJson:()=>cached,
  mergeConfirmedIncomeReport:report=>report,renderIncomeReport:()=>renders.push(structuredClone(state.incomeReport)),setIncomeReportStatus(){},toast(){},updateGlobalSyncStatus(){},
  isAppsScriptConfigured:()=>true,APPS_SCRIPT_TIMEOUT_MS:1000,readAppsScriptStatus:async()=>({ok:true,historyRevision:'same'}),
  persistDurableJson:async(_key,value)=>{cached=structuredClone(value);return true;},
  appsScriptRequest:async()=>{const next=responses.shift();if(next instanceof Error)throw next;if(!next)throw Error('unexpected read');return structuredClone(next);}});
 vm.runInContext(block('completeIncomeSaleTypeReport','incomeSaleTypeFiltersKey')+block('incomeTotalsFromRecords','setIncomeReportStatus')+block('loadIncomeReport','refreshBackgroundReports')+';globalThis.api={load:loadIncomeReport,merge:mergeIncomeReport};',context);
 return {state,jobs,responses,renders,context,api:context.api,clearCache(){cached=null;},filters:value=>{currentFilters={...value};}};
}
test('con internet, un respaldo pendiente conserva el KPI aunque su factura solo esté en la cola durable',async()=>{
 const h=harness();h.responses.push(report());assert.equal(await h.api.load({force:true}),true);assert.equal(h.state.incomeReport.totals.income,200);
 h.jobs.push({id:'job',action:'record_sale',payload:{invoice:structuredClone(invoice)}});
 h.responses.push(report());assert.equal(await h.api.load({background:true,force:true}),true);
 assert.equal(h.context.navigator.onLine,true);assert.equal(h.state.incomeReport.totals.income,200);assert.equal(h.state.incomeReport.records.length,1);
 for(let i=0;i<3;i++){h.responses.push(report());await h.api.load({force:true});assert.equal(h.state.incomeReport.totals.income,200);}
 h.jobs.length=0;h.responses.push(report());await h.api.load({force:true});assert.equal(h.state.incomeReport.totals.income,200);
});
test('un marcador pendiente sin factura completa no borra la venta que devolvió el servidor',()=>{
 const h=harness();h.jobs.push({id:'marker',action:'record_sale',payload:{invoice:{id:'paid'}}});
 const merged=h.api.merge(report(),filters);assert.equal(merged.totals.income,200);assert.equal(merged.records.length,1);
});
test('borrar una venta con su alta todavía en cola conserva el cero y no repone la factura desde el respaldo pendiente',()=>{
 const h=harness();h.jobs.push({id:'create',action:'record_sale',payload:{invoice:structuredClone(invoice)}},{id:'delete',action:'delete_sale',payload:{saleId:'paid'}});
 const merged=h.api.merge(report(),filters);assert.equal(merged.totals.income,0);assert.equal(merged.records.length,0);
});
test('la edición pendiente sale del filtro por su fecha real aunque la factura no esté en el historial del navegador',()=>{
 const h=harness();h.jobs.push({id:'edit',action:'edit_sale',payload:{invoice:{...structuredClone(invoice),createdAt:'2026-10-26T15:00:00Z'}}});
 const merged=h.api.merge(report(),filters);assert.equal(merged.totals.income,0);assert.equal(merged.records.length,0);
});
test('Actualizar con internet y fallo de una consulta conserva las cifras verificadas del mismo filtro',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.clearCache();
 h.responses.push(Error('Apps Script no respondió, conexión del navegador activa'));
 assert.equal(await h.api.load({force:true}),false);assert.equal(h.context.navigator.onLine,true);
 assert.equal(h.state.incomeReport.totals.income,200);assert.equal(h.state.incomeReport.localOnly,true);
});
test('la falta momentánea de caché al pasar sin conexión conserva el informe del mismo periodo y reconcilia al volver',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.clearCache();
 h.context.readAppsScriptStatus=async()=>({ok:false});h.context.navigator.onLine=false;
 await h.api.load();assert.equal(h.state.incomeReport.totals.income,200);assert.equal(h.state.incomeReport.localOnly,true);
 h.context.navigator.onLine=true;const next=report();next.records[0].total=300;next.totals.income=300;h.responses.push(next);
 await h.api.load({force:true});assert.equal(h.state.incomeReport.totals.income,300);assert.equal(h.state.incomeReport.localOnly,false);
});
test('un cero válido del servidor por borrar ventas se acepta; no se fijan los últimos KPI para siempre',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});
 h.responses.push({ok:true,filters,generatedAt:'2026-10-27T15:10:00Z',revision:'cleared',records:[],recordRows:[],totalRecords:0,totals:{income:0,sales:0}});
 await h.api.load({background:true,force:true});assert.equal(h.state.incomeReport.totals.income,0);assert.equal(h.state.incomeReport.records.length,0);
});
test('cambiar de periodo sin ventas permite mostrar cero y no reutiliza las cifras del periodo anterior',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});h.filters({...filters,dateFrom:'2026-10-26',dateTo:'2026-10-26'});
 h.context.navigator.onLine=false;h.context.readAppsScriptStatus=async()=>({ok:false});await h.api.load();assert.equal(h.state.incomeReport.totals.income,0);
});
test('las ventas pendientes que ya forman parte del total remoto fuera de página no se suman dos veces',()=>{
 const h=harness(),remote=report();remote.records=[];
 h.jobs.push({id:'pending',action:'record_sale',payload:{invoice:structuredClone(invoice)}});
 const merged=h.api.merge(remote,filters);assert.equal(merged.totals.income,200);assert.equal(merged.totals.sales,1);assert.equal(merged.totalRecords,1);assert.equal(merged.records.length,1);
});
for(const cached of [false,true])test('una edición pendiente fuera de página consulta su valor real, incluso si Google ya la aplicó; caché='+cached,async()=>{
 const h=harness(),remote=report(),other={...structuredClone(record),saleId:'other',total:100,subtotal:100};
 remote.records=[other];remote.recordRows=[{saleId:'other',row:2},{saleId:'paid',row:3}];remote.totalRecords=2;remote.totals={income:400,subtotal:400,sales:2,cash:400};
 if(cached){h.responses.push(remote);await h.api.load({force:true});}
 h.jobs.push({id:'edit',action:'edit_sale',payload:{invoice:{...structuredClone(invoice),totals:{subtotal:300,total:300},items:invoice.items.map(line=>({...line,quantity:3})),payments:[{method:'cash',amount:300}]},previousRecord:structuredClone(record)}});
 if(!cached)h.responses.push(remote);
 h.responses.push({ok:true,revision:'same',records:[{...structuredClone(record),total:300,subtotal:300,payments:[{method:'cash',amount:300}]}]});
 assert.equal(await h.api.load({force:!cached}),true);assert.equal(h.state.incomeReport.totals.income,400);assert.equal(h.state.incomeReport.totalRecords,2);assert.equal(h.responses.length,0);
});
test('un error al consultar otro periodo conserva ese filtro y no recupera los importes de ayer',async()=>{
 const h=harness();h.responses.push(report());await h.api.load({force:true});
 h.filters({...filters,dateFrom:'2026-10-26',dateTo:'2026-10-26'});h.responses.push(Error('consulta interrumpida'));
 assert.equal(await h.api.load({background:true,force:true}),false);assert.equal(h.state.incomeReport.totals.income,0);assert.equal(h.state.incomeReport.filters.dateFrom,'2026-10-26');
});

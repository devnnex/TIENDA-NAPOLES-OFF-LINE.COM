const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(from,to)=>{const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const PDF=require('../vendor/jspdf.umd.min.js').jsPDF;
const money=value=>'$ '+Number(value||0).toLocaleString('es-CO');
const filters={dateFrom:'2026-10-01',dateTo:'2026-10-13',paymentMethod:'all',query:'',saleType:'all'};
function harness(overrides={}){
 const documents=[],messages=[],buttons={exportIncomeCsv:{disabled:false},exportPurchasesPdf:{disabled:false}};
 const state={business:{business_name:'Tienda Nápoles'},incomeRequestId:1,invoiceHistory:[],incomeRangePreset:'today',purchaseDateFrom:'2026-10-01',purchaseDateTo:'2026-10-13',purchaseSearch:'',items:[],inventoryMovements:[],movementProductFilter:'product'};
 const context=vm.createContext({state,Date,Map,Set,Object,Number,Intl,JSON,money,navigator:{onLine:true},
  normalizeText:value=>String(value).toLowerCase(),purchaseDateKey:value=>new Date(value).toISOString().slice(0,10),
  incomeFiltersFromForm:()=>({...filters}),localIncomeReport:()=>({records:[],totals:{sales:0,income:0}}),
  incomeSaleTypeLabel:()=> 'Todas',incomePaymentLabel:method=>({cash:'Efectivo',transfer:'Transferencia',breb:'Bre-B'})[method]||method,
  prettyDateTime:value=>new Date(value).toISOString(),purchaseUnitCost:row=>Number(row.unitCost||0),
  APPS_SCRIPT_TIMEOUT_MS:1000,ensureCompleteMovementHistory:async()=>true,mergeIncomeReport:report=>report,
  toast:message=>messages.push(message),$:selector=>buttons[selector.slice(1)]||null,
  window:{jspdf:{jsPDF:function(options){const doc=new PDF(options);doc.save=name=>documents.push({name,doc,text:doc.output()});return doc;}}},
  ...overrides});
 vm.runInContext(block('incomeTotalsFromRecords','localIncomeRecords')
  +block('completeIncomeSaleTypeReport','incomeSaleTypeFiltersKey')
  +block('reportNumber','filteredMovementRows')
  +block('buildBusinessReportPdf','renderConsumptionProductOptions')
  +block('exportIncomeCsv','renderGeneratedTableQrs')
  +';globalThis.api={exportIncomeCsv,exportPurchasesPdf,buildBusinessReportPdf};',context);
 return {state,context,documents,messages,buttons,api:context.api};
}
const sale=id=>({saleId:String(id),invoice:'TN-'+id,date:'2026-10-13T17:00:00Z',table:'Mesa 1',payer:'Ana',subtotal:200,total:200,cost:80,profit:120,payments:[{method:'cash',amount:200}],items:[{menuItemId:'product',name:'Agua',quantity:2,total:200}]});

test('el PDF de ventas recorre todas las páginas, conserva el rango y totaliza 650 ventas',async()=>{
 const records=Array.from({length:650},(_,i)=>sale(i+1)),calls=[];
 const h=harness({appsScriptRequest:async(action,payload)=>{calls.push(payload.filters);if(payload.filters.pageRows)return {ok:true,records:payload.filters.pageRows.map(row=>records[Number(row.saleId)-1])};return {ok:true,revision:'stable',totalRecords:records.length,records:records.slice(0,300),recordRows:records.map((record,i)=>({saleId:record.saleId,row:i+2}))};}});
 await h.api.exportIncomeCsv();
 assert.equal(h.documents.length,1,h.messages.join(';'));assert.ok(h.documents[0].name.endsWith('.pdf'));assert.ok(h.documents[0].text.startsWith('%PDF-'));
 assert.equal(calls.length,3);assert.ok(calls.every(filter=>filter.dateFrom===filters.dateFrom&&filter.dateTo===filters.dateTo));
 assert.ok(h.documents[0].text.includes('TN-650'));assert.ok(h.documents[0].text.includes('130.000'));assert.ok(h.documents[0].doc.getNumberOfPages()>1);
 assert.equal(h.buttons.exportIncomeCsv.disabled,false);
});
test('si cambia la revisión durante una exportación no descarga un PDF incompleto',async()=>{
 const records=[sale(1),sale(2)];
 const h=harness({appsScriptRequest:async(action,{filters})=>filters.pageRows?{ok:true,stale:true,records:[]}:{ok:true,revision:'old',totalRecords:2,records:[records[0]],recordRows:[{row:2,saleId:'1'},{row:3,saleId:'2'}]}});
 await h.api.exportIncomeCsv();assert.equal(h.documents.length,0);assert.ok(h.messages.length);assert.equal(h.buttons.exportIncomeCsv.disabled,false);
});
test('el PDF de compras usa los registros filtrados y el costo por unidad para su resumen y detalle',async()=>{
 const rows=[{productId:'p',product:'Agua',date:'2026-10-13T17:00:00Z',delta:3,unitCost:120,user:'Ana',reference:'Entrada'},{productId:'p',product:'Agua',date:'2026-10-13T18:00:00Z',delta:2,unitCost:150,user:'Ana'}];
 const h=harness({purchaseMovements:()=>rows});await h.api.exportPurchasesPdf();
 assert.equal(h.documents.length,1);assert.ok(h.documents[0].name.startsWith('compras-'));assert.ok(h.documents[0].text.includes('660'));
 assert.ok(h.documents[0].text.includes('Resumen por producto'));assert.ok(h.documents[0].text.includes('Detalle de compras'));
});
test('un PDF sin conexión indica que contiene una copia parcial de los registros',async()=>{
 const h=harness();h.context.navigator.onLine=false;h.state.incomeReport={filters,records:[sale(1)],totalRecords:5};await h.api.exportIncomeCsv();
 assert.equal(h.documents.length,1);assert.ok(h.documents[0].text.includes('Reporte parcial'));assert.ok(h.documents[0].text.includes('1 de 5'));
});

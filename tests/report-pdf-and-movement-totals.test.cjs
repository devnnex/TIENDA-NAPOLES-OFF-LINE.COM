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

test('Compras descarga la selección visible aunque la consulta remota no tenga permiso o conexión',async()=>{
 let reads=0;const rows=[{productId:'p',product:'Arroz',date:'2026-10-13T17:00:00Z',delta:2,unitCost:1500,user:'Ana'}];
 const h=harness({purchaseMovements:()=>rows,ensureCompleteMovementHistory:async()=>{reads++;throw Error('No tienes acceso a Movimientos');}});
 await h.api.exportPurchasesPdf();assert.equal(reads,0);assert.equal(h.documents.length,1);assert.equal(h.messages.length,0);
 assert.ok(h.documents[0].text.includes('3.000'));assert.ok(h.documents[0].text.includes('Alcance:'));
 assert.ok(h.documents[0].doc.internal.pageSize.getWidth()>h.documents[0].doc.internal.pageSize.getHeight());
});

test('Compras aplica producto, fechas, búsqueda y exclusiones iguales a la pantalla',async()=>{
 const h=harness({normalizeText:value=>String(value).toLowerCase(),businessDateKey:value=>new Date(value).toISOString().slice(0,10),isPurchaseMovement:row=>row.type==='ENTRADA',
  purchaseHistoryCutoff:()=>NaN,hiddenPurchaseMovementIds:()=>new Set(['hidden'])});
 Object.assign(h.state,{purchaseProductFilter:'p',purchaseSearch:'proveedor',inventoryMovements:[
  {movementId:'ok',type:'ENTRADA',productId:'p',product:'Arroz',date:'2026-10-12T17:00:00Z',delta:4,unitCost:1500,reference:'Proveedor A'},
  {movementId:'hidden',type:'ENTRADA',productId:'p',product:'Oculto',date:'2026-10-12T17:00:00Z',delta:4,unitCost:1500,reference:'Proveedor'},
  {movementId:'date',type:'ENTRADA',productId:'p',product:'Anterior',date:'2026-09-12T17:00:00Z',delta:4,unitCost:1500,reference:'Proveedor'},
  {movementId:'other',type:'ENTRADA',productId:'other',product:'Otro producto',date:'2026-10-12T17:00:00Z',delta:4,unitCost:1500,reference:'Proveedor'},
  {movementId:'query',type:'ENTRADA',productId:'p',product:'Sin coincidencia',date:'2026-10-12T17:00:00Z',delta:4,unitCost:1500,reference:'Compra'},
  {movementId:'exit',type:'SALIDA',productId:'p',product:'Venta',date:'2026-10-12T17:00:00Z',delta:4,unitCost:1500,reference:'Proveedor'}]});
 vm.runInContext(block('purchaseMovements','renderPurchaseProductOptions'),h.context);
 await h.api.exportPurchasesPdf();assert.equal(h.documents.length,1,h.messages.join(';'));
 const pdf=h.documents[0].text;assert.ok(pdf.includes('6.000'));assert.ok(pdf.includes('Proveedor A'));
 for(const omitted of ['Oculto','Anterior','Otro producto','Sin coincidencia'])assert.equal(pdf.includes(omitted),false);
});

test('Compras pagina referencias extensas y conserva los registros, cantidades e importes',async()=>{
 const rows=Array.from({length:185},(_,i)=>({productId:'p'+i,product:'Producto '+i,date:'2026-10-13T17:00:00Z',delta:1.25,unitCost:12345,user:'Ana',reference:'Referencia '+i+' '+('Detalle largo '.repeat(i===1?300:4))}));
 const h=harness({purchaseMovements:()=>rows});h.state.movementHasMore=true;h.context.navigator.onLine=false;
 await h.api.exportPurchasesPdf();assert.equal(h.documents.length,1,h.messages.join(';'));const pdf=h.documents[0];
 assert.ok(pdf.doc.getNumberOfPages()>5);assert.ok(pdf.text.includes('Producto 184'));
 assert.ok(pdf.text.includes(money(185*1.25*12345)));assert.ok(pdf.text.includes('sin cargar'));assert.ok(pdf.text.includes('Sin conexi'));
 assert.ok(pdf.text.trimEnd().endsWith('%%EOF'));assert.equal(h.buttons.exportPurchasesPdf.disabled,false);
});

test('Compras informa registros vacíos, fechas inválidas y fallos de generación, liberando el botón',async()=>{
 const h=harness({purchaseMovements:()=>[]});await h.api.exportPurchasesPdf();assert.equal(h.documents.length,0);assert.match(h.messages[0],/No hay compras/);
 h.state.purchaseDateFrom='2026-11-01';await h.api.exportPurchasesPdf();assert.equal(h.documents.length,0);assert.match(h.messages[1],/fecha inicial/);
 const failed=harness({purchaseMovements:()=>[{product:'Agua',delta:1,unitCost:2}],window:{}});await failed.api.exportPurchasesPdf();
 assert.equal(failed.documents.length,0);assert.match(failed.messages[0],/generador PDF/);assert.equal(failed.buttons.exportPurchasesPdf.disabled,false);
});
test('un PDF sin conexión indica que contiene una copia parcial de los registros',async()=>{
 const h=harness();h.context.navigator.onLine=false;h.state.incomeReport={filters,records:[sale(1)],totalRecords:5};await h.api.exportIncomeCsv();
 assert.equal(h.documents.length,1);assert.ok(h.documents[0].text.includes('Reporte parcial'));assert.ok(h.documents[0].text.includes('1 de 5'));
});

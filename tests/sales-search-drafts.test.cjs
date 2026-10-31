const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function block(name) {
  const start = source.indexOf('  const ' + name + ' =');
  assert.ok(start >= 0, name);
  const next = source.indexOf('\n  const ', start + 1);
  return source.slice(start, next);
}
const normalizeText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function summaryHarness() {
  const context = vm.createContext({state:{items:[{id:'p',name:'Agua'},{id:'q',name:'Agua con gas'}]},normalizeText});
  vm.runInContext(block('incomeProductSummary')+';globalThis.summary=incomeProductSummary;',context);
  return context;
}
const line = (name, quantity, unitPrice=100) => ({name,quantity,unitPrice,total:quantity*unitPrice,cost:quantity*10});
test('la búsqueda exacta suma solo el producto, admite fracciones y no modifica facturas mixtas',()=>{
  const h=summaryHarness();
  const report={records:[{total:99999,items:[line('Água',2),line('Agua con gas',20),line('Agua',.5,120)]}],totalRecords:1};
  const before=JSON.stringify(report), result=h.summary(report,'agua');
  assert.equal(result.quantity,2.5);assert.equal(result.income,260);assert.equal(result.cost,25);assert.equal(result.profit,235);
  assert.equal(result.records[0].items.length,2);assert.equal(result.records[0].total,260);
  assert.equal(JSON.stringify(report),before);
  assert.equal(h.summary(report,'Mesa 5'),null);
  assert.equal(h.summary({...report,records:[]},'Agua').income,0);
});
test('la búsqueda parcial suma las líneas coincidentes y no una factura que solo coincide por responsable',()=>{
  const h=summaryHarness(),report={totalRecords:2,records:[{total:5000,items:[line('Agua',2),line('Agua con gas',3),line('Café',8)]},{payer:'Agua',items:[line('Café',50)]}]};
  const result=h.summary(report,'agu');
  assert.equal(result.quantity,5);assert.equal(result.income,500);assert.equal(result.sales,1);assert.equal(result.records.length,1);
});
test('650 ventas se completan antes de afirmar el total; una página ausente o revisión distinta se rechaza',async()=>{
  const rows=Array.from({length:650},(_,i)=>({saleId:String(i),row:i+2}));
  const records=rows.map(row=>({...row,date:'2026-10-31',items:[line('Agua',2),line('Café',10)]}));
  const context=summaryHarness();Object.assign(context,{state:{items:[],incomeRequestId:1},APPS_SCRIPT_TIMEOUT_MS:1000,
    appsScriptRequest:async(_action,{filters})=>({ok:true,revision:'r1',records:filters.pageRows.map(row=>records[Number(row.saleId)])})});
  vm.runInContext(block('completeIncomeSaleTypeReport')+';globalThis.complete=completeIncomeSaleTypeReport;',context);
  const first={records:records.slice(0,300),recordRows:rows,totalRecords:650,revision:'r1'};
  assert.equal(context.summary(first,'Agua').complete,false);
  const complete=await context.complete(first,{complete:true,query:'Agua'},1);
  assert.equal(context.summary(complete,'Agua').quantity,1300);assert.equal(context.summary(complete,'Agua').income,130000);
  assert.equal(context.summary(complete,'Agua').complete,true);
  context.appsScriptRequest=async()=>({ok:true,revision:'r1',records:[]});
  await assert.rejects(context.complete(first,{complete:true},1),/confirmar todas/);
  context.appsScriptRequest=async()=>({ok:true,revision:'changed',records:[]});
  await assert.rejects(context.complete(first,{complete:true},1),/historial cambio/);
});
test('el borrador guarda selección, edición y entrada incompleta; cerrar no cobra ni borra productos',()=>{
  const session={id:'local',local_only:true,sale_channel:'walk_in',session_items:[],status:'open'};
  const state={sessions:[session],consumptionDrafts:[{menuItemId:'p',itemName:'Agua',quantity:2,unitPrice:100}],consumptionDraftEditIndex:0};
  const form={dataset:{},quick_checkout:{value:'1'},session_id:{value:'local'},session_item_id:{value:''}};
  for(const [name,value] of Object.entries({menu_item_id:'p',item_name:'Agua',quantity:'',unit_price:'$100',notes:'Pendiente',payer_name:'Cliente'}))form[name]={value};
  const dialog={open:true,close(){this.open=false;}};let saved=0,discarded=0;
  const context=vm.createContext({state,$:selector=>({'#consumptionDialog':dialog,'#consumptionForm':form,'#consumptionProductSearch':{value:'Agua'}}[selector]),
    isLocalWalkInSession:value=>value?.local_only===true,persistWalkInDrafts(){saved++;},renderConsumptionSelection(){},discardLocalWalkInSession(){discarded++;}});
  vm.runInContext(block('saveWalkInConsumptionDraft')+block('cancelConsumption')+';globalThis.save=saveWalkInConsumptionDraft;globalThis.cancel=cancelConsumption;',context);
  context.save();assert.equal(saved,1);assert.equal(session.consumption_draft.drafts.length,1);assert.equal(session.consumption_draft.fields.quantity,'');
  context.cancel();assert.equal(dialog.open,false);assert.equal(discarded,0);assert.equal(session.consumption_draft.drafts[0].quantity,2);
  assert.equal(session.session_items.length,0);assert.equal(session.status,'open');
});
test('cerrar el cobro conserva la venta individual con productos y elimina solo una vacía',()=>{
  for(const hasItems of [true,false]){
    const session={id:'local',local_only:true,session_items:hasItems?[{status:'served'}]:[]};let saved=0,discarded=0;
    const context=vm.createContext({state:{sessions:[session]},$:selector=>selector==='#paymentForm'?{session_id:{value:'local'}}:{close(){}},
      isLocalWalkInSession:()=>true,persistWalkInDrafts(){saved++;},discardLocalWalkInSession(){discarded++;},toast(){}});
    vm.runInContext(block('cancelPayment')+';cancelPayment();',context);
    assert.equal(saved,Number(hasItems));assert.equal(discarded,Number(!hasItems));
  }
});

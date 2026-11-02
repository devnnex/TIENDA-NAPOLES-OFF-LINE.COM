const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function block(name){const a=source.indexOf('  const '+name+' ='),b=source.indexOf('\n  const ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
function harness(){
 const session={id:'sale',status:'open',sale_channel:'walk_in',local_only:true,session_items:[{id:'a',item_name:'Agua',quantity:2,unit_price:100,status:'served'},{id:'b',item_name:'Café',quantity:3,unit_price:900,status:'served'}]};
 const state={sessions:[session],optimisticSessionStates:new Map()};const form={session_id:{value:'sale'},dataset:{hasItems:'1'}};
 const badge={hidden:true,textContent:''},button={querySelector:()=>badge,setAttribute(_name,value){this.label=value;}};
 const nodes={'#paymentForm':form,'#newWalkInSale':button,'#paymentAddItem':{innerHTML:''}};let persisted=0,renders=0,totals=0;
 const context=vm.createContext({state,$:selector=>nodes[selector],isLocalWalkInSession:s=>s?.local_only===true,Date,
  sessionTotal:s=>(s.session_items||[]).filter(row=>row.status!=='cancelled').reduce((sum,row)=>sum+row.quantity*row.unit_price,0),
  sessionPaid:()=>0,icon:()=>'',renderPaymentSaleLines:()=>renders++,updatePaymentTipChoice:()=>totals++,refreshIcons(){},
  renderServiceWalkInSales(){},persistWalkInDrafts:()=>{persisted++;context.badge();}});
 vm.runInContext(block('consumptionChangeAllowed')+block('clearPaymentsWithoutConsumption')+block('pendingWalkInSaleCount')+block('renderWalkInDraftBadge')+block('removeWalkInSaleItem')+';globalThis.remove=removeWalkInSaleItem;globalThis.badge=renderWalkInDraftBadge;globalThis.count=pendingWalkInSaleCount;',context);
 return {context,state,form,badge,button,stats:()=>({persisted,renders,totals})};
}
test('la X retira solo el producto elegido, recalcula el saldo y guarda el borrador sin cobrar ni modificar inventario',()=>{
 const h=harness();h.context.remove('a');
 assert.equal(h.state.sessions[0].session_items[0].status,'cancelled');assert.equal(h.state.sessions[0].session_items[1].status,'served');
 assert.equal(h.state.activePaymentBase,2700);assert.equal(h.form.dataset.hasItems,'1');assert.equal(h.badge.textContent,'1');assert.equal(h.badge.hidden,false);
 assert.deepEqual(h.stats(),{persisted:1,renders:1,totals:1});
 h.context.remove('b');assert.equal(h.form.dataset.hasItems,'0');assert.equal(h.state.activePaymentBase,0);assert.equal(h.badge.hidden,true);
 assert.equal(h.state.sessions[0].status,'open');assert.equal(h.state.optimisticSessionStates.get('sale').localOnly,true);
});
test('no permite retirar durante el cobro, en una mesa, en una venta cerrada ni con un identificador inválido',()=>{
 for(const condition of ['busy','table','closed','missing']){
  const h=harness();if(condition==='busy')h.state.paymentProcessing=true;
  if(condition==='table')h.state.sessions[0].local_only=false;
  if(condition==='closed')h.state.sessions[0].status='closed';
  h.context.remove(condition==='missing'?'unknown':'a');assert.equal(h.stats().persisted,0);assert.equal(h.state.sessions[0].session_items[0].status,'served');
 }
});
test('la burbuja cuenta ventas pendientes: incluye selección o entrada sin terminar y excluye ventas vacías o cerradas',()=>{
 const h=harness();h.state.sessions=[
  {status:'open',local_only:true,consumption_draft:{drafts:[{itemName:'Agua'}]}},
  {status:'open',local_only:true,consumption_draft:{drafts:[],fields:{menu_item_id:'p'}}},
  {status:'open',local_only:true,session_items:[]},
  {status:'closed',local_only:true,session_items:[{status:'served'}]},
  {status:'open',local_only:false,session_items:[{status:'served'}]}];
 h.context.badge();assert.equal(h.badge.textContent,'2');assert.equal(h.badge.hidden,false);assert.match(h.button.label,/2 ventas pendientes/);
 h.state.sessions=[];h.context.badge();assert.equal(h.badge.hidden,true);
});

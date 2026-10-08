const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section = (start,end) => {
  const from=source.indexOf('  const '+start+' ='), to=source.indexOf('  const '+end+' =',from+1);
  assert.ok(from>=0 && to>from); return source.slice(from,to);
};
let currentTime=1000, modal=false, input=false, calls=0;
const handlers = {};
const fakeDate=class extends Date { static now(){return currentTime;} };
const sessions=[8,9,10].map(number=>({id:'s'+number,table_id:'t'+number,restaurant_tables:{table_number:number,table_name:'Mesa '+number},
  session_items:[{id:'i'+number,item_name:'Producto',quantity:3,unit_price:10000,status:'served'}]}));
const state={sessions,tables:sessions.map(row=>({id:row.table_id,...row.restaurant_tables})),activePaymentBase:30000,
  tipSettings:{enabled:true,percentage:10},business:{business_name:'Tienda Nápoles'}, currentUser:{full_name:'Equipo'}};
const form={session_id:{value:'s8'},tip_choice:{value:'with'},tip_amount:{value:'0'}, cash_received:{value:'0'},
  mixed_amount_one:{value:'0'},mixed_amount_two:{value:'0'},dataset:{hasItems:'1'}};
const nodes=new Map([['#paymentForm',form],['#paymentTotal',{textContent:''}],['#paymentAbonoSummary',{textContent:''}]]);
const context=vm.createContext({state, Date:fakeDate, Set,Map,console,
  integerMoney:value=>Math.max(0,Math.round(Number(value||0))),
  money:value=>'$'+Number(value),escapeHTML:value=>String(value||''),
  normalizeText:value=>String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''),
  sessionLabel:session=>session.restaurant_tables?.table_name || 'Venta individual',
  sessionReference:session=>session.id,paymentMethodLabel:method=>method,
  currencyInputNumber:field=>Number(field?.value||0),setCurrencyInputValue:(field,value)=>{field.value=value;},
  tipsEnabled:()=>state.tipSettings.enabled,tipAmountFor:base=>Math.round(base*state.tipSettings.percentage/100),
  $:selector=>nodes.get(selector),$$:()=>[],updateMixedPayment:()=>{},updateCashChange:()=>{},
  window:{},openCashDrawer:()=>{calls++;},
  document:{querySelector:()=>modal?{}:null,activeElement:{closest:()=>input?{}:null},addEventListener:(name,fn)=>{handlers[name]=fn;}}
});
vm.runInContext(section('sessionTotals','newestSessionItems')
  +section('compareAccountNumbers','renderAccounts')
  +section('updatePaymentTipChoice','openPaymentDialog')
  +section('thermalReceiptHtml','printThermalReceipt')
  +';globalThis.api={sessionPaid,sessionBalance,aggregateAccountPayments,matchesAccountSearch,compareAccountNumbers,updatePaymentTipChoice,thermalReceiptHtml,bindAccountFeatures};',context);
const api=context.api;
const payment={id:'payment-a',amount:10000,payment_method:'cash',created_at:'2026-10-07T17:30:00Z'};
sessions[0].session_payments=[payment,payment];
assert.equal(api.sessionPaid(sessions[0]),10000);
assert.equal(api.sessionBalance(sessions[0]),20000);
assert.equal(api.aggregateAccountPayments(sessions[0],[{method:'cash',amount:20000}])[0].amount,30000);
api.updatePaymentTipChoice();
assert.equal(state.activePaymentTotal,23000,'Propina sobre consumo completo; se cobra solo el saldo restante.');
assert.equal(form.cash_received.value,23000);
assert.match(nodes.get('#paymentAbonoSummary').textContent,/10000/);
assert.ok(api.matchesAccountSearch(sessions[0],'MESA 8'));
assert.ok(api.matchesAccountSearch(sessions[0],'8'));
assert.equal(api.matchesAccountSearch(sessions[1],'8'),false);
assert.deepEqual([sessions[2],sessions[0],sessions[1]].sort(api.compareAccountNumbers).map(row=>row.id),['s8','s9','s10']);
const invoice={number:'TN-8',totals:{subtotal:30000,total:33000},tipAmount:3000,baseTotal:30000,
  prepayments:[payment],remainingPaid:23000,payments:[{method:'cash',amount:33000}],items:sessions[0].session_items,
  paymentMethod:'mixed',cashReceived:25000,changeDue:2000};
const receipt=api.thermalReceiptHtml(sessions[0],invoice);
assert.match(receipt,/Devnex Soluciones Tecnologicas - Devnex\.tech/);
assert.match(receipt,/aria-label="Instagram"/);assert.match(receipt,/aria-label="WhatsApp"/);
assert.match(receipt,/3246394689/);assert.match(receipt,/font: 800 12px/);
assert.match(receipt,/ABONOS REGISTRADOS/);assert.match(receipt,/Saldo cobrado al cierre/);
assert.match(receipt,/Recibido/);assert.match(receipt,/Cambio/);
assert.doesNotMatch(receipt,/window\.onload/,'Una sola orden de impresión después de preparar el documento.');
api.bindAccountFeatures();
const key=(code='Numpad0',value='0')=>handlers.keydown({code,key:value,repeat:false,preventDefault(){},target:{closest:()=>input?{}:null}});
key();currentTime+=100;key();assert.equal(calls,1);
modal=true;key();key();assert.equal(calls,1);modal=false;
input=true;key();key();assert.equal(calls,1);input=false;
key('Digit0');key('Digit0');assert.equal(calls,1);
key();currentTime+=600;key();assert.equal(calls,1);
handlers.focusin();key();currentTime+=100;key();assert.equal(calls,2);
console.log('PASS saldo y propina, abonos únicos, búsqueda y orden, factura negra con pie y atajo 00 protegido');

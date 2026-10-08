const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section=(start,end)=>{const from=source.indexOf('  const '+start+' ='),to=source.indexOf('  const '+end+' =',from+1);assert.ok(from>=0&&to>from);return source.slice(from,to);};
const account={id:'account-a',table_id:'table-a',session_items:[{id:'item-a',item_name:'Producto',quantity:3,unit_price:10000,status:'served'}],
 session_payments:[{id:'payment-a',amount:10000,payment_method:'cash',created_at:'2026-10-07T17:00:00Z'}]};
const state={currentTable:{id:'table-a',table_number:8},currentSession:account,sessionItems:account.session_items,localBillOpen:true,business:{business_name:'Napoles'}};
const box={hidden:true,innerHTML:'',classList:{contains:()=>false,remove(){}},querySelector:()=>null};
let billRequest=null;
const context=vm.createContext({state,Date,Map,Set,console,DEFAULT_CURRENCY:'COP',integerMoney:v=>Math.max(0,Math.round(Number(v||0))),
 money:v=>'$'+v,escapeHTML:v=>String(v||''),paymentMethodLabel:m=>m,tableLabel:()=> 'Mesa 8',icon:()=>'',refreshIcons(){},
 $:()=>box,document:{body:{classList:{add(){},remove(){}}}},window:{requestAnimationFrame:()=>{}},
 latestClientBill:()=>billRequest,playReceiptSound:()=>{},billDateParts:()=>({date:'7/10/2026',time:'12:00'}),billTicketId:()=> '#TEST'});
vm.runInContext(section('sessionTotals','openAbonoDialog')+section('receiptItemsForSession','retryQuiet')+section('parseBillMessage','billTicketId')+section('renderBillChat','showCurrentBill')
 +';globalThis.api={buildBillMessage,renderBillChat};',context);
let bill=JSON.parse(context.api.buildBillMessage(account));
assert.equal(bill.total,20000,'Tu cuenta muestra saldo, no consumo completo.');
assert.equal(bill.paid,10000);assert.equal(bill.payments[0].id,'payment-a');
context.api.renderBillChat();assert.match(box.innerHTML,/Abonos/);assert.match(box.innerHTML,/\$20000/);assert.match(box.innerHTML,/account-abono-line/);
billRequest={id:'request-a',session_id:account.id,status:'acknowledged',message:JSON.stringify({...bill,total:30000,paid:0,payments:[]})};
state.localBillOpen=false;context.api.renderBillChat();
assert.match(box.innerHTML,/\$20000/,'La cuenta enviada se actualiza tras abonar, aunque su mensaje anterior muestre el consumo completo.');
assert.match(box.innerHTML,/account-abono-line/);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let responses={},calls=[];
context.tableCode=table=>table.access_code||'qr-valid';
context.dbQuiet=async (query,fallback)=>{try {const result=await query;return result?.error?fallback:result?.data;}catch{return fallback;}};
context.renderClientQueue=()=>{};
context.renderAccount=()=>{};
context.refreshTableLock=()=>{};
context.loadClientSessionItems=async()=>{};
context.loadClientRequests=async()=>{};
state.sb={rpc:(name,args)=>{calls.push({name,args});return responses[name];}};
const readerFrom=source.indexOf('  let clientPosReadPending ='),readerTo=source.indexOf('  const renderClientQueue =',readerFrom);
assert.ok(readerFrom>0&&readerTo>readerFrom);
vm.runInContext(source.slice(readerFrom,readerTo)+section('loadClientSnapshot','pwaAssetUrl')
 +';globalThis.reader={refreshClientPosData,loadClientSnapshot};',context);
(async()=>{
  const ledger=deferred();
  responses={get_service_request_queue:Promise.resolve({data:{requests:[]}}),get_session_payments:ledger.promise};
  const first=context.reader.refreshClientPosData(),second=context.reader.refreshClientPosData();
  assert.equal(first,second,'Dos lecturas simultáneas esperan el mismo resultado de la mesa.');
  assert.equal(calls.filter(c=>c.name==='get_session_payments').length,1);
  ledger.resolve({data:{payments:[...account.session_payments,{id:'payment-b',amount:5000,payment_method:'transfer',created_at:'2026-10-07T18:00:00Z'}]}});
  assert.equal(await second,true);await first;
  assert.match(box.innerHTML,/\$15000/,'El recibo abierto cambia al llegar un segundo abono.');
  assert.equal((box.innerHTML.match(/account-abono-line/g)||[]).length,2);
  responses.get_session_payments=Promise.resolve({error:{message:'Interrupción de red'}});
  assert.equal(await context.reader.refreshClientPosData(),false);
  assert.equal(account.session_payments.length,2,'Una lectura fallida no convierte abonos existentes en cero.');
  const stale=deferred();responses.get_session_payments=stale.promise;
  const oldRead=context.reader.refreshClientPosData();
  state.currentTable={id:'table-b'};state.currentSession={id:'account-b',session_payments:[]};
  responses.get_session_payments=Promise.resolve({data:{payments:[{id:'payment-c',amount:1000}]}});
  await context.reader.refreshClientPosData();
  stale.resolve({data:{payments:[{id:'wrong-table',amount:9999}]}});await oldRead;
  assert.equal(state.currentSession.session_payments[0].id,'payment-c','Una respuesta tardía del QR anterior no se aplica a otra mesa.');
  state.currentTable={id:'table-a',table_number:8};state.currentSession=account;
  const snapshot={sessionItems:account.session_items,requests:[]};
  responses.getClientSnapshot=Promise.resolve({data:snapshot});
  responses.get_session_payments=Promise.resolve({data:{payments:[{id:'payment-a',amount:10000,payment_method:'cash',created_at:'2026-10-07T17:00:00Z'}]}});
  await context.reader.loadClientSnapshot();
  responses.get_session_payments=Promise.resolve({data:{payments:[{id:'payment-a',amount:10000,payment_method:'cash',created_at:'2026-10-07T17:00:00Z'},{id:'payment-d',amount:10000,payment_method:'cash',created_at:'2026-10-07T19:00:00Z'}]}});
  assert.equal(await context.reader.loadClientSnapshot(),false,'Los consumos y solicitudes no cambiaron.');
  assert.match(box.innerHTML,/\$10000/,'El abono actualiza Tu cuenta aunque la firma de consumos no cambie.');
  console.log('PASS QR: abonos y saldo en consulta y recibo enviado; concurrencia, cambios sin nuevos consumos, errores de red y aislamiento entre mesas.');
})().catch(error=>{console.error(error);process.exitCode=1;});

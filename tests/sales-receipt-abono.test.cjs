const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (from, to) => {
  const start=source.indexOf(`  const ${from} =`), end=source.indexOf(`  const ${to} =`,start+1);
  assert.ok(start>=0&&end>start,from);return source.slice(start,end);
};

for (const stored of [false, true]) test(`reimprimir una venta ${stored ? "local" : "del otro equipo"} conserva factura y abonos sin cobrar ni abrir caja`, async () => {
  const calls = [], record = { saleId: "sale", sessionId: "account", invoice: "TN-1", date: "2026-10-13T10:00:00Z", table: "Mesa 1", payer: "Ana", waiter: "Mesero", subtotal: 100, total: 100,
    items: [{ lineId: "line", name: "Producto", quantity: 2, unitPrice: 50 }], payments: [{ method: "cash", amount: 100 }] };
  const abono = { id: "abono", amount: 30, payment_method: "cash" };
  const state = { authToken: "valid", incomeReport: { records: [record] }, invoiceHistory: stored ? [{ id: "sale", sessionId: "account", prepayments: [abono], cashReceived: 100, changeDue: 30 }] : [],
    sb: { rpc: async name => { assert.equal(name,"get_session_payments"); calls.push("ledger"); return { data: { payments: [abono] } }; } } };
  const popup = { document: { open() {}, write() {}, close() {} } };
  const context=vm.createContext({state,window:{open:()=>popup},normalizeText:value=>String(value).toLowerCase(),toast(){},
    dbQuiet:async query=>(await query).data,thermalReceiptHtml:()=>"receipt",printThermalReceipt:(session,invoice,window)=>{calls.push({session,invoice,window});return true;}});
  vm.runInContext(section("printIncomeReceipt","bindPaymentConfirmShortcut")+";globalThis.print=printIncomeReceipt;",context);
  const before=JSON.stringify(state.invoiceHistory);
  assert.equal(await context.print("sale"),true);
  const printed=calls.find(call=>typeof call==="object");
  assert.equal(printed.invoice.number,"TN-1"); assert.equal(printed.invoice.sessionId,"account");
  assert.equal(printed.invoice.prepayments[0].id,"abono");assert.equal(printed.invoice.remainingPaid,70);
  assert.equal(printed.invoice.items[0].unit_price,50);assert.equal(printed.window,popup);
  assert.equal(JSON.stringify(state.invoiceHistory),before);
  assert.equal(calls.includes("ledger"),!stored);
  assert.match(source,/data-print-income=/);
});

for(const method of ["cash","transfer","breb"])for(const duplicate of [false,true])test(`abono ${method}, duplicado=${duplicate}: apertura local una vez solo con efectivo`,async()=>{
  const calls=[],session={id:"account",session_payments:[]},button={disabled:false};
  const state={authToken:"valid",sessions:[session],optimisticSessionStates:new Map(),sb:{rpc:async()=>({data:{payment:{id:"payment",amount:30,payment_method:method},duplicate}})}};
  const form={dataset:{},session_id:{value:"account"},amount:{value:30},payment_method:{value:method},reference:{value:""},querySelector:()=>button};
  const context=vm.createContext({state,Date,uid:()=>"payment",currencyInputNumber:input=>Number(input.value),sessionBalance:()=>100,
    sessionPayments:row=>row.session_payments,OFFLINE_ADMIN_SNAPSHOT_KEY:"snapshot",persistOfflineAdminSnapshot(){},flushDurableWrites:async()=>{calls.push("durable");return true;},
    $:selector=>selector==="#abonoDialog"?{close(){calls.push("close");}}:null,notifyAdminPeers(){},renderAdminLive(){calls.push("render");},renderAccountDetail(){},money:String,toast(){},
    openCashDrawer:options=>{assert.equal(options.localOnly,true);calls.push("drawer");}});
  vm.runInContext(section("recordAbono","refreshClientPosData")+";globalThis.save=recordAbono;",context);
  await context.save(form);
  assert.equal(calls.filter(call=>call==="drawer").length,method==="cash"&&!duplicate?1:0);
  if(calls.includes("drawer")){assert.ok(calls.indexOf("durable")<calls.indexOf("drawer"));assert.ok(calls.indexOf("drawer")<calls.indexOf("render"));}
  assert.equal(session.session_payments.length,1);assert.equal(button.disabled,false);
});

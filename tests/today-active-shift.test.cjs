const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const SalesShift=require('../sales-shift.js'),source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const part=(from,to)=>{const a=source.indexOf('  const '+from+' ='),b=source.indexOf('  const '+to+' =',a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const at=text=>new Date(text+'-05:00');
const old={id:'night',date:'2026-10-27',startMinutes:1080,endMinutes:120};
function harness(current=old,history=[old],time='2026-10-27T23:59:59'){
 let now=+at(time);class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const state={salesShift:current,salesShiftHistory:history,incomeRangePreset:'today',activeAdminSection:'income'},fields=new Map([['#incomeDateFrom',{value:''}],['#incomeDateTo',{value:''}]]);let reads=0,delay=0;
 const context=vm.createContext({state,SalesShift,Date:Clock,$:selector=>fields.get(selector),$$:()=>[],renderSalesShift(){},loadIncomeReport(){reads++;},window:{clearTimeout(){},setTimeout(_callback,value){delay=value;return 1;}}});
 vm.runInContext(part('incomeRangeDates','incomeSaleTypeLabel')+part('refreshSalesShiftRange','syncSalesShift')+';globalThis.api={range:incomeRangeDates,set:setIncomeRange,refresh:refreshSalesShiftRange};',context);
 return {state,context,api:context.api,fields,advance:time=>{now=+at(time);},reads:()=>reads,delay:()=>delay};
}

test('Hoy coincide con el turno vigente antes y después de medianoche, hasta el cierre exclusivo',()=>{
 const h=harness();const before=h.api.range();assert.equal(before.shiftId,'night');assert.equal(before.startAt,'2026-10-27T23:00:00.000Z');assert.equal(before.endAt,'2026-10-28T07:00:00.000Z');
 h.api.set('today',false);h.advance('2026-10-28T00:00:00');h.api.refresh();assert.equal(h.reads(),0,'La medianoche no cambia el informe del turno abierto.');assert.deepEqual(h.api.range(),before);
 h.advance('2026-10-28T01:59:59');assert.deepEqual(h.api.range(),before);assert.equal(SalesShift.matches('2026-10-28T01:59:59-05:00',before),true);assert.equal(SalesShift.matches('2026-10-28T02:00:00-05:00',before),false);
 h.advance('2026-10-28T02:00:00');h.api.refresh();assert.equal(h.reads(),1);assert.equal(h.api.range().shiftId,undefined);assert.equal(h.api.range().startAt,'2026-10-28T07:00:00.000Z');assert.equal(SalesShift.needsNewShift(old,at('2026-10-28T09:00:00')),true);
});

test('un turno del nuevo día que empieza a las 00:00 se selecciona exactamente al terminar el anterior',()=>{
 const previous={...old,endMinutes:0},next={id:'midnight',date:'2026-10-28',startMinutes:0,endMinutes:480};
 const h=harness(next,[previous,next]);assert.equal(h.api.range().shiftId,previous.id);h.api.set('today',false);h.advance('2026-10-28T00:00:00');h.api.refresh();assert.equal(h.api.range().shiftId,next.id);assert.equal(h.reads(),1);assert.equal(h.api.range().startAt,'2026-10-28T05:00:00.000Z');
});

test('registrar el siguiente turno después del cierre actualiza Hoy, sin volver a contar el turno nocturno',()=>{
 const h=harness(old,[old],'2026-10-28T09:00:00');h.api.set('today',false);
 const next={id:'morning',date:'2026-10-28',startMinutes:540,endMinutes:1020};h.state.salesShift=next;h.state.salesShiftHistory.push(next);h.api.refresh();assert.equal(h.api.range().shiftId,'morning');assert.equal(h.reads(),1);assert.equal(SalesShift.needsNewShift(next,at('2026-10-28T09:00:00')),false);
 assert.equal(SalesShift.matches('2026-10-28T01:00:00-05:00',h.api.range()),false);assert.equal(SalesShift.matches('2026-10-28T09:00:00-05:00',h.api.range()),true);
});

test('un turno futuro no vacía Hoy antes de empezar y el temporizador despierta en su hora exacta',()=>{
 const h=harness(old,[old],'2026-10-27T17:00:00');assert.equal(h.api.range().shiftId,undefined);assert.equal(SalesShift.matches('2026-10-27T10:00:00-05:00',h.api.range()),true);h.api.set('today',false);assert.equal(h.delay(),3600025);
 h.advance('2026-10-27T18:00:00');h.api.refresh();assert.equal(h.api.range().shiftId,'night');assert.equal(h.reads(),1);assert.equal(h.delay(),8*3600000+25);
});

test('turnos de fin de año, ausencia de turno y rangos históricos conservan sus límites y selección manual',()=>{
 const year={...old,date:'2026-12-31'};const h=harness(year,[year],'2027-01-01T00:30:00');assert.equal(h.api.range().dateFrom,'2026-12-31');assert.equal(h.api.range().dateTo,'2027-01-01');
 h.state.incomeRangePreset='shift';h.state.selectedSalesShiftId=year.id;h.api.set('shift',false);h.advance('2027-01-02T09:00:00');h.api.refresh();assert.equal(h.reads(),0);assert.equal(h.api.range('shift').shiftId,year.id);
 assert.equal(h.api.range('yesterday').dateFrom,'2027-01-01');assert.equal(h.api.range('7days').dateFrom,'2026-12-27');
 const empty=harness(null,[],'2026-10-28T00:00:00');assert.equal(empty.api.range().startAt,'2026-10-28T05:00:00.000Z');assert.equal(empty.api.range().shiftId,undefined);
});

test('el backend real entrega las mismas facturas y KPI del turno a ambos lados de medianoche y las separa al cerrar',()=>{
 const rows=[['before','2026-10-27T17:59:59-05:00',1000],['start','2026-10-27T18:00:00-05:00',100],['evening','2026-10-27T23:59:59-05:00',200],['midnight','2026-10-28T00:00:00-05:00',300],['last','2026-10-28T01:59:59-05:00',400],['closed','2026-10-28T02:00:00-05:00',500]].map(([id,date,total])=>[id,id,'','','Mesa 1',date,'','',total,0,0,0,total,'cash']);
 const table=list=>({getLastRow:()=>list.length+1,getRange:(row,column,count)=>({getValues:()=>list.slice(row-2,row-2+count)})});const sheets={Ventas:table(rows),Pagos:table([]),Detalle_Ventas:table([])};
 const backend=vm.createContext({Date,console,Utilities:{formatDate:date=>SalesShift.dateKey(date)}});vm.runInContext(fs.readFileSync(path.join(__dirname,'../appscript/Code.gs'),'utf8'),backend);
 backend.getSpreadsheet_=()=>({getSheetByName:name=>sheets[name]});backend.getTimezone_=()=>SalesShift.zone;backend.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'revision'})};
 const h=harness();const before=backend.getIncomeReport_(h.api.range());h.advance('2026-10-28T00:00:00');const after=backend.getIncomeReport_(h.api.range());assert.equal(before.totals.income,1000);assert.equal(after.totals.income,1000);assert.equal(after.totalRecords,4);
 h.advance('2026-10-28T02:00:00');const closed=backend.getIncomeReport_(h.api.range());assert.equal(closed.totals.income,500);assert.equal(closed.totalRecords,1);
});


test('registrar 27 de octubre 2 PM a 28 de octubre 2 AM activa Hoy aunque estuviera seleccionado otro turno',async()=>{
 const previous={...old,date:'2026-10-26'};const h=harness(previous,[previous],'2026-10-27T15:00:00');h.state.selectedSalesShiftId=previous.id;h.state.salesShiftFormSnapshot=previous;h.api.set('shift',false);
 const values={action:'new',date:'2026-10-27',amount:'50000',start_time:'200',start_period:'PM',end_time:'200',end_period:'AM'},button={disabled:false},error={textContent:''};let closed=false;
 h.fields.set('#salesShiftError',error);h.fields.set('#salesShiftDialog',{close(){closed=true;}});Object.assign(h.context,{uid:()=> 'registered',currencyInputNumber:()=>50000,syncSalesShift:async()=>true,persistSalesShift:async(shift,pending,history)=>{Object.assign(h.state,{salesShift:shift,salesShiftPending:pending,salesShiftHistory:history});}});
 vm.runInContext(part('saveSalesShift','bindSalesShift')+';globalThis.save=saveSalesShift;',h.context);
 await h.context.save({elements:{namedItem:name=>({value:values[name]})},querySelector:()=>button});
 assert.equal(error.textContent,'');assert.equal(closed,true);assert.equal(h.state.incomeRangePreset,'today');assert.equal(h.api.range().shiftId,'registered');assert.equal(h.api.range().startAt,'2026-10-27T19:00:00.000Z');assert.equal(h.api.range().endAt,'2026-10-28T07:00:00.000Z');assert.equal(h.reads(),1);
 const sales=[['2026-10-27T13:59:59-05:00',50],['2026-10-27T14:00:00-05:00',100],['2026-10-27T18:00:00-05:00',200],['2026-10-28T00:30:00-05:00',300],['2026-10-28T02:00:00-05:00',400]];
 assert.equal(sales.filter(([date])=>SalesShift.matches(date,h.api.range())).reduce((total,[,amount])=>total+amount,0),600);
 h.advance('2026-10-28T00:30:00');h.api.refresh();assert.equal(h.reads(),1);assert.equal(h.api.range().shiftId,'registered');
});

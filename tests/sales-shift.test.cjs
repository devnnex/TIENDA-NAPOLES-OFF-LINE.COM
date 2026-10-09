const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shift = require('../sales-shift.js');
const at = value => new Date(value + '-05:00');
for (const [input, period, minutes, text] of [['800','AM',480,'8:00'],['8:00','PM',1200,'8:00'],['1000','PM',1320,'10:00'],['12','AM',0,'12:00'],['1200','PM',720,'12:00'],['105','AM',65,'1:05']]) {
  assert.deepEqual(shift.parseTime(input, period), { minutes, text });
}
for (const value of ['', '0','000','1300','8:60','1260','24:00','-100','1.30','8:0']) assert.equal(shift.parseTime(value,'AM'), null, value);
const overnight = { id:'shift-a', date:'2026-10-08', startMinutes:900, endMinutes:60 };
assert.equal(shift.today(overnight,at('2026-10-09T00:30:00')).dateFrom,'2026-10-08');
assert.equal(shift.today(overnight,at('2026-10-09T00:59:59')).dateFrom,'2026-10-08');
const after = shift.today(overnight,at('2026-10-09T01:00:00'));
assert.equal(after.dateFrom,'2026-10-09');
assert.equal(after.startAt,'2026-10-09T06:00:00.000Z');
const during = shift.today(overnight,at('2026-10-08T17:00:00'));
assert.equal(shift.matches('2026-10-08T14:59:59-05:00',during),false);
assert.equal(shift.matches('2026-10-08T15:00:00-05:00',during),true);
assert.equal(shift.matches('2026-10-09T00:59:59-05:00',during),true);
assert.equal(shift.matches('2026-10-09T01:00:00-05:00',during),false);
assert.equal(shift.matches('2026-10-09T00:30:00-05:00',after),false);
assert.equal(shift.matches('2026-10-09T01:00:00-05:00',after),true);
const early = {...overnight,endMinutes:1320};
assert.equal(shift.today(early,at('2026-10-08T22:00:00')).startAt,'2026-10-09T03:00:00.000Z');
assert.equal(shift.today(early,at('2026-10-09T00:00:00')).startAt,'2026-10-09T05:00:00.000Z');
const different = {...overnight,startMinutes:1080,endMinutes:210};
assert.equal(shift.today(different,at('2026-10-09T03:29:59')).dateFrom,'2026-10-08');
assert.equal(shift.today(different,at('2026-10-09T03:30:00')).dateFrom,'2026-10-09');
assert.equal(shift.today({...overnight,date:'2026-12-31'},at('2027-01-01T00:30:00')).dateFrom,'2026-12-31');
assert.equal(shift.bounds({...overnight,date:'2026-02-30'}),null);
assert.equal(shift.bounds({...overnight,endMinutes:900}),null);
assert.deepEqual(shift.range('yesterday',overnight,at('2026-10-09T00:30:00')),{dateFrom:'2026-10-08',dateTo:'2026-10-08'});
assert.equal(shift.range('month',overnight,at('2026-10-09T00:30:00')).startAt,undefined);
assert.equal(shift.range('7days',overnight,at('2026-10-09T00:30:00')).dateFrom,'2026-10-03');
assert.equal(shift.today(null,at('2026-10-09T00:30:00')).dateFrom,'2026-10-09');

// Run the actual shared backend against a worksheet fixture: retries and concurrent base changes.
const rows = [];
const sheet = {
  getLastRow:()=>rows.length+1,
  getRange:(first,column,count)=>({getValues:()=>rows.slice(first-2,first-2+count),
    createTextFinder: id=>({matchEntireCell(){return this;},findNext:()=>rows.some(row=>row[0]===id)?{}:null})}),
  appendRow:row=>rows.push(row)
};
const backend=vm.createContext({Date,console,SpreadsheetApp:{flush(){}},Utilities:{formatDate:date=>shift.dateKey(date)}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../appscript/Code.gs'),'utf8'),backend);
backend.withScriptLock_=callback=>callback(); backend.ensureSheet_=()=>sheet;
backend.getSpreadsheet_=()=>({getSheetByName:()=>sheet});
const user={full_name:'Admin'};
const open={id:'operation-open-0001',action:'new',date:'2020-10-08',startMinutes:900,endMinutes:60,amount:100000,expectedId:'',expectedVersion:0};
let saved=backend.saveSalesShift_(open,user);
assert.equal(saved.shift.base,100000);
assert.equal(backend.saveSalesShift_(open,user).duplicate,true);
assert.equal(rows.length,1);
const add={id:'operation-add-0001',action:'add',amount:50000,expectedId:open.id,expectedVersion:1};
saved=backend.saveSalesShift_(add,user);
assert.equal(saved.shift.base,150000); assert.equal(saved.shift.initialBase,100000);
assert.equal(backend.saveSalesShift_(add,user).duplicate,true);
assert.equal(rows.length,2);
const conflict=backend.saveSalesShift_({...add,id:'operation-other-01'},user);
assert.equal(conflict.ok,false); assert.equal(conflict.retryable,false); assert.equal(conflict.shift.base,150000);
saved=backend.saveSalesShift_({...add,id:'operation-replace',action:'replace',amount:120000,expectedVersion:2},user);
assert.equal(saved.shift.base,120000); assert.equal(saved.shift.initialBase,100000);
assert.equal(rows[2][11],'replace'); assert.ok(saved.shift.updatedAt);
assert.equal(backend.saveSalesShift_({...open,id:'operation-overlap',expectedId:open.id,expectedVersion:3,startMinutes:930},user).ok,false);
// Totals and all pages must use the same interval, including sales after midnight.
const sales = Array.from({length: 605}, (_, i) => [`sale-${i}`, `F-${i}`, '', '', 'Mesa 1', '2026-10-09T00:30:00-05:00', '', '', 10, 0, 0, 0, 10, 'cash']);
sales.push(['before','Before','','','Mesa 1','2026-10-08T14:59:00-05:00','','',99,0,0,0,99,'cash']);
sales.push(['after','After','','','Mesa 1','2026-10-09T01:00:00-05:00','','',88,0,0,0,88,'cash']);
const table = list => ({getLastRow:()=>list.length+1,getRange:(row,column,count)=>({getValues:()=>list.slice(row-2,row-2+count)})});
const sheets = {Ventas:table(sales),Detalle_Ventas:table([]),Pagos:table([])};
backend.getSpreadsheet_=()=>({getSheetByName:name=>sheets[name]});
backend.getTimezone_=()=>shift.zone;
backend.PropertiesService={getScriptProperties:()=>({getProperty:()=> 'revision'})};
const report=backend.getIncomeReport_({...during,limit:300});
assert.equal(report.totalRecords,605); assert.equal(report.totals.income,6050); assert.equal(report.records.length,300);
assert.equal(report.intervalApplied,true);
const page=backend.getIncomeReport_({...during,pageRows:report.recordRows.slice(300,600),revision:report.revision});
assert.equal(page.intervalApplied,true);assert.equal(page.records.length,300);
const calendar=backend.getIncomeReport_({dateFrom:'2026-10-09',dateTo:'2026-10-09'});
assert.equal(calendar.totalRecords,606);assert.equal(calendar.totals.income,6138);
console.log('PASS turnos: hora de 12 horas, medianoche, cierre exacto, otros rangos, base compartida, reintentos y conflictos entre equipos.');

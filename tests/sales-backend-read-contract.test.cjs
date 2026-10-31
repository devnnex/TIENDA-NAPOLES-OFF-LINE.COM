const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const backend=fs.readFileSync(path.join(__dirname,'../appscript/Code.gs'),'utf8');
function fn(name){const start=backend.indexOf('function '+name+'('),end=backend.indexOf('\nfunction ',start+1);assert.ok(start>=0&&end>start,name);return backend.slice(start,end);}
function harness(){
 const sales=Array.from({length:650},(_,i)=>['s'+i,'TN-'+i,'session-'+i,'t','Mesa 1','2026-10-20T12:00:00-05:00','Cliente','Caja',100,0,0,0,100,'cash','','', '']);
 const details=sales.map(row=>[row[0],row[1],'line-'+row[0],'soda','SODA/GINGER',1,100,100,20,20,80]);
 const tables={sales,payments:[],details};let revision='r1',revisionReads=0,changeDuringRead=false;const reads=[];
 const sheets=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{name,getLastRow:()=>rows.length+1,getRange:(start,_col,count)=>({getValues:()=>rows.slice(start-2,start-2+count)})}]));
 const context=vm.createContext({APP:{sheets:{sales:'sales',payments:'payments',details:'details'}},HEADERS:{sales:Array(17),payments:Array(6),details:Array(11)},
  getSpreadsheet_:()=>({getSheetByName:name=>sheets[name]}),getTimezone_:()=> 'America/Bogota',
  PropertiesService:{getScriptProperties:()=>({getProperty:()=>{revisionReads++;return revision;}})},
  Utilities:{formatDate:()=> '2026-10-31'},readSheetRows_:sheet=>{reads.push(sheet.name);if(changeDuringRead&&sheet.name==='details')revision='r2';return tables[sheet.name];},
  asNumber_:value=>Number(value)||0,dateValueToKey_:value=>String(value).slice(0,10),
  normalizeSearch_:value=>String(value||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()});
 vm.runInContext(fn('getIncomeReport_')+';globalThis.report=getIncomeReport_;',context);
 return {context,reads,revisionReads:()=>revisionReads,setRevision:value=>{revision=value;},changeDuringRead:()=>{changeDuringRead=true;}};
}
const filters={dateFrom:'2026-01-01',dateTo:'2026-10-31',query:'soda/ginger',paymentMethod:'all',limit:500};
test('el backend existente devuelve 500 facturas por lectura y verifica la revisión antes y después de leer los datos',()=>{
 const h=harness(),result=h.context.report(filters);
 assert.equal(result.records.length,500);assert.equal(result.totalRecords,650);assert.equal(result.recordRows.length,650);
 assert.equal(result.revision,'r1');assert.equal(result.truncated,true);assert.equal(h.revisionReads(),2);
 assert.deepEqual(h.reads,['sales','payments','details']);
 const page=h.context.report({...filters,revision:'r1',pageRows:result.recordRows.slice(500)});
 assert.equal(page.records.length,150);assert.equal(h.revisionReads(),4);
 const ids=new Set([...result.records,...page.records].map(row=>row.saleId));assert.equal(ids.size,650);
});
test('si cambia la revisión durante la primera lectura, el propio backend devuelve stale en vez de datos mezclados',()=>{
 const h=harness();h.changeDuringRead();const result=h.context.report(filters);
 assert.equal(result.stale,true);assert.equal(result.records.length,0);assert.equal(h.revisionReads(),2);
});
test('si cambia la revisión durante una página, el backend también rechaza esa página',()=>{
 const h=harness();const first=h.context.report(filters);h.changeDuringRead();
 const page=h.context.report({...filters,revision:'r1',pageRows:first.recordRows.slice(500)});
 assert.equal(page.stale,true);assert.equal(page.records.length,0);assert.equal(h.revisionReads(),4);
});
test('una página con una revisión anterior se rechaza antes de consultar pagos o productos',()=>{
 const h=harness();h.setRevision('r2');const page=h.context.report({...filters,revision:'r1',pageRows:[{row:2,saleId:'s0'}]});
 assert.equal(page.stale,true);assert.equal(h.reads.length,0);assert.equal(h.revisionReads(),1);
});

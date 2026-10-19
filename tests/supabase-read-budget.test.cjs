const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const block=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a+1);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const section=(a,b)=>block('  const '+a+' =','  const '+b+' =');
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function factory(){const context=vm.createContext({Map});vm.runInContext(section('createReadBudget','state')+';globalThis.make=createReadBudget;',context);return context.make;}
test('las ventanas solo limitan sondeos, aíslan sesiones y recuperan reloj o conexión sin guardar datos',()=>{
 let now=0;const budget=factory()(()=>now);
 assert.equal(budget.due('catalog',5000,'a'),true);assert.equal(budget.due('catalog',5000,'a'),false);
 now=5000;assert.equal(budget.due('catalog',5000,'a'),true);
 assert.equal(budget.due('catalog',5000,'b'),true);budget.settled('catalog',false,'a');
 now=6000;assert.equal(budget.due('catalog',5000,'b'),false);
 now=10000;assert.equal(budget.due('catalog',5000,'b'),true);budget.settled('catalog',false,'b');
 now=15000;assert.equal(budget.due('catalog',5000,'b'),true);budget.settled('catalog',false,'b');
 now=16000;assert.equal(budget.due('catalog',0,'b'),false);
 budget.touch('catalog','b');budget.settled('catalog',true,'b');assert.equal(budget.due('catalog',0,'b'),true);
 now=100;assert.equal(budget.due('catalog',5000,'b'),true);
 for(let n=0;n<10;n++){budget.touch('failed','b');budget.settled('failed',false,'b');now+=30000;assert.equal(budget.due('failed',0,'b'),true);}
});
function adminHarness({healthy=true,hidden=false}={}){
 let now=0,next=0;const timers=new Map(),calls={snapshot:0,core:0,users:0,requests:0};let gate=null;
 const state={authToken:'token-a',page:'admin',adminDataConnected:healthy,adminBroadcastConnected:healthy,coreRefreshedAt:0};
 state.readBudget=factory()(()=>now);
 const context=vm.createContext({state,navigator:{onLine:true},document:{hidden},SYNC_INTERVAL_MS:1500,Date:class extends Date{static now(){return now;}},
  setInterval:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay,due:now+delay});return id;},clearInterval:id=>timers.delete(id),
  window:{setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay:0,due:now+delay});return id;}},
  pollAdminRequests:()=>{calls.requests++;},loadAdminData:async()=>{calls.snapshot++;if(gate)await gate;return false;},
  refreshCoreNow:async()=>{calls.core++;state.coreRefreshedAt=now;},isBoss:()=>true,loadUsers:()=>{calls.users++;},renderAdminLive(){},refreshBackgroundReports(){}});
 vm.runInContext(block('  let adminRefreshPending =','  const startAdminPolling =')+section('startAdminPolling',source.includes('  const pendingAdminReadScope =')?'pendingAdminReadScope':'pendingAdminRequestsStorageKey')+';globalThis.api={startAdminPolling,refreshAdminNow};',context);
 const advance=async ms=>{const end=now+ms;while(true){const due=[...timers].filter(([,t])=>t.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!due)break;now=due[1].due;if(due[1].delay)due[1].due+=due[1].delay;else timers.delete(due[0]);due[1].fn();await settle();}now=end;await settle();};
 return {state,calls,api:context.api,advance,setGate:value=>{gate=value;},context};
}
test('Realtime sano reduce snapshots y catálogo; solicitudes conservan su lector independiente cada segundo',async()=>{
 const h=adminHarness();h.api.startAdminPolling();await h.advance(60000);
 assert.equal(h.calls.requests,61);assert.equal(h.calls.snapshot,10);assert.equal(h.calls.core,4);assert.equal(h.calls.users,4);
 const previous=h.calls.snapshot;await h.api.refreshAdminNow();assert.equal(h.calls.snapshot,previous+1,'un aviso o acción explícita no queda retenido');
 h.state.adminDataConnected=false;await h.advance(6000);assert.equal(h.calls.snapshot,previous+5,'la caída del canal de datos restaura el respaldo de 1,5 segundos');
 const background=adminHarness({hidden:true});background.api.startAdminPolling();await background.advance(60000);
 assert.equal(background.calls.requests,61);assert.equal(background.calls.snapshot,4);assert.equal(background.calls.core,1);
});
test('un sondeo lento no genera un bucle al terminar; un aviso recibido durante la lectura sí verifica otra vez',async()=>{
 const h=adminHarness({healthy:false});let release;h.setGate(new Promise(resolve=>{release=resolve;}));h.api.startAdminPolling();
 await h.advance(15000);assert.equal(h.calls.snapshot,1);release();await settle();await h.advance(0);assert.equal(h.calls.snapshot,1);
 let finish;h.setGate(new Promise(resolve=>{finish=resolve;}));const read=h.api.refreshAdminNow();await settle();await h.api.refreshAdminNow();
 h.setGate(null);finish();await read;await h.advance(0);assert.equal(h.calls.snapshot,3);
});
test('dos temporizadores de chat comparten la ventana; los eventos, errores y cambio de mesa conservan lecturas inmediatas',async()=>{
 let now=0,count=0,next=0;const pending=[];
 const state={page:'client',currentTable:{id:'table-a',qr_code:'qr-a'},currentSession:{id:'session-a'},clientRealtimeConnected:true,adminChats:new Map(),readBudget:factory()(()=>now)};
 const context=vm.createContext({state,document:{hidden:false},CHAT_SYNC_INTERVAL_MS:1200,window:{setTimeout:fn=>pending.push(fn)},fetchChatMessages:async()=>{count++;return true;}});
 vm.runInContext(block('  const chatReads =','  const persistChatMessage =')+';globalThis.read=loadChatMessages;',context);
 const periodic=()=>context.read(undefined,undefined,{periodic:true});
 for(now=0;now<60000;now+=300){if(now%1200===0||now%1500===0)await periodic();}
 assert.equal(count,50);await context.read();assert.equal(count,51);
 state.currentTable={id:'table-b',qr_code:'qr-b'};state.currentSession={id:'session-b'};await periodic();assert.equal(count,52);
 context.document.hidden=true;const before=count;for(now=60000;now<70000;now+=1200)await periodic();assert.ok(count-before<=2);
});
test('el temporizador de reportes es único y no aplaza escrituras al reducir lecturas',async()=>{
 let now=0,id=0,reads=0,writes=0,prepared=0;const callbacks=new Map(),state={authToken:'a',adminBroadcastConnected:true,readBudget:factory()(()=>now)};
 const context=vm.createContext({state,document:{hidden:false},SYNC_INTERVAL_MS:1500,window:{setInterval:fn=>{callbacks.set(++id,fn);return id;}},
  queueReadyCheckoutReports:()=>prepared++,flushConfirmedReportChanges:()=>writes++,syncConfirmedReports:()=>reads++});
 vm.runInContext(section('startConfirmedReportSync','clientBillEnabled')+';globalThis.start=startConfirmedReportSync;',context);
 context.start();context.start();assert.equal(callbacks.size,1);
 for(now=1500;now<=60000;now+=1500)callbacks.values().next().value();
 assert.equal(writes,41);assert.equal(prepared,41);assert.equal(reads,11);
});
test('las firmas de Carta se comparten hasta cuatro minutos y se invalidan al cambiar credenciales o QR',async()=>{
 let now=0,requests=0,token='a',table={id:'table',qr_code:'one'},fail=false;
 const menu=fs.readFileSync(path.join(__dirname,'../menu-cards.js'),'utf8'),start=menu.indexOf('  const signedImage ='),end=menu.indexOf('  const activeTables =',start);
 const context=vm.createContext({Map,URL,Date:class extends Date{static now(){return now;}},location:{href:'https://fixture.test/'},
  ctx:{page:'admin',getAuthToken:()=>token,getCurrentTable:()=>table},storage:()=>({createSignedUrl:async()=>{requests++;return fail?{error:{message:'fallo'}}:{data:{signedUrl:'https://storage.test/image?request='+requests}};}})});
 vm.runInContext("const signedImages=new Map();let signedImageScope='';"+menu.slice(start,end)+';globalThis.sign=signedImage;',context);
 const [a,b]=await Promise.all([context.sign('one'),context.sign('one')]);assert.equal(a,b);assert.equal(requests,1);
 now=239999;await context.sign('one');assert.equal(requests,1);now=240000;await context.sign('one');assert.equal(requests,2);
 token='b';await context.sign('one');assert.equal(requests,3);table={...table,qr_code:'two'};await context.sign('one');assert.equal(requests,4);
 fail=true;await assert.rejects(context.sign('bad'),/No se pudo abrir/);await assert.rejects(context.sign('bad'),/No se pudo abrir/);assert.equal(requests,6);
});
test('los refrescos de Marca conservan nombre, subtítulo y color pendientes',()=>{
 const state={businessFormDirty:true,business:{business_name:'Remoto',subtitle:'Remoto',accent_color:'#ffffff'},tipSettings:{percentage:10}};
 const field=value=>({value,closest:()=>null}),form={business_name:field('Mi borrador'),subtitle:field('Mi texto'),accent_color:field('#123456'),currency:field('COP'),tips_enabled:{},qr_regeneration_enabled:{},tip_percentage:field('10')};
 const context=vm.createContext({state,$:selector=>selector==='#businessForm'?form:null,DEFAULT_CURRENCY:'COP',clientBillEnabled:()=>true,tipsEnabled:()=>false,qrRegenerationEnabled:()=>false,renderBrandAssetFields(){},renderOutdoorTableConfigurator(){}});
 vm.runInContext(section('renderBusinessForm','visibleManagerTables')+';globalThis.render=renderBusinessForm;',context);context.render();
 assert.equal(form.business_name.value,'Mi borrador');assert.equal(form.subtitle.value,'Mi texto');assert.equal(form.accent_color.value,'#123456');
 state.businessFormDirty=false;context.render();assert.equal(form.business_name.value,'Remoto');
});

test('Marca actualiza todos los logos y conserva el nodo de imagen cuando su contenido no cambia',()=>{
 let writes=0;
 const nodes=Array.from({length:2},()=>({dataset:{},set innerHTML(value){writes++;this.markup=value;}}));
 const state={business:{business_name:'Local',logo_url:'https://fixture.test/logo.png'}};
 const context=vm.createContext({state,$$:selector=>selector==='.js-brand-logo'?nodes:[],$:()=>null,
  syncClientBillVisibility(){},escapeHTML:value=>value,icon:()=>'',syncPwaBranding(){}});
 vm.runInContext(section('renderBrand','renderTablePicker')+';globalThis.render=renderBrand;',context);
 context.render();assert.equal(writes,2);
 context.render();assert.equal(writes,2);
 state.business.logo_url='https://fixture.test/otra.png';context.render();assert.equal(writes,4);
});

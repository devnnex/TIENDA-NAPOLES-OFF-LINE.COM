const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=source.indexOf('  const signalRequestArrival ='),end=source.indexOf('  const flushRequestOutbox =',start);
const timers=new Map(),requests=[];let id=0,ok=false;
const context=vm.createContext({AbortController,SUPABASE_CONFIG:{url:'https://example.supabase.co',anonKey:'public-key'},
 window:{setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)},
 fetch:async(url,options)=>{requests.push({url,options});return {ok};}});
vm.runInContext(source.slice(start,end)+';globalThis.signal=signalRequestArrival;',context);
(async()=>{
 await context.signal();
 assert.equal(requests.length,1);
 assert.equal(requests[0].options.cache,'no-store');
 assert.equal(JSON.parse(requests[0].options.body).messages[0].topic,'admin');
 const retry=[...timers.values()].find(timer=>timer.delay===1000);assert.ok(retry);
 ok=true;retry.fn();await new Promise(setImmediate);
 assert.equal(requests.length,2,'El aviso confirmado se recupera aunque no exista ningún WebSocket.');
 const init=source.slice(source.indexOf('  const initAdmin ='),source.indexOf('  const resumeRealtimeReception ='));
 assert.ok(init.indexOf('startAdminPolling();')<init.indexOf('await loadBootstrap();')||!init.includes('await loadBootstrap();'),'La recepción de solicitudes no espera a las cargas iniciales.');
 assert.match(source,/readRealtimeData\(state\.sb\.from\("service_requests"\)\.select\("\*"\)\.in/,'La comprobación de solicitudes faltantes tiene tiempo límite.');
 let authenticatedFetch, lastOptions;
 const dbContext=vm.createContext({URL,Headers,Request,Response,SUPABASE_CONFIG:{url:'https://example.supabase.co',anonKey:'public-key'},
   fetch:async(input,options)=>{lastOptions=options;return Response.json({});},
   window:{supabase:{createClient:(url,key,options)=>{authenticatedFetch=options.global.fetch;return {};}}}});
 vm.runInContext(source.slice(source.indexOf('const SupabaseDb ='),source.indexOf('const App ='))+';SupabaseDb.init();',dbContext);
 await authenticatedFetch('https://example.supabase.co/rest/v1/service_requests',{method:'GET'});
 assert.equal(lastOptions.cache,'no-store','Las lecturas no reutilizan una respuesta HTTP antigua.');
 console.log('PASS avisos de solicitudes por HTTP, reintento sin socket, inicio temprano y lecturas acotadas.');
})().catch(error=>{console.error(error);process.exitCode=1;});

const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=source.indexOf('const SupabaseDb ='),end=source.indexOf('const App =',start);
let authenticatedFetch,response=Response.json({}),signals=[];
const context=vm.createContext({URL,Headers,Request,Response,CustomEvent:class{constructor(type,args){this.type=type;this.detail=args.detail;}},
 SUPABASE_CONFIG:{url:'https://test.supabase.co',anonKey:'public-key'},fetch:async()=>response,
 window:{dispatchEvent:e=>signals.push(e),supabase:{createClient:(url,key,options)=>{authenticatedFetch=options.global.fetch;return {};}}}});
vm.runInContext(source.slice(start,end)+';SupabaseDb.init();',context);
(async()=>{
 const endpoint=name=>'https://test.supabase.co/rest/v1/'+name;
 await authenticatedFetch(endpoint('rpc/get_bootstrap_data'),{method:'POST'});
 await authenticatedFetch(endpoint('table_sessions'),{method:'GET'});
 assert.equal(signals.length,0,'Las lecturas no provocan bucles de actualización entre equipos.');
 await authenticatedFetch(endpoint('menu_items'),{method:'PATCH'});
 assert.equal(signals[0].detail.core,true);
 await authenticatedFetch(endpoint('rpc/record_session_payment'),{method:'POST'});
 assert.equal(signals[1].detail.operational,true);
 await authenticatedFetch(endpoint('rpc/save_user'),{method:'POST'});
 assert.equal(signals[2].detail.users,true);
 response=Response.json({}, {headers:{'X-Offline-Queued':'1'}});
 await authenticatedFetch(endpoint('session_items'),{method:'POST'});
 response=Response.json({}, {status:400});
 await authenticatedFetch(endpoint('session_items'),{method:'PATCH'});
 assert.equal(signals.length,3,'No anuncia como confirmado un cambio solo local o rechazado.');
 response=Response.json({});
 await authenticatedFetch(endpoint('rpc/get_session_payments'),{method:'POST'});
 assert.equal(signals.length,3);
 console.log('PASS señales de sincronización: cambios confirmados en catálogo/cuentas/usuarios; sin señales para lecturas, colas locales o errores.');
})().catch(e=>{console.error(e);process.exitCode=1;});

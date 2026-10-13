const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
test('solicitudes y chat tienen prioridad de red y conservan el token del empleado; reportes quedan en segundo plano',async()=>{
 let authenticatedFetch;
 const seen=[];
 const context=vm.createContext({URL,Headers,Request,Response,SUPABASE_CONFIG:{url:'https://fixture.supabase.co',anonKey:'public'},
  fetch:async(input,options)=>{seen.push(options);return Response.json({});},
  window:{supabase:{createClient:(url,key,options)=>{authenticatedFetch=options.global.fetch;return {};}}}});
 vm.runInContext(source.slice(source.indexOf('const SupabaseDb ='),source.indexOf('const App ='))+';globalThis.db=SupabaseDb;',context);
 context.db.setAuthToken('employee-token');context.db.init();
 for(const [entity,priority] of [['service_requests','high'],['rpc/create_service_requests_batch','high'],['rpc/list_chat_messages','high'],['rpc/send_chat_message','high'],['rpc/get_report_changes','low'],['rpc/publish_report_change','low'],['restaurant_tables','auto']]){
  await authenticatedFetch('https://fixture.supabase.co/rest/v1/'+entity,{method:'GET'});
  const options=seen.at(-1);assert.equal(options.priority,priority,entity);assert.equal(options.headers.get('x-app-token'),'employee-token');assert.equal(options.cache,'no-store');
 }
});

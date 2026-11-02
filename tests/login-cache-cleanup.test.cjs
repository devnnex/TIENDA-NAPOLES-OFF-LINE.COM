const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8');
function fixture({fail=false}={}){
 const current=/const OFFLINE_CACHE = "([^"]+)"/.exec(source)[1],origin='http://127.0.0.1:8766/';
 const stores=new Map([[current,new Map([[origin+'app.js','old'],[origin+'obsolete.js','old']])],['tienda-napoles-offline-shell-v79',new Map()],['tienda-napoles-offline-remote-v7',new Map()],['tienda-napoles-pwa-brand-v1',new Map([['logo','brand']])],['other-app',new Map([['data','keep']])]]);
 const listeners={},downloads=[];
 const cacheFor=name=>({async put(request,response){stores.get(name).set(request.url,await response.text());},async keys(){return [...stores.get(name).keys()].map(url=>new Request(url));},async delete(request){return stores.get(name).delete(request.url);}});
 const context=vm.createContext({Request,Response,Headers,URL,AbortController,console,setTimeout,clearTimeout,
  indexedDB:{open(){throw Error('durable storage must not be opened');},deleteDatabase(){throw Error('durable storage must not be deleted');}},
  fetch:async request=>{downloads.push(request);return new Response('fresh:'+request.url,{status:fail&&request.url.endsWith('style.css')?503:200});},
  caches:{async open(name){if(!stores.has(name))stores.set(name,new Map());return cacheFor(name);},async keys(){return [...stores.keys()];},async delete(name){return stores.delete(name);}},
  self:{location:{origin:origin.slice(0,-1)},registration:{scope:origin},addEventListener:(name,fn)=>{listeners[name]=fn;}}});
 vm.runInContext(source+';globalThis.refresh=refreshLoginCache;',context);return {context,stores,downloads,listeners,current,origin};
}
test('el login renueva recursos y elimina cachés obsoletas, conservando IndexedDB, marca y otros orígenes',async()=>{
 const h=fixture();let work;
 h.listeners.message({data:{type:'REFRESH_LOGIN_CACHE'},source:{id:'staff-page'},waitUntil:promise=>{work=promise;}});
 assert.equal(await work,true);assert.match(h.stores.get(h.current).get(h.origin+'app.js'),/^fresh:/);
 assert.equal(h.stores.get(h.current).has(h.origin+'obsolete.js'),false);
 assert.equal(h.stores.has('tienda-napoles-offline-shell-v79'),false);assert.equal(h.stores.has('tienda-napoles-offline-remote-v7'),false);
 assert.equal(h.stores.get('tienda-napoles-pwa-brand-v1').get('logo'),'brand');assert.equal(h.stores.get('other-app').get('data'),'keep');
 assert.ok(h.downloads.every(request=>request.cache==='reload'));
});
test('un recurso inaccesible conserva la caché operativa y permite reintentar',async()=>{
 const h=fixture({fail:true});assert.equal(await h.context.refresh(),false);
 assert.equal(h.stores.get(h.current).get(h.origin+'app.js'),'old');assert.ok(h.stores.has('tienda-napoles-offline-shell-v79'));
});
test('dos avisos simultáneos comparten la limpieza sin recargar ni eliminar datos',async()=>{
 const h=fixture();const a=h.context.refresh(),b=h.context.refresh();assert.equal(a,b);assert.equal(await a,true);
 const count=h.downloads.length;assert.equal(await h.context.refresh(),true);assert.equal(h.downloads.length,2*count);
});

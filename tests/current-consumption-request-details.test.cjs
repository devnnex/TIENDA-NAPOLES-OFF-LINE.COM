const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section=(from,to)=>source.slice(source.indexOf('  const '+from+' ='),source.indexOf('  const '+to+' =',source.indexOf('  const '+from+' =')+1));
function consumptionContext({open=true,drafts=[],custom=false}={}){
 const item={id:'saved-item',menu_item_id:custom?null:'product-1',item_name:'Producto guardado',quantity:3,unit_price:12000,notes:'Sin hielo',status:'served'};
 const session={id:'session-1',payer_name:'Ana',session_items:[item]};
 let resetCount=0,previewRenders=0,focused=0;
 const form={dataset:{},reset(){resetCount++;}};
 for(const name of ['session_id','session_item_id','pending_table_id','quick_checkout','quantity','menu_item_id','item_name','payer_name','unit_price','notes'])form[name]={value:''};
 form.session_id.value=session.id;
 form.quantity.focus=()=>focused++;form.quantity.select=()=>{};
 const dialog={open,showModal(){assert.equal(this.open,false);this.open=true;}};
 const preview={hidden:!open},search={value:''},layout={classList:{toggle(name,value){this.withoutPreview=value;}}};
 const fields={'#consumptionForm':form,'#consumptionDialog':dialog,'#tableConsumptionPreview':preview,'#consumptionProductSearch':search,
  '#consumptionLayout':layout,'#consumptionSubmitButton span':{},'#consumptionOptionalFields':{},'#tableSessionActions':{},'#consumptionQueueButton':{},'#consumptionEyebrow':{},'#consumptionDialogTitle':{}};
 const notices=[];
 const state={sessions:[session],items:custom?[]:[{id:'product-1',name:'Producto del inventario'}],consumptionDrafts:drafts,consumptionDraftEditIndex:2};
 const context=vm.createContext({state,$:selector=>fields[selector],toast:message=>notices.push(message),
  applyConsumptionRoleRestrictions(){},renderConsumptionSelection(){},renderTableConsumptionPreview(){previewRenders++;},
  setCurrencyInputValue(input,value){input.value=value;},inventoryFor:()=>({code:'PR'}),renderConsumptionProductOptions(){},closeConsumptionProductOptions(){},refreshIcons(){}});
 vm.runInContext(section('editConsumption','deleteConsumption')+';globalThis.edit = editConsumption;',context);
 return {context,state,form,dialog,preview,search,layout,notices,stats:()=>({resetCount,previewRenders,focused})};
}
test('Al editar un consumo actual carga sus campos, conserva el modal y modifica el mismo registro',async()=>{
 const f=consumptionContext();f.context.edit('session-1','saved-item');
 assert.equal(f.form.session_item_id.value,'saved-item');
 assert.equal(f.form.menu_item_id.value,'product-1');
 assert.equal(f.form.quantity.value,3);assert.equal(f.form.unit_price.value,12000);
 assert.equal(f.form.notes.value,'Sin hielo');assert.equal(f.form.payer_name.value,'Ana');
 assert.equal(f.preview.hidden,false);assert.equal(f.layout.classList.withoutPreview,false);
 assert.equal(f.state.consumptionDraftEditIndex,-1);
 assert.deepEqual(f.stats(),{resetCount:1,previewRenders:1,focused:1});
 let savedId;
 f.context.addManualConsumption=async form=>{savedId=form.session_item_id.value;return savedId;};
 vm.runInContext(section('confirmConsumptionSelection','bindConsumptionConfirmShortcut')+';globalThis.confirm = confirmConsumptionSelection;',f.context);
 assert.equal(await f.context.confirm(f.form),'saved-item');
 assert.equal(savedId,'saved-item');
});
test('Un consumo personalizado llena tambien el input de producto',()=>{
 const f=consumptionContext({custom:true});f.context.edit('session-1','saved-item');
 assert.equal(f.search.value,'Producto guardado');assert.equal(f.form.item_name.value,'Producto guardado');
});
test('No descarta la seleccion pendiente al intentar editar desde el consumo actual',()=>{
 const drafts=[{itemName:'Producto pendiente',quantity:2}];
 const f=consumptionContext({drafts});f.form.quantity.value=7;
 f.context.edit('session-1','saved-item');
 assert.equal(f.state.consumptionDrafts,drafts);assert.equal(f.form.quantity.value,7);
 assert.equal(f.stats().resetCount,0);assert.equal(f.notices.length,1);
});
test('La edicion desde cuentas sigue abriendo el modal y un consumo cancelado no se puede seleccionar',()=>{
 const f=consumptionContext({open:false});f.context.edit('session-1','saved-item');
 assert.equal(f.dialog.open,true);assert.equal(f.preview.hidden,true);
 assert.equal(f.layout.classList.withoutPreview,true);
 f.state.sessions[0].session_items[0].status='cancelled';
 f.context.edit('session-1','saved-item');assert.equal(f.stats().resetCount,1);
});
test('El desglose muestra todos los mensajes y canciones en orden y escapa su contenido',()=>{
 const rows=[
  {id:'song-1',table_id:'mesa-1',kind:'song',message:'Cancion A',created_at:1},
  {id:'song-2',table_id:'mesa-1',kind:'song',message:'Cancion B',created_at:2},
  {id:'chat-1',table_id:'mesa-1',kind:'chat',message:'Primer mensaje',created_at:3},
  {id:'chat-2',table_id:'mesa-1',kind:'chat',message:'<img src=x onerror=alert(1)>',created_at:4},
  {id:'other',table_id:'mesa-2',kind:'chat',message:'Otra mesa',created_at:5}
 ];
 const context=vm.createContext({activeRequests:()=>rows,requestKind:row=>row.kind,compareRequestArrival:(a,b)=>a.created_at-b.created_at,
  escapeHTML:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),prettyDateTime:value=>'Hora '+value});
 vm.runInContext(section('groupedActiveRequests','renderAlerts')+';globalThis.api = {groupedActiveRequests,requestGroupDetailsHtml};',context);
 const groups=context.api.groupedActiveRequests();
 const songs=groups.find(group=>group.kind==='song'),chat=groups.find(group=>group.kind==='chat'&&group.table_id==='mesa-1');
 const songHtml=context.api.requestGroupDetailsHtml(songs),chatHtml=context.api.requestGroupDetailsHtml(chat);
 assert.equal(songs.entries.length,2);assert.equal(chat.entries.length,2);
 assert.ok(songHtml.indexOf('Cancion A')<songHtml.indexOf('Cancion B'));
 assert.ok(chatHtml.indexOf('Primer mensaje')<chatHtml.indexOf('&lt;img'));
 assert.ok(!chatHtml.includes('<img'));assert.ok(chatHtml.includes('Hora 4'));
 assert.equal(context.api.requestGroupDetailsHtml(groups.find(group=>group.table_id==='mesa-2')),'');
 assert.equal(rows.length,5);assert.deepEqual([...songs.request_ids],['song-2','song-1']);
});

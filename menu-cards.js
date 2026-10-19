/* Consulta visual de Carta, adaptada de LOS-A-MARAVILLOSOS.COM.
 * Persistencia exclusiva en Supabase; no participa en pedidos ni en sus colas. */
window.MenuCards = (() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  let ctx, admin, cards = [], busy = false, loaded = false, loadJob, adminRender = 0;
  let viewer, viewCards = [], viewIndex = 0, generation = 0, tableKey = '', zoom = 1;
  const images = new Map();
  const libraryPreviews = new Map();
  const storage = () => ctx.sb.storage.from('pos-menu-cards');
  const status = (message, error = false) => {
    const node = $('#menuCardsStatus');
    if (node) { node.textContent = message; node.classList.toggle('is-error', error); }
  };
  const requireOnline = () => { if (!navigator.onLine) throw new Error('Conéctate a internet para consultar o guardar la Carta.'); };
  const rpc = async (name, args) => {
    requireOnline();
    const {data, error} = await ctx.sb.rpc(name, args);
    if (error) throw new Error(error.message || 'No se pudo confirmar la operación.');
    if (data == null) throw new Error('No se recibió confirmación del servidor.');
    return data;
  };
  const signedImage = async path => {
    const {data, error} = await storage().createSignedUrl(path, 300);
    if (error || !data?.signedUrl) throw new Error('No se pudo abrir la imagen. Vuelve a cargar la Carta.');
    const url = new URL(data.signedUrl, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Dirección de imagen inválida.');
    return url.href;
  };
  const activeTables = () => (ctx.getTables() || []).filter(t => t.is_active !== false).slice().sort((a,b) => Number(a.table_number)-Number(b.table_number));
  const tableOptions = card => activeTables().map(t => `<label><input type="checkbox" data-menu-table value="${escape(t.id)}" ${(card.table_ids || []).includes(t.id) ? 'checked' : ''}> Mesa ${escape(t.table_number)}${t.name ? ` · ${escape(t.name)}` : ''}</label>`).join('');
  const renderLibrary = () => {
    const stack=$('#menuLibraryStack');
    if (!stack) return;
    $('#menuLibraryCount').textContent=`${cards.length}/20`;
    $('#menuLibraryProgress').value=cards.length;
    $('#menuLibraryUploadStatus').textContent=busy?'Subiendo imágenes…':loaded?'Subir imágenes · JPG, PNG o WebP':'Cargando biblioteca…';
    const disabled=busy || !loaded || cards.length>=20;
    stack.innerHTML=cards.length?cards.slice(0,5).map((card,index)=>`<button type="button" class="menu-library-card" data-menu-library-upload style="--card-index:${index};--card-depth:${5-index}" aria-label="Subir otra imagen de Carta" ${disabled?'disabled':''}>
      <img data-menu-library-image="${escape(card.id)}" ${libraryPreviews.has(card.image_path)?`src="${escape(libraryPreviews.get(card.image_path))}"`: 'hidden'} alt="${escape(card.name)}"><span>${escape(card.name)}</span></button>`).join('')
      :`<button type="button" class="menu-library-empty" data-menu-library-upload ${busy?'disabled':''}><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="3" width="16" height="16" rx="2"/><path d="M2 7v13a2 2 0 0 0 2 2h13M5 15l5-5 5 5 3-3 3 3"/><circle cx="16" cy="7" r="1"/></svg><span>${loaded?'Subir imágenes de Carta':'Cargar biblioteca'}</span></button>`;
  };
  const renderAdmin = () => {
    if (!admin) return;
    const render = ++adminRender;
    const list = $('#menuCardsList');
    list.innerHTML = cards.map((c,i) => `<article class="menu-card-item" data-menu-card="${escape(c.id)}">
      <img class="menu-card-preview" alt="${escape(c.name)}" data-menu-preview="${escape(c.id)}" hidden>
      <div class="menu-card-fields"><label>Nombre<input data-menu-name maxlength="80" value="${escape(c.name)}"></label>
      <label><input type="checkbox" data-menu-all ${c.all_tables ? 'checked' : ''}> Mostrar en todas las mesas</label>
      <fieldset class="menu-card-tables" ${c.all_tables ? 'hidden' : ''}><legend>Mesas que verán esta imagen</legend>${tableOptions(c) || '<p>No hay mesas activas.</p>'}</fieldset>
      <div class="menu-card-actions"><button type="button" class="primary" data-menu-action="save">Guardar nombre y mesas</button>
      <label class="ghost menu-card-replace">Reemplazar imagen<input type="file" accept="image/jpeg,image/png,image/webp" data-menu-replace></label>
      <button type="button" class="ghost" data-menu-action="up" aria-label="Subir ${escape(c.name)} en el orden" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="ghost" data-menu-action="down" aria-label="Bajar ${escape(c.name)} en el orden" ${i === cards.length-1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="ghost danger-text" data-menu-action="delete">Eliminar</button></div></div></article>`).join('') || '<p>Aún no hay imágenes publicadas.</p>';
    $('#menuCardsUpload').disabled = busy || !loaded || cards.length >= 20;
    renderLibrary();
    $('#menuCardsReload').disabled = busy;
    list.querySelectorAll('input,button').forEach(node => { if (busy) node.disabled = true; });
    cards.forEach(async c => {
      try {
        const url = await signedImage(c.image_path);
        if (render !== adminRender) return;
        libraryPreviews.set(c.image_path,url);
        const thumbnail=[...document.querySelectorAll('[data-menu-library-image]')].find(n=>n.dataset.menuLibraryImage===c.id);
        if(thumbnail){thumbnail.src=url;thumbnail.hidden=false;}
        const node = [...list.querySelectorAll('[data-menu-preview]')].find(n => n.dataset.menuPreview === c.id);
        if (node) { node.src = url; node.hidden = false; node.onerror = () => { node.hidden = true; status('Una vista previa no está disponible. Recarga para reintentar.',true); }; }
      } catch (error) { if (render === adminRender) status(error.message,true); }
    });
  };
  const loadLibrary = async () => {
    if (loadJob) return loadJob;
    if (!ctx.canManage()) { status('Necesitas permiso de Marca para administrar la Carta.',true); return false; }
    loadJob = (async () => {
      try {
        status('Cargando imágenes guardadas…');
        cards = await rpc('pos_list_menu_cards',{p_auth_token:ctx.getAuthToken()});
        if (!Array.isArray(cards)) throw new Error('La biblioteca recibida no es válida.');
        loaded = true;
        renderAdmin(); status(`${cards.length} imagen(es) publicada(s). Los cambios se guardan por carta.`);
        return true;
      } catch (error) { status(`No se pudo cargar la Carta. ${error.message}`,true); return false; }
      finally { loadJob = null; }
    })();
    return loadJob;
  };
  const validateFile = async file => {
    if (!types[file.type] || !file.size || file.size > 15*1024*1024) throw new Error('Usa JPG, PNG o WebP de hasta 15 MB por imagen.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const valid = file.type === 'image/jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
      : file.type === 'image/png' ? [137,80,78,71,13,10,26,10].every((n,i) => bytes[i]===n)
      : String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    if (!valid) throw new Error('El contenido del archivo no corresponde a una imagen permitida.');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      if (!image.naturalWidth || image.naturalWidth*image.naturalHeight > 100000000) throw new Error('La imagen supera 100 megapíxeles. Usa una resolución menor.');
    } finally { URL.revokeObjectURL(url); }
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  };
  const saveCard = (card, changes) => rpc('pos_save_menu_card', {
    p_id:card.id,p_name:changes.name ?? card.name,p_image_path:changes.image_path ?? card.image_path,
    p_all_tables:changes.all_tables ?? card.all_tables,p_table_ids:changes.table_ids ?? card.table_ids ?? [],
    p_expected_version:card.version || 0,p_auth_token:ctx.getAuthToken()
  });
  const uuidForHash = hash => `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const cleanup = async path => {
    try { const {error} = await storage().remove([path]); return !error; }
    catch (_) { return false; }
  };
  const uploadFiles = async (fileList, replacing) => {
    const files = [...fileList];
    if (!files.length || busy) return;
    if (!ctx.canManage()) { status('Necesitas permiso de Marca para administrar la Carta.',true); return; }
    busy = true; renderAdmin();
    let completed = 0, cleanupPending = false;
    try {
      requireOnline();
      if (!loaded) throw new Error('Recarga la biblioteca antes de subir imágenes.');
      if (cards.length + (replacing ? 0 : files.length) > 20) throw new Error('Puedes guardar hasta 20 imágenes de Carta.');
      const hashes = [];
      for (const file of files) hashes.push(await validateFile(file));
      for (let i=0;i<files.length;i++) {
        const file=files[i],hash=hashes[i];
        // El contenido identifica los reintentos. Si su carta original fue
        // reemplazada, una carga posterior puede volver a publicar esa imagen.
        if (!replacing && cards.some(c=>c.image_path.endsWith(`/${hash}.${types[file.type]}`))) { completed++; continue; }
        let id=replacing?.id || uuidForHash(hash),attempt=0;
        while(!replacing && cards.some(c=>c.id===id)) {
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${hash}:${++attempt}`));
          id=uuidForHash([...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''));
        }
        const path = `cards/${id}/${hash}.${types[file.type]}`;
        status(`Subiendo ${i+1} de ${files.length}… No cierres esta ventana.`);
        const previewUrl=URL.createObjectURL(file);
        const preview=$('#menuCardsPending'); preview.src=previewUrl;preview.hidden=false;
        try {
          const {error} = await storage().upload(path,file,{upsert:false,contentType:file.type,cacheControl:'300'});
          if (error && !['409','Duplicate'].includes(String(error.statusCode || error.error))) throw new Error(error.message || 'No se pudo subir la imagen.');
          // Verifica que Storage puede devolver el objeto antes de publicar sus metadatos.
          const remote = new Image(); remote.src = await signedImage(path); await remote.decode();
          const card = replacing || {id,name:file.name.replace(/\.[^.]+$/,'').trim().slice(0,80) || 'Carta',all_tables:true,table_ids:[],version:0};
          const saved=await saveCard(card,{image_path:path});
          const confirmed={...saved,table_ids:card.table_ids || []};
          cards=cards.some(c=>c.id===id)?cards.map(c=>c.id===id?confirmed:c):[...cards,confirmed];
          completed++;
          if (replacing && replacing.image_path !== path) cleanupPending = !await cleanup(replacing.image_path);
        } finally { preview.hidden=true;preview.removeAttribute('src');URL.revokeObjectURL(previewUrl); }
      }
      await loadLibrary();
      status(`${completed} imagen(es) guardada(s) y disponible(s) para sus mesas.${cleanupPending?' El archivo anterior quedó pendiente de retirar de Storage; ya no está publicado.':''}`,cleanupPending);
    } catch (error) {
      // Un fallo de respuesta puede ocurrir después de confirmar el servidor.
      // Se consulta la verdad remota; nunca se añade una publicación optimista.
      await loadLibrary();
      status(`Carga incompleta (${completed}/${files.length}). ${error.message} Recarga para verificar antes de reintentar.`,true);
    } finally { busy=false;renderAdmin();$('#menuCardsUpload').value=''; }
  };
  const adminAction = async button => {
    if (busy || !ctx.canManage()) return;
    const item=button.closest('[data-menu-card]'), card=cards.find(c=>c.id===item?.dataset.menuCard);
    if (!card) return;
    const action=button.dataset.menuAction;
    if (action==='delete' && !await ctx.confirm({title:`¿Eliminar «${card.name}»?`,message:'La imagen dejará de mostrarse en la Carta de sus mesas.',accept:'Eliminar imagen'})) return;
    if (busy) return;
    const changes={name:$('[data-menu-name]',item).value.trim(),all_tables:$('[data-menu-all]',item).checked,
      table_ids:[...item.querySelectorAll('[data-menu-table]:checked')].map(n=>n.value)};
    if (changes.all_tables) changes.table_ids=[];
    if (!changes.name) { status('Escribe un nombre para la carta.',true); return; }
    busy=true;renderAdmin();
    let cleanupPending=false;
    try {
      if (action==='save') await saveCard(card,changes);
      else if (action==='delete') {
        await rpc('pos_delete_menu_card',{p_id:card.id,p_expected_version:card.version,p_auth_token:ctx.getAuthToken()});
        cleanupPending=!await cleanup(card.image_path);
      } else {
        const ids=cards.map(c=>c.id), index=ids.indexOf(card.id), next=index+(action==='up'?-1:1);
        if (next<0 || next>=ids.length) return;
        [ids[index],ids[next]]=[ids[next],ids[index]];
        await rpc('pos_reorder_menu_cards',{p_ids:ids,p_auth_token:ctx.getAuthToken()});
      }
      await loadLibrary(); status(`Cambio guardado. Los clientes lo verán al abrir la Carta.${cleanupPending?' El archivo retirado quedó pendiente de limpiar de Storage; ya no está publicado.':''}`,cleanupPending);
    } catch (error) { status(`${error.message} Recarga la biblioteca antes de reintentar.`,true); }
    finally { busy=false;renderAdmin(); }
  };
  const resetZoom = () => {
    zoom=1;$('#menuViewerImage').style.width='100%';$('#menuViewerZoom').textContent='Ampliar';
    $('#menuViewerStage').scrollTo(0,0);
  };
  const renderViewer = async () => {
    const request=++generation, card=viewCards[viewIndex], img=$('#menuViewerImage'), message=$('#menuViewerStatus');
    resetZoom();img.hidden=true;message.hidden=false;
    $('#menuViewerTitle').textContent=card?.name || 'Carta';
    $('#menuViewerCounter').textContent=card ? `${viewIndex+1} de ${viewCards.length}` : '';
    $('#menuViewerPrevious').disabled=viewIndex<=0;$('#menuViewerNext').disabled=viewIndex>=viewCards.length-1;
    $('#menuViewerZoom').disabled=!card;
    if (!card) { message.textContent='Todavía no hay imágenes de Carta para esta mesa. Consulta con el mesero.'; return; }
    message.textContent='Cargando imagen…';
    try {
      let cached=images.get(card.image_path),url=cached?.url;
      if (!url || cached.expiresAt<Date.now()) {
        requireOnline();
        url=await signedImage(card.image_path);
        const check=new Image();check.src=url;await check.decode();
        if(request!==generation) return;
        images.set(card.image_path,{url,expiresAt:Date.now()+270000});
      }
      if (request!==generation || !viewer.open) return;
      img.src=url;img.alt=card.name;await img.decode();
      if (request!==generation || !viewer.open) return;
      img.hidden=false;message.hidden=true;
    } catch (error) { if(request===generation) {images.delete(card.image_path);message.textContent=`No se pudo cargar la imagen. ${error.message}`;} }
  };
  const openViewer = async () => {
    if (viewer.open) return;
    viewer.showModal(); viewCards=[];viewIndex=0;
    $('#menuViewerImage').hidden=true;$('#menuViewerStatus').hidden=false;$('#menuViewerStatus').textContent='Consultando Carta…';
    $('#menuViewerTitle').textContent='Carta';$('#menuViewerCounter').textContent='';
    const request=++generation,table=ctx.getCurrentTable();
    const key=table ? `${table.id}:${table.qr_code}` : '';
    if (key!==tableKey) { images.clear();tableKey=key; }
    try {
      if (!table) throw new Error('Selecciona tu mesa para consultar la Carta.');
      const data=await rpc('pos_get_menu_cards',{p_table_id:table.id,p_table_access_code:table.qr_code});
      if (request!==generation || !viewer.open || key!==`${ctx.getCurrentTable()?.id}:${ctx.getCurrentTable()?.qr_code}`) return;
      viewCards=Array.isArray(data)?data:[]; images.clear();await renderViewer();
    } catch (error) { if(request===generation) $('#menuViewerStatus').textContent=error.message; }
  };
  const init = context => {
    if (ctx) return;
    ctx=context;
    if(ctx.page==='admin') {
      const form=$('#businessForm');
      const library=document.createElement('div');library.className='menu-library upload-field';library.id='menuCardLibrary';
      library.innerHTML=`<label class="menu-library-upload"><input id="menuCardsUpload" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled><span><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="3" width="16" height="16" rx="2"/><path d="M2 7v13a2 2 0 0 0 2 2h13M5 15l5-5 5 5 3-3 3 3"/><circle cx="16" cy="7" r="1"/></svg> Cartas del negocio</span><small id="menuLibraryUploadStatus">Cargando biblioteca…</small></label><div class="menu-library-stack" id="menuLibraryStack" aria-label="Biblioteca de cartas"></div><div class="menu-library-progress"><label for="menuLibraryProgress">Imágenes subidas <strong id="menuLibraryCount">0/20</strong></label><progress id="menuLibraryProgress" value="0" max="20">0 de 20</progress></div>`;
      const saveActions=$('.brand-save-actions',form);
      if(saveActions)saveActions.before(library);else form?.append(library);
      form?.classList.add('has-menu-library');
      admin=document.createElement('details');admin.className='menu-cards-admin';
      admin.innerHTML=`<summary>Carta · administrar imágenes</summary><div class="menu-cards-body"><p>Sube hasta 20 imágenes JPG, PNG o WebP (15 MB por imagen). Se publican al terminar la carga. Puedes elegir su orden y sus mesas.</p><div class="menu-card-actions"><button class="ghost" id="menuCardsReload" type="button">Recargar biblioteca</button></div><p id="menuCardsStatus" role="status" aria-live="polite">Abre la biblioteca para cargar las imágenes.</p><img id="menuCardsPending" class="menu-card-preview" alt="Vista previa · carga sin confirmar" hidden><div id="menuCardsList"></div></div>`;
      $('#businessForm')?.insertAdjacentElement('afterend',admin);
      admin.addEventListener('toggle',()=>{if(admin.open && !busy) void loadLibrary();});
      $('#menuCardsReload').addEventListener('click',()=>void loadLibrary());
      $('#menuCardsUpload').addEventListener('change',e=>void uploadFiles(e.target.files));
      library.addEventListener('click',e=>{if(e.target.closest('[data-menu-library-upload]')){if(!loaded)void loadLibrary();else if(!$('#menuCardsUpload').disabled)$('#menuCardsUpload').click();}});
      renderLibrary();
      const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting) && ctx.canManage() && !loaded && !busy)void loadLibrary();});
      observer.observe(library);
      admin.addEventListener('click',e=>{const button=e.target.closest('[data-menu-action]');if(button)void adminAction(button);});
      admin.addEventListener('change',e=>{
        if(e.target.matches('[data-menu-all]')) $('fieldset',e.target.closest('[data-menu-card]')).hidden=e.target.checked;
        if(e.target.matches('[data-menu-replace]')) {const card=cards.find(c=>c.id===e.target.closest('[data-menu-card]').dataset.menuCard);void uploadFiles(e.target.files,card);}
      });
    } else if(ctx.page==='client') {
      viewer=document.createElement('dialog');viewer.id='menuCardsViewer';viewer.className='menu-cards-viewer';
      viewer.setAttribute('aria-labelledby','menuViewerTitle');
      viewer.innerHTML=`<div class="menu-viewer-header"><div><h2 id="menuViewerTitle">Carta</h2><span id="menuViewerCounter"></span></div><button type="button" id="menuViewerClose" aria-label="Cerrar Carta">✕</button></div><div id="menuViewerStage" class="menu-viewer-stage" tabindex="0" aria-label="Imagen de Carta; desplaza para leer al ampliar"><p id="menuViewerStatus" role="status" aria-live="polite"></p><img id="menuViewerImage" alt="Carta" hidden></div><div class="menu-viewer-controls"><button id="menuViewerPrevious" type="button" aria-label="Imagen anterior">← Anterior</button><button id="menuViewerZoom" type="button">Ampliar</button><button id="menuViewerNext" type="button" aria-label="Imagen siguiente">Siguiente →</button></div>`;
      document.body.append(viewer);
      $('#openMenuCards')?.addEventListener('click',()=>void openViewer());
      $('#menuViewerClose').addEventListener('click',()=>viewer.close());
      viewer.addEventListener('close',()=>{generation++;resetZoom();images.clear();$('#menuViewerImage').removeAttribute('src');$('#openMenuCards')?.focus();});
      viewer.addEventListener('click',e=>{if(e.target===viewer)viewer.close();});
      const move=delta=>{const next=viewIndex+delta;if(next<0 || next>=viewCards.length)return;viewIndex=next;void renderViewer();};
      $('#menuViewerPrevious').addEventListener('click',()=>move(-1));$('#menuViewerNext').addEventListener('click',()=>move(1));
      viewer.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){if(zoom===1){e.preventDefault();move(e.key==='ArrowLeft'?-1:1);}}});
      const toggleZoom=()=>{zoom=zoom===1?2.5:1;$('#menuViewerImage').style.width=`${100*zoom}%`;$('#menuViewerZoom').textContent=zoom===1?'Ampliar':'Restablecer';};
      $('#menuViewerZoom').addEventListener('click',toggleZoom);$('#menuViewerImage').addEventListener('dblclick',toggleZoom);
      // Solo consulta mientras el visor está abierto. No toca el sondeo de solicitudes.
      setInterval(()=>{if(viewer.open && ctx.getCurrentTable() && tableKey!==`${ctx.getCurrentTable().id}:${ctx.getCurrentTable().qr_code}`)viewer.close();},1000);
    }
  };
  return {init};
})();

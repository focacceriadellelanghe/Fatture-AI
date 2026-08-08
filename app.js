(() => {
  'use strict';

  const cfg = window.APP_CONFIG;
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const state = {
    session: null, user: null, profile: null, view: 'home', invoiceFilter: '',
    invoices: [], ingredients: [], notifications: [], settings: null,
    reviewInvoice: null, reviewRows: [], priceChart: null, pollingTimer: null
  };

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const num = v => v === null || v === undefined || v === '' ? null : Number(v);
  const money = v => num(v) === null ? '—' : new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:3}).format(Number(v));
  const decimal = (v,d=2) => num(v) === null ? '—' : new Intl.NumberFormat('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d}).format(Number(v));
  const dateIt = v => !v ? '—' : new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(v));
  const dateTimeIt = v => !v ? '—' : new Intl.DateTimeFormat('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v));
  const byId = (list,id) => list.find(x => String(x.id) === String(id));

  function toast(message, type='') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('#toastHost').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) { button.dataset.oldLabel = button.textContent; button.textContent = label || 'Attendere…'; button.disabled = true; }
    else { button.textContent = button.dataset.oldLabel || button.textContent; button.disabled = false; }
  }

  function statusClass(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'COMPLETATA') return 'done';
    if (s === 'DA_REVISIONARE') return 'ready';
    if (s === 'ERRORE_OCR' || s === 'DUPLICATA') return 'error';
    if (s === 'RICEVUTA' || s === 'ANALISI_IN_CORSO') return 'processing';
    return '';
  }

  function statusLabel(status) {
    return ({RICEVUTA:'Ricevuta',ANALISI_IN_CORSO:'In elaborazione',DA_REVISIONARE:'Da revisionare',COMPLETATA:'Completata',DUPLICATA:'Duplicata',ERRORE_OCR:'Errore OCR'})[status] || status || '—';
  }
  function rowStatusLabel(status){return ({DA_ASSOCIARE:'Da associare',SUGGERITO:'Suggerito',CONFERMATO:'Confermato',ESCLUSO:'Escluso'})[status]||status||'—'}

  async function api(action, payload={}) {
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes('INCOLLA_QUI')) throw new Error('URL Apps Script non configurato in config.js');
    const session = (await db.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error('Sessione scaduta. Accedi di nuovo.');
    const response = await fetch(cfg.APPS_SCRIPT_URL, {
      method: 'POST', redirect: 'follow', headers: {'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify({ action, accessToken: session.access_token, ...payload })
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('Risposta non valida dal backend Apps Script'); }
    if (!response.ok || data.success === false) throw new Error(data.error || data.message || `Errore HTTP ${response.status}`);
    return data;
  }

  async function loginGoogle() {
    $('#loginMessage').textContent = 'Reindirizzamento a Google…';
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: cfg.SITE_URL || window.location.href.split('#')[0].split('?')[0], queryParams: { prompt: 'select_account' } }
    });
    if (error) { $('#loginMessage').textContent = error.message; toast(error.message,'error'); }
  }

  async function bootstrap(session) {
    state.session = session || null;
    state.user = session?.user || null;
    if (!session) {
      $('#loginScreen').classList.remove('hidden'); $('#appShell').classList.add('hidden'); stopPolling(); return;
    }
    const { data: profile, error } = await db.from('profiles').select('id,email,role,active').eq('id',session.user.id).maybeSingle();
    if (error || !profile || profile.active === false) {
      await db.auth.signOut();
      $('#loginMessage').textContent = 'Questo account non è autorizzato.';
      toast('Account non autorizzato','error'); return;
    }
    state.profile = profile;
    const canManage=['owner','manager'].includes(String(profile.role));
    const canOperate=['owner','manager','operator'].includes(String(profile.role));
    $('#newIngredientBtn').classList.toggle('hidden', !canManage);
    $('#syncBtn').classList.toggle('hidden', !canManage);
    $('#saveSettingsBtn').classList.toggle('hidden', !canManage);
    $('#fcThreshold').disabled=!canManage; $('#mdcThreshold').disabled=!canManage;
    document.querySelectorAll('[data-nav="upload"]').forEach(el=>el.classList.toggle('hidden',!canOperate));
    $('#confirmAllBtn').classList.toggle('hidden',!canOperate); $('#finalizeBtn').classList.toggle('hidden',!canOperate);
    $('#loginScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden');
    $('#accountInfo').innerHTML = `<div><span>Email</span><strong>${esc(profile.email || session.user.email)}</strong></div><div><span>Ruolo</span><strong>${esc(profile.role)}</strong></div>`;
    $('#versionText').textContent = `${cfg.APP_NAME} ${cfg.APP_VERSION} · Supabase + Google Drive + Gemini`;
    await Promise.all([loadSettings(), loadHome(), loadIngredients(), loadNotifications()]);
    startPolling();
  }

  function navigate(view) {
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
    $$('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
    const titles = {home:'Fatture AI',invoices:'Fatture',upload:'Carica fatture',prices:'Prezzi',notifications:'Notifiche',settings:'Impostazioni'};
    $('#pageTitle').textContent = titles[view] || 'Fatture AI';
    if (view === 'invoices') loadInvoices();
    if (view === 'prices') renderPrices();
    if (view === 'notifications') renderNotifications();
    if (view === 'upload' && !$('#uploadBatches').children.length) addUploadBatch();
    window.scrollTo({top:0,behavior:'instant'});
  }

  async function loadHome() {
    const { data: statusData } = await db.from('app_status_view').select('*').maybeSingle();
    const s = statusData || {};
    $('#statusGrid').innerHTML = [
      ['Da elaborare',Number(s.received||0)+Number(s.processing||0),'processing'],
      ['Da revisionare',s.to_review||0,'ready'],
      ['Notifiche',s.unread_notifications||0,'notification'],
      ['Sync pendenti',s.pending_sync||0,'sync']
    ].map(([label,value])=>`<article class="status-card"><strong>${value}</strong><span>${label}</span></article>`).join('');
    const { data, error } = await db.from('invoice_list_view').select('*').order('received_at',{ascending:false}).limit(6);
    if (!error) { state.invoices = data || []; renderInvoiceCards($('#recentInvoices'), state.invoices); }
  }

  async function loadInvoices() {
    let q = db.from('invoice_list_view').select('*').order('received_at',{ascending:false}).limit(200);
    if (state.invoiceFilter) q = q.eq('status',state.invoiceFilter);
    const { data, error } = await q;
    if (error) return toast(error.message,'error');
    state.invoices = data || [];
    renderInvoiceCards($('#invoiceList'), state.invoices);
  }

  function renderInvoiceCards(host, rows) {
    host.innerHTML = rows.length ? rows.map(i => `
      <article class="list-card clickable" data-invoice-id="${esc(i.legacy_id)}">
        <div class="list-main"><div class="list-title">${esc(i.supplier_name)}</div>
          <div class="list-meta"><span>${dateIt(i.document_date)}</span><span>${esc(i.invoice_number||'Numero da verificare')}</span><span>${Number(i.pending_count||0)} pendenti</span></div>
        </div>
        <div><div class="amount">${money(i.gross_total)}</div><div class="status-pill ${statusClass(i.status)}">${statusLabel(i.status)}</div></div>
      </article>`).join('') : `<div class="empty">Nessuna fattura in questa sezione.</div>`;
    host.querySelectorAll('[data-invoice-id]').forEach(el => el.addEventListener('click',()=>openInvoice(el.dataset.invoiceId)));
  }

  async function openInvoice(legacyId) {
    const inv = state.invoices.find(i=>i.legacy_id===legacyId) || (await db.from('invoice_list_view').select('*').eq('legacy_id',legacyId).single()).data;
    if (!inv) return;
    if (inv.status === 'DA_REVISIONARE' || inv.status === 'ERRORE_OCR') return openReview(legacyId);
    if (inv.drive_url) window.open(inv.drive_url,'_blank','noopener');
    else toast(statusLabel(inv.status));
  }

  async function loadIngredients() {
    const { data, error } = await db.from('price_dashboard_view').select('*').order('name').limit(2000);
    if (error) return toast(error.message,'error');
    state.ingredients = data || [];
    const cats = [...new Set(state.ingredients.map(x=>x.category).filter(Boolean))].sort();
    $('#categoryFilter').innerHTML = '<option value="">Tutte le categorie</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join('');
    renderPrices();
  }

  function renderPrices() {
    const q = ($('#priceSearch').value || '').trim().toLowerCase();
    const cat = $('#categoryFilter').value;
    const rows = state.ingredients.filter(i => (!q || `${i.name} ${i.category} ${i.subcategory}`.toLowerCase().includes(q)) && (!cat || i.category===cat));
    $('#priceList').innerHTML = rows.length ? rows.map(i=>`<article class="list-card clickable" data-ingredient-id="${i.id}"><div class="list-main"><div class="list-title">${esc(i.name)}</div><div class="list-meta"><span>${esc(i.category||'')}</span><span>${esc(i.supplier_name||'')}</span><span>${Number(i.history_count||0)} rilevazioni</span></div></div><div class="price-current">${money(i.current_price)}<div class="small muted">${esc(i.tracking_unit||'')}</div></div></article>`).join('') : '<div class="empty">Nessun ingrediente trovato.</div>';
    $('#priceList').querySelectorAll('[data-ingredient-id]').forEach(el=>el.addEventListener('click',()=>openPrice(el.dataset.ingredientId)));
  }

  async function openPrice(id) {
    const ingredient = byId(state.ingredients,id);
    if (!ingredient) return;
    $('#priceModalName').textContent = ingredient.name;
    $('#priceModalCategory').textContent = [ingredient.category,ingredient.subcategory].filter(Boolean).join(' · ');
    $('#priceModal').classList.remove('hidden'); document.body.style.overflow='hidden';
    const { data, error } = await db.from('price_history').select('document_date,unit_price,previous_unit_price,change_percent,description,supplier_id,created_at').eq('ingredient_id',id).eq('status','ATTIVO').order('document_date',{ascending:true}).order('created_at',{ascending:true}).limit(500);
    if (error) return toast(error.message,'error');
    const hist = data || [];
    $('#priceModalBody').innerHTML = `
      <div class="price-kpis"><div class="price-kpi"><small>Prezzo attuale</small><strong>${money(ingredient.current_price)} ${esc(ingredient.tracking_unit||'')}</strong></div><div class="price-kpi"><small>Prezzo medio</small><strong>${money(ingredient.avg_price)}</strong></div><div class="price-kpi"><small>Minimo storico</small><strong>${money(ingredient.historical_min)}</strong></div><div class="price-kpi"><small>Massimo storico</small><strong>${money(ingredient.historical_max)}</strong></div></div>
      <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
      <h3 class="history-title">Storico acquisti</h3>
      <div>${hist.slice().reverse().map(h=>`<div class="history-row"><div><div>${dateIt(h.document_date)}</div><div class="small muted">${esc(h.description||'')}</div></div><div><strong>${money(h.unit_price)}</strong><div class="small ${Number(h.change_percent)>0?'':'muted'}">${num(h.change_percent)===null?'':`${Number(h.change_percent)>0?'+':''}${decimal(h.change_percent,2)}%`}</div></div></div>`).join('') || '<div class="empty">Nessuno storico disponibile.</div>'}</div>`;
    if (state.priceChart) state.priceChart.destroy();
    const canvas = $('#priceChart');
    state.priceChart = new Chart(canvas,{type:'line',data:{labels:hist.map(h=>dateIt(h.document_date)),datasets:[{label:'Prezzo',data:hist.map(h=>Number(h.unit_price)),borderColor:'#dfa145',backgroundColor:'rgba(223,161,69,.12)',fill:true,tension:.28,pointRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#8e8985',maxRotation:0,autoSkip:true,maxTicksLimit:6},grid:{display:false}},y:{ticks:{color:'#8e8985',callback:v=>`${v} €`},grid:{color:'rgba(255,255,255,.06)'}}}}});
  }

  function closePrice() { $('#priceModal').classList.add('hidden'); document.body.style.overflow=''; if(state.priceChart){state.priceChart.destroy();state.priceChart=null;} }

  async function loadNotifications() {
    const { data, error } = await db.from('notifications').select('*').order('created_at',{ascending:false}).limit(200);
    if (error) return;
    state.notifications = data || [];
    const unread = state.notifications.filter(n=>String(n.status)==='DA_LEGGERE').length;
    $('#notificationBadge').textContent = unread;
    $('#notificationBadge').classList.toggle('hidden',!unread);
    renderNotifications();
  }

  function renderNotifications() {
    $('#notificationList').innerHTML = state.notifications.length ? state.notifications.map(n=>`<article class="list-card notification-card ${n.status==='DA_LEGGERE'?'':'read'}" data-notification-id="${n.id}"><span class="notification-dot"></span><div class="list-main"><div class="list-title">${esc(n.title)}</div><div class="list-meta"><span>${dateTimeIt(n.created_at)}</span><span>${esc(n.type)}</span></div><p class="small muted">${esc(n.body||'')}</p></div></article>`).join('') : '<div class="empty">Nessuna notifica.</div>';
    $('#notificationList').querySelectorAll('[data-notification-id]').forEach(el=>el.addEventListener('click',()=>readNotification(el.dataset.notificationId,true)));
  }

  async function readNotification(id, openTarget=false) {
    const n = state.notifications.find(x=>x.id===id);
    if (!n) return;
    if (n.status==='DA_LEGGERE') {
      const { error } = await db.from('notifications').update({status:'LETTA',read_at:new Date().toISOString()}).eq('id',id);
      if (!error) { n.status='LETTA'; renderNotifications(); loadNotifications(); }
    }
    if (openTarget && n.target_view==='review' && n.target_id) openReview(n.target_id);
    if (openTarget && n.target_view==='prices' && n.ingredient_id) openPrice(n.ingredient_id);
    else if (openTarget && n.target_view==='prices') navigate('prices');
    if (openTarget && n.target_view==='invoices') navigate('invoices');
  }

  async function markAllRead() {
    const ids = state.notifications.filter(n=>n.status==='DA_LEGGERE').map(n=>n.id);
    if (!ids.length) return;
    const { error } = await db.from('notifications').update({status:'LETTA',read_at:new Date().toISOString()}).in('id',ids);
    if (error) toast(error.message,'error'); else loadNotifications();
  }

  async function loadSettings() {
    const { data, error } = await db.from('app_settings').select('*').eq('id',1).maybeSingle();
    if (error) return;
    state.settings = data;
    $('#fcThreshold').value = Number(data?.food_cost_threshold_points ?? .5);
    $('#mdcThreshold').value = Number(data?.mdc_threshold_points ?? .5);
  }

  async function saveSettings() {
    const fc = Number($('#fcThreshold').value), mdc = Number($('#mdcThreshold').value);
    if (!Number.isFinite(fc)||fc<0||!Number.isFinite(mdc)||mdc<0) return toast('Soglie non valide','error');
    const btn=$('#saveSettingsBtn'); setBusy(btn,true,'Salvataggio…');
    try { await api('update_settings',{foodCostThresholdPoints:fc,mdcThresholdPoints:mdc}); toast('Impostazioni salvate','success'); await loadSettings(); }
    catch(e){toast(e.message,'error')} finally{setBusy(btn,false)}
  }

  function uploadFileKey(file) {
    return [file.name, file.size, file.lastModified, file.type].join('::');
  }

  function addUploadBatch() {
    const frag = $('#uploadBatchTemplate').content.cloneNode(true);
    const card = frag.querySelector('.upload-batch');
    const input = card.querySelector('.batch-files');

    card._selectedFiles = [];

    input.addEventListener('change', event => {
      const incoming = Array.from(event.target.files || []);
      if (!incoming.length) return;

      const current = Array.isArray(card._selectedFiles) ? card._selectedFiles : [];
      const currentHasPdf = current.some(file => (file.type || guessMime(file.name)) === 'application/pdf');
      const incomingHasPdf = incoming.some(file => (file.type || guessMime(file.name)) === 'application/pdf');

      if (currentHasPdf || (incomingHasPdf && (current.length > 0 || incoming.length > 1))) {
        toast('Un PDF deve essere caricato da solo. Per una fattura multipagina usa più foto.', 'error');
        return;
      }

      const merged = [...current];
      incoming.forEach(file => {
        const key = uploadFileKey(file);
        if (!merged.some(existing => uploadFileKey(existing) === key)) merged.push(file);
      });

      if (merged.length > cfg.MAX_FILES_PER_INVOICE) {
        toast(`Massimo ${cfg.MAX_FILES_PER_INVOICE} pagine per fattura.`, 'error');
        return;
      }

      let totalBytes = 0;
      for (const file of merged) {
        if (file.size > cfg.MAX_FILE_MB * 1024 * 1024) {
          toast(`${file.name} supera ${cfg.MAX_FILE_MB} MB.`, 'error');
          return;
        }
        totalBytes += file.size;
      }

      if (totalBytes > cfg.MAX_INVOICE_MB * 1024 * 1024) {
        toast(`La fattura supera ${cfg.MAX_INVOICE_MB} MB complessivi.`, 'error');
        return;
      }

      card._selectedFiles = merged;
      renderSelectedFiles(card);
    });

    card.querySelector('.remove-batch').addEventListener('click', () => {
      card.remove();
      renumberBatches();
    });

    $('#uploadBatches').appendChild(frag);
    renumberBatches();
  }

  function renumberBatches() {
    const cards = $$('#uploadBatches .upload-batch');
    cards.forEach((card, index) => {
      card.querySelector('.batch-number').textContent = index + 1;
      card.querySelector('.remove-batch').classList.toggle('hidden', cards.length === 1);
    });
  }

  function renderSelectedFiles(card) {
    const files = Array.isArray(card._selectedFiles) ? card._selectedFiles : [];
    const host = card.querySelector('.file-preview-list');

    host.innerHTML = files.map((file, index) => `
      <div class="file-preview" data-file-index="${index}">
        <div class="file-preview-main">
          <strong>Pagina ${index + 1}</strong>
          <span class="file-preview-name">${esc(file.name)}</span>
        </div>
        <span class="file-preview-size">${decimal(file.size / 1024 / 1024, 2)} MB</span>
        <button type="button" class="file-remove text-button" aria-label="Rimuovi pagina ${index + 1}">×</button>
      </div>
    `).join('');

    host.querySelectorAll('.file-remove').forEach(button => {
      button.addEventListener('click', () => {
        const row = button.closest('[data-file-index]');
        const index = Number(row.dataset.fileIndex);
        card._selectedFiles.splice(index, 1);
        renderSelectedFiles(card);
      });
    });
  }

  async function fileToBase64(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function validateBatch(card) {
    const files = Array.isArray(card._selectedFiles) ? card._selectedFiles : [];
    if (!files.length) throw new Error('Seleziona almeno un file per ogni fattura.');
    if (files.length > cfg.MAX_FILES_PER_INVOICE) throw new Error(`Massimo ${cfg.MAX_FILES_PER_INVOICE} pagine per fattura.`);
    if (files.length > 1 && files.some(file => (file.type || guessMime(file.name)) === 'application/pdf')) {
      throw new Error('Un PDF deve essere caricato da solo. Le fatture multipagina con più file devono contenere solo immagini.');
    }

    let totalBytes = 0;
    files.forEach(file => {
      if (file.size > cfg.MAX_FILE_MB * 1024 * 1024) throw new Error(`${file.name} supera ${cfg.MAX_FILE_MB} MB.`);
      totalBytes += file.size;
    });
    if (totalBytes > cfg.MAX_INVOICE_MB * 1024 * 1024) throw new Error(`Una fattura supera ${cfg.MAX_INVOICE_MB} MB complessivi.`);
    return files;
  }

  async function submitUploads() {
    const cards = $$('#uploadBatches .upload-batch');
    const btn = $('#submitUploadsBtn');
    try { cards.forEach(validateBatch); } catch (e) { return toast(e.message, 'error'); }

    setBusy(btn, true, 'Preparazione file…');
    $('#uploadProgress').classList.remove('hidden');
    let accepted = 0;

    try {
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const files = validateBatch(card);
        $('#uploadProgress').textContent = `Invio fattura ${i + 1} di ${cards.length}…`;
        const encoded = [];
        for (const file of files) {
          encoded.push({fileName:file.name,mimeType:file.type || guessMime(file.name),base64Data:await fileToBase64(file)});
        }
        await api('upload_invoice', {
          files:encoded,
          documentDate:card.querySelector('.batch-date').value,
          supplier:card.querySelector('.batch-supplier').value.trim(),
          invoiceNumber:card.querySelector('.batch-number-input').value.trim(),
          total:card.querySelector('.batch-total').value,
          clientTimestamp:new Date().toISOString()
        });
        accepted++;
      }

      $('#uploadProgress').textContent = `${accepted} fatture ricevute. L’elaborazione prosegue in background.`;
      toast(`${accepted} fatture ricevute`, 'success');
      $('#uploadBatches').innerHTML = '';
      addUploadBatch();
      await loadHome();
      navigate('invoices');
    } catch (e) {
      toast(e.message, 'error');
      $('#uploadProgress').textContent = `${accepted} fatture inviate prima dell’errore: ${e.message}`;
    } finally {
      setBusy(btn, false);
    }
  }

  function guessMime(name) {
    const ext = String(name).split('.').pop().toLowerCase();
    return ({pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'})[ext] || 'application/octet-stream';
  }

  async function openReview(legacyId) {
    $('#reviewDrawer').classList.remove('hidden'); document.body.style.overflow='hidden';
    $('#reviewTitle').textContent=legacyId; $('#reviewBody').innerHTML='<div class="empty">Caricamento…</div>';
    try {
      const result=await api('get_review',{invoiceId:legacyId});
      state.reviewInvoice=result.invoice; state.reviewRows=result.rows||[];
      $('#reviewTitle').textContent=`${result.invoice.supplier_name||'Fornitore'} · ${result.invoice.invoice_number||legacyId}`;
      renderReview();
    } catch(e){$('#reviewBody').innerHTML=`<div class="empty">${esc(e.message)}</div>`;toast(e.message,'error')}
  }

  function closeReview(){
    $('#reviewDrawer').classList.add('hidden');
    document.body.style.overflow='';
    state.reviewInvoice=null;
    state.reviewRows=[];
  }

  function ingredientOptions(selected){
    return `<option value="">— Seleziona ingrediente —</option>` + state.ingredients.map(i =>
      `<option value="${i.id}" ${String(i.id)===String(selected)?'selected':''}>${esc(i.name)} · ${esc(i.tracking_unit||'')}</option>`
    ).join('');
  }

  function trackingUnitOptions(selected){
    const units=['€/kg','€/l','€/pz','€/confezione'];
    const current=String(selected||'').trim();
    if(current && !units.includes(current)) units.push(current);
    return units.map(u=>`<option value="${esc(u)}" ${u===current?'selected':''}>${esc(u)}</option>`).join('');
  }

  function documentUnitCanonical(value){
    const raw=String(value||'').trim();
    const u=raw.toUpperCase().replace(/\s+/g,'');
    if(['PZ','PZ.','NR','PEZZO','PEZZI'].includes(u)) return 'PZ';
    if(['CONF','CONF.','CONFEZIONE','CONFEZIONI','CT','CARTONE','CARTONI'].includes(u)) return 'CONF';
    if(['KG','KGS','KILOGRAMMO','KILOGRAMMI'].includes(u)) return 'KG';
    if(['G','GR','GRAMMO','GRAMMI'].includes(u)) return 'G';
    if(['L','LT','LITRO','LITRI'].includes(u)) return 'L';
    if(['ML','MILLILITRO','MILLILITRI'].includes(u)) return 'ML';
    return raw || 'PZ';
  }

  function documentUnitLabel(value){
    const u=documentUnitCanonical(value);
    return ({PZ:'pz',CONF:'conf.',KG:'kg',G:'g',L:'l',ML:'ml'})[u] || u;
  }

  function documentPriceUnitLabel(value){
    const u=documentUnitCanonical(value);
    return ({PZ:'€/pz',CONF:'€/conf.',KG:'€/kg',G:'€/g',L:'€/l',ML:'€/ml'})[u] || `€/${u}`;
  }

  function documentUnitOptions(selected){
    const current=documentUnitCanonical(selected);
    const units=[['PZ','pz'],['CONF','conf.'],['KG','kg'],['G','g'],['L','l'],['ML','ml']];
    if(current && !units.some(x=>x[0]===current)) units.push([current,current]);
    return units.map(([value,label])=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`).join('');
  }

  function documentPriceUnitOptions(selected){
    const current=documentUnitCanonical(selected);
    const units=[['PZ','€/pz'],['CONF','€/conf.'],['KG','€/kg'],['G','€/g'],['L','€/l'],['ML','€/ml']];
    if(current && !units.some(x=>x[0]===current)) units.push([current,`€/${current}`]);
    return units.map(([value,label])=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`).join('');
  }

  function trackingBaseUnit(trackingUnit){
    return ({'€/kg':'kg','€/l':'l','€/pz':'pz','€/confezione':'conf.'})[String(trackingUnit||'').trim()] || '';
  }

  function preferredDisplayQuantity(baseQty,trackingUnit){
    const qty=Number(baseQty);
    if(!Number.isFinite(qty)) return {value:'',unit:trackingBaseUnit(trackingUnit)||'kg'};
    if(trackingUnit==='€/kg' && qty>0 && qty<1) return {value:Number((qty*1000).toFixed(6)),unit:'g'};
    if(trackingUnit==='€/l' && qty>0 && qty<1) return {value:Number((qty*1000).toFixed(6)),unit:'ml'};
    return {value:Number(qty.toFixed(6)),unit:trackingBaseUnit(trackingUnit)||'kg'};
  }

  function quantityDisplayUnitOptions(selected,trackingUnit){
    const base=trackingBaseUnit(trackingUnit);
    let units=[];
    if(base==='kg') units=['kg','g'];
    else if(base==='l') units=['l','ml'];
    else if(base==='pz') units=['pz'];
    else if(base==='conf.') units=['conf.'];
    else units=['kg','g','l','ml','pz','conf.'];
    const current=String(selected||'').trim();
    if(current && !units.includes(current)) units.push(current);
    return units.map(u=>`<option value="${esc(u)}" ${u===current?'selected':''}>${esc(u)}</option>`).join('');
  }

  function displayQtyToBase(value,displayUnit,trackingUnit){
    const qty=Number(value);
    if(!Number.isFinite(qty) || qty<=0) return null;
    if(trackingUnit==='€/kg') {
      if(displayUnit==='kg') return qty;
      if(displayUnit==='g') return qty/1000;
      return null;
    }
    if(trackingUnit==='€/l') {
      if(displayUnit==='l') return qty;
      if(displayUnit==='ml') return qty/1000;
      return null;
    }
    if(trackingUnit==='€/pz') return displayUnit==='pz' ? qty : null;
    if(trackingUnit==='€/confezione') return displayUnit==='conf.' ? qty : null;
    return null;
  }

  function baseQtyToDisplay(baseQty,displayUnit,trackingUnit){
    const qty=Number(baseQty);
    if(!Number.isFinite(qty)) return null;
    if(trackingUnit==='€/kg') return displayUnit==='g' ? qty*1000 : displayUnit==='kg' ? qty : null;
    if(trackingUnit==='€/l') return displayUnit==='ml' ? qty*1000 : displayUnit==='l' ? qty : null;
    if(trackingUnit==='€/pz') return displayUnit==='pz' ? qty : null;
    if(trackingUnit==='€/confezione') return displayUnit==='conf.' ? qty : null;
    return null;
  }

  function reviewField(label,inner,wide=''){
    return `<label class="review-field ${wide}"><span>${label}</span>${inner}</label>`;
  }

  function renderReview(){
    const host=$('#reviewBody');
    const canOperate=['owner','manager','operator'].includes(String(state.profile?.role));
    const canManage=['owner','manager'].includes(String(state.profile?.role));
    const confirmed=state.reviewRows.filter(r=>r.status==='CONFERMATO').length;
    const excluded=state.reviewRows.filter(r=>r.status==='ESCLUSO').length;
    const pending=state.reviewRows.length-confirmed-excluded;

    const summary=`
      <div class="review-summary-v2">
        <div class="review-count"><small>Righe</small><strong>${state.reviewRows.length}</strong></div>
        <div class="review-count"><small>Confermate</small><strong>${confirmed}</strong></div>
        <div class="review-count"><small>Da controllare</small><strong>${pending}</strong></div>
        <div class="review-count"><small>Escluse</small><strong>${excluded}</strong></div>
      </div>`;

    const rowsHtml=state.reviewRows.map(r=>{
      const displayQty=preferredDisplayQuantity(r.normalized_quantity,r.tracking_unit);
      const price=(Number(r.normalized_quantity)>0 && Number.isFinite(Number(r.net_amount))) ? Number(r.net_amount)/Number(r.normalized_quantity) : null;
      const statusClassName=r.status==='CONFERMATO'?'confirmed':r.status==='ESCLUSO'?'excluded':'';
      const statusPill=r.status==='CONFERMATO'?'done':r.status==='SUGGERITO'?'ready':r.status==='ESCLUSO'?'error':'processing';
      const disabled=canOperate?'':'disabled';

      return `<article class="review-row review-row-v2 ${statusClassName}" data-row-id="${r.legacy_id}">
        <div class="row-head review-row-head-v2">
          <div class="review-row-heading-main">
            <div class="row-desc">${esc(r.description_raw)}</div>
            <div class="row-code">${esc(r.item_code||'Nessun codice')} · riga ${r.line_number||'—'}</div>
          </div>
          <div class="row-state"><span class="status-pill ${statusPill}">${rowStatusLabel(r.status)}</span><div class="confidence">${Number(r.confidence||0)}%</div></div>
        </div>

        <div class="review-section-title">Dati letti dalla fattura</div>
        <div class="review-field-grid">
          ${reviewField('Imponibile riga',`<div class="review-input-combo review-money"><input class="net-amount" type="number" step="0.0001" min="0" value="${r.net_amount??''}" ${disabled}><span>€</span></div>`)}
          ${reviewField('Sconto',`<div class="review-input-combo review-money"><input class="discount-percent" type="number" step="0.01" min="0" value="${r.discount_percent??''}" placeholder="—" ${disabled}><span>%</span></div>`)}
          ${reviewField('IVA',`<div class="review-input-combo review-money"><input class="vat-rate" type="number" step="0.01" min="0" value="${r.vat_rate??''}" ${disabled}><span>%</span></div>`)}
          ${reviewField('Q.tà fattura',`<div class="review-input-combo"><input class="document-quantity" type="number" step="0.001" min="0" value="${r.document_quantity??''}" ${disabled}><select class="document-unit" ${disabled}>${documentUnitOptions(r.document_unit)}</select></div>`)}
          ${reviewField('Prezzo unitario in fattura',`<div class="review-input-combo"><input class="document-unit-price" type="number" step="0.0001" min="0" value="${r.document_unit_price??''}" ${disabled}><select class="document-price-unit" ${disabled}>${documentPriceUnitOptions(r.document_unit)}</select></div>`,'wide')}
        </div>

        <div class="review-section-title">Conversione per Food Cost</div>
        <div class="review-field-grid">
          ${reviewField('Ingrediente',`<select class="ingredient-select" ${disabled}>${ingredientOptions(r.ingredient_id)}</select>`,'wide')}
          ${reviewField('Quantità tracciata',`<div class="review-input-combo"><input class="normalized-qty-display" type="number" step="0.001" min="0" value="${displayQty.value}" ${disabled}><select class="normalized-qty-unit" ${disabled}>${quantityDisplayUnitOptions(displayQty.unit,r.tracking_unit)}</select></div>`)}
          ${reviewField('Unità da tracciare',`<select class="tracking-unit" ${disabled}>${trackingUnitOptions(r.tracking_unit)}</select>`)}
          ${reviewField('Prezzo da tracciare',`<div class="review-input-combo review-tracked-price"><input class="tracked-price" type="number" step="0.000001" min="0" value="${price===null?'':Number(price.toFixed(6))}" ${disabled}><select class="tracked-price-unit" ${disabled}>${trackingUnitOptions(r.tracking_unit)}</select></div><small class="tracked-price-note"></small>`,'wide calculated')}
        </div>

        ${canManage?'<button type="button" class="text-button row-new-ingredient">+ Nuovo ingrediente</button>':''}
        <div class="row-actions review-row-actions-v2 ${canOperate?'':'hidden'}">
          <button class="primary-button confirm-row">Conferma</button>
          <button class="danger-button exclude-row">Escludi</button>
        </div>
      </article>`;
    }).join('') || '<div class="empty">Nessuna riga estratta.</div>';

    const finalActions=canOperate?`
      <div class="review-final-actions">
        <button id="confirmAllInlineBtn" class="secondary-button">Conferma suggerimenti validi</button>
        <button id="finalizeInlineBtn" class="primary-button">Finalizza fattura</button>
      </div>`:'';

    host.innerHTML=summary+rowsHtml+finalActions;

    host.querySelectorAll('.review-row').forEach(card=>bindReviewRow(card,canOperate,canManage));
    const confirmAllInline=$('#confirmAllInlineBtn');
    const finalizeInline=$('#finalizeInlineBtn');
    if(confirmAllInline) confirmAllInline.onclick=confirmAll;
    if(finalizeInline) finalizeInline.onclick=finalizeInvoice;
  }

  function bindReviewRow(card,canOperate,canManage){
    const rowId=card.dataset.rowId;
    const ingredientSelect=card.querySelector('.ingredient-select');
    const trackingSelect=card.querySelector('.tracking-unit');
    const trackedPriceUnit=card.querySelector('.tracked-price-unit');
    const qtyInput=card.querySelector('.normalized-qty-display');
    const qtyUnit=card.querySelector('.normalized-qty-unit');
    const netInput=card.querySelector('.net-amount');
    const trackedPrice=card.querySelector('.tracked-price');
    const docUnit=card.querySelector('.document-unit');
    const docPriceUnit=card.querySelector('.document-price-unit');

    function syncDocumentUnits(source){
      if(source==='qty') docPriceUnit.value=docUnit.value;
      else docUnit.value=docPriceUnit.value;
    }

    function recalcTrackedPrice(){
      const net=Number(netInput.value);
      const baseQty=displayQtyToBase(qtyInput.value,qtyUnit.value,trackingSelect.value);
      trackedPriceUnit.value=trackingSelect.value;
      if(!Number.isFinite(net) || net<0 || !baseQty){
        trackedPrice.value='';
        const note=card.querySelector('.tracked-price-note');
        if(note) note.textContent='Controlla quantità e unità di tracciamento.';
        return;
      }
      const price=net/baseQty;
      trackedPrice.value=Number(price.toFixed(6));
      const note=card.querySelector('.tracked-price-note');
      if(note) note.textContent=`${decimal(net,2)} € ÷ ${decimal(baseQty,3)} ${trackingBaseUnit(trackingSelect.value)} = ${decimal(price,3)} ${trackingSelect.value}`;
    }

    function resetQtyUnitForTracking(){
      const oldBase=displayQtyToBase(qtyInput.value,qtyUnit.value,trackingSelect.value);
      const preferred=preferredDisplayQuantity(oldBase,trackingSelect.value);
      qtyUnit.innerHTML=quantityDisplayUnitOptions(preferred.unit,trackingSelect.value);
      if(preferred.value!=='' && Number.isFinite(Number(preferred.value))) qtyInput.value=preferred.value;
      trackedPriceUnit.value=trackingSelect.value;
      recalcTrackedPrice();
    }

    if(canOperate){
      docUnit.addEventListener('change',()=>syncDocumentUnits('qty'));
      docPriceUnit.addEventListener('change',()=>syncDocumentUnits('price'));
      netInput.addEventListener('input',recalcTrackedPrice);
      qtyInput.addEventListener('input',recalcTrackedPrice);
      qtyUnit.addEventListener('change',recalcTrackedPrice);
      trackingSelect.addEventListener('change',()=>{
        const newUnit=trackingSelect.value;
        const base=trackingBaseUnit(newUnit);
        const currentBase=displayQtyToBase(qtyInput.value,qtyUnit.value,newUnit);
        const preferred=preferredDisplayQuantity(currentBase,newUnit);
        qtyUnit.innerHTML=quantityDisplayUnitOptions(preferred.unit || base,newUnit);
        if(preferred.value!=='') qtyInput.value=preferred.value;
        trackedPriceUnit.value=newUnit;
        recalcTrackedPrice();
      });
      trackedPriceUnit.addEventListener('change',()=>{
        trackingSelect.value=trackedPriceUnit.value;
        const preferred=preferredDisplayQuantity(null,trackingSelect.value);
        qtyUnit.innerHTML=quantityDisplayUnitOptions(preferred.unit,trackingSelect.value);
        recalcTrackedPrice();
      });
      trackedPrice.addEventListener('change',()=>{
        const net=Number(netInput.value),price=Number(trackedPrice.value);
        if(!Number.isFinite(net)||net<0||!Number.isFinite(price)||price<=0) return;
        const baseQty=net/price;
        let display=baseQtyToDisplay(baseQty,qtyUnit.value,trackingSelect.value);
        if(display===null){
          const preferred=preferredDisplayQuantity(baseQty,trackingSelect.value);
          qtyUnit.innerHTML=quantityDisplayUnitOptions(preferred.unit,trackingSelect.value);
          qtyUnit.value=preferred.unit;
          display=preferred.value;
        }
        qtyInput.value=Number(Number(display).toFixed(6));
        recalcTrackedPrice();
      });
      ingredientSelect.addEventListener('change',()=>{
        const ingredient=state.ingredients.find(i=>String(i.id)===String(ingredientSelect.value));
        if(ingredient?.tracking_unit){
          trackingSelect.value=ingredient.tracking_unit;
          trackedPriceUnit.value=ingredient.tracking_unit;
          const base=trackingBaseUnit(ingredient.tracking_unit);
          qtyUnit.innerHTML=quantityDisplayUnitOptions(base,ingredient.tracking_unit);
          qtyUnit.value=base;
          recalcTrackedPrice();
        }
      });

      const confirm=card.querySelector('.confirm-row');
      const exclude=card.querySelector('.exclude-row');
      if(confirm) confirm.onclick=()=>confirmReviewRow(card,rowId);
      if(exclude) exclude.onclick=()=>excludeReviewRow(rowId);
    }

    if(canManage){
      const newIngredient=card.querySelector('.row-new-ingredient');
      if(newIngredient) newIngredient.onclick=()=>createIngredientFromReview(card,newIngredient);
    }

    syncDocumentUnits('qty');
    recalcTrackedPrice();
  }

  function reviewPayloadFromCard(card,rowId){
    const ingredientId=card.querySelector('.ingredient-select').value;
    const trackingUnit=card.querySelector('.tracking-unit').value;
    const qtyDisplay=card.querySelector('.normalized-qty-display').value;
    const qtyDisplayUnit=card.querySelector('.normalized-qty-unit').value;
    const normalizedQuantity=displayQtyToBase(qtyDisplay,qtyDisplayUnit,trackingUnit);
    const netAmount=card.querySelector('.net-amount').value;
    const documentQuantity=card.querySelector('.document-quantity').value;
    const documentUnit=card.querySelector('.document-unit').value;
    const documentUnitPrice=card.querySelector('.document-unit-price').value;
    const discountPercent=card.querySelector('.discount-percent').value;
    const vatRate=card.querySelector('.vat-rate').value;

    if(!ingredientId) throw new Error('Seleziona un ingrediente');
    if(!trackingUnit || normalizedQuantity===null || normalizedQuantity<=0) throw new Error('Controlla quantità e unità da tracciare');
    if(netAmount==='' || !Number.isFinite(Number(netAmount)) || Number(netAmount)<0) throw new Error('Controlla imponibile riga');

    return {
      rowId,
      ingredientId,
      normalizedQuantity,
      trackingUnit,
      netAmount:Number(netAmount),
      documentQuantity:documentQuantity===''?null:Number(documentQuantity),
      documentUnit:documentUnit||null,
      documentUnitPrice:documentUnitPrice===''?null:Number(documentUnitPrice),
      discountPercent:discountPercent===''?null:Number(discountPercent),
      vatRate:vatRate===''?null:Number(vatRate)
    };
  }

  async function confirmReviewRow(card,rowId,options={}){
    const button=card.querySelector('.confirm-row');
    if(!options.silent) setBusy(button,true,'Conferma…');
    try{
      const payload=reviewPayloadFromCard(card,rowId);
      const result=await api('confirm_row',payload);
      const index=state.reviewRows.findIndex(r=>r.legacy_id===rowId);
      if(index>=0 && result.row) state.reviewRows[index]=result.row;
      if(!options.silent){
        toast('Riga confermata','success');
        renderReview();
      }
      return true;
    }catch(e){
      if(!options.silent) toast(e.message,'error');
      else throw e;
      return false;
    }finally{
      if(!options.silent) setBusy(button,false);
    }
  }

  async function createIngredientFromReview(card,button){
    const name=window.prompt('Nome del nuovo ingrediente');
    if(!name||!name.trim())return;
    const suggestedUnit=card?.querySelector('.tracking-unit')?.value || '€/kg';
    const unit=window.prompt('Unità di confronto: €/kg, €/l, €/pz oppure €/confezione',suggestedUnit);
    if(!unit||!unit.trim())return;
    const category=window.prompt('Categoria (facoltativa)','')||'';
    const subcategory=window.prompt('Sottocategoria (facoltativa)','')||'';
    setBusy(button,true,'Creazione…');
    try{
      const result=await api('create_ingredient',{name:name.trim(),trackingUnit:unit.trim(),category:category.trim(),subcategory:subcategory.trim()});
      if(result.ingredient){
        state.ingredients.push(result.ingredient);
        state.ingredients.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'it'));
        if(card){
          const select=card.querySelector('.ingredient-select');
          select.innerHTML=ingredientOptions(result.ingredient.id);
          select.value=result.ingredient.id;
          const tracking=card.querySelector('.tracking-unit');
          const priceUnit=card.querySelector('.tracked-price-unit');
          if(result.ingredient.tracking_unit){
            tracking.value=result.ingredient.tracking_unit;
            priceUnit.value=result.ingredient.tracking_unit;
            tracking.dispatchEvent(new Event('change'));
          }
        }
      }
      toast(`Ingrediente ${result.ingredient?.name||name.trim()} creato`,'success');
    }catch(e){toast(e.message,'error')}
    finally{setBusy(button,false)}
  }

  async function excludeReviewRow(rowId){try{const result=await api('exclude_row',{rowId});const index=state.reviewRows.findIndex(r=>r.legacy_id===rowId);if(index>=0&&result.row)state.reviewRows[index]=result.row;renderReview();toast('Riga esclusa','success')}catch(e){toast(e.message,'error')}}
  async function confirmAll(){
    const btn=$('#confirmAllInlineBtn') || $('#confirmAllBtn');
    setBusy(btn,true,'Conferma…');
    let confirmed=0;
    try{
      const cards=Array.from($('#reviewBody').querySelectorAll('.review-row'));
      for(const card of cards){
        const rowId=card.dataset.rowId;
        const row=state.reviewRows.find(r=>r.legacy_id===rowId);
        if(!row || row.status!=='SUGGERITO') continue;
        const ingredientId=card.querySelector('.ingredient-select')?.value;
        if(!ingredientId) continue;
        const payload=reviewPayloadFromCard(card,rowId);
        const result=await api('confirm_row',payload);
        const index=state.reviewRows.findIndex(r=>r.legacy_id===rowId);
        if(index>=0 && result.row) state.reviewRows[index]=result.row;
        confirmed++;
      }
      toast(`${confirmed} righe confermate`,'success');
      renderReview();
    }catch(e){toast(e.message,'error')}
    finally{setBusy(btn,false)}
  }
  async function finalizeInvoice(){
    const btn=$('#finalizeInlineBtn') || $('#finalizeBtn');
    setBusy(btn,true,'Finalizzazione…');
    try{
      const r=await api('finalize_invoice',{invoiceId:state.reviewInvoice.legacy_id});
      toast(r.duplicate?'Fattura duplicata bloccata':'Fattura finalizzata','success');
      closeReview();
      await Promise.all([loadHome(),loadInvoices(),loadIngredients(),loadNotifications()]);
    }catch(e){toast(e.message,'error')}
    finally{setBusy(btn,false)}
  }

  async function syncNow(){const btn=$('#syncBtn');setBusy(btn,true,'…');try{const r=await api('sync_now');const count=r.ingredients&&typeof r.ingredients==='object'?Number(r.ingredients.updated||0):Number(r.ingredients||0);toast(`Sincronizzazione completata: ${count} ingredienti`,'success');await Promise.all([loadHome(),loadIngredients(),loadNotifications()])}catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}}

  function startPolling(){stopPolling();state.pollingTimer=setInterval(async()=>{if(document.visibilityState!=='visible')return;await Promise.all([loadHome(),loadNotifications()]);if(state.view==='invoices')loadInvoices();},30000)}
  function stopPolling(){if(state.pollingTimer){clearInterval(state.pollingTimer);state.pollingTimer=null}}

  function bindEvents(){
    $('#googleLoginBtn').onclick=loginGoogle;
    $$('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
    $('#notificationBtn').onclick=()=>navigate('notifications'); $('#syncBtn').onclick=syncNow;
    $('#addBatchBtn').onclick=addUploadBatch; $('#submitUploadsBtn').onclick=submitUploads;
    $('#priceSearch').oninput=renderPrices; $('#categoryFilter').onchange=renderPrices;
    $('#priceCloseBtn').onclick=closePrice; $('#priceBackBtn').onclick=closePrice;
    $('#reviewCloseBtn').onclick=closeReview; $('#reviewBackBtn').onclick=closeReview;
    $('#newIngredientBtn').onclick=()=>createIngredientFromReview(null,$('#newIngredientBtn')); $('#confirmAllBtn').onclick=confirmAll; $('#finalizeBtn').onclick=finalizeInvoice;
    $('#markAllReadBtn').onclick=markAllRead; $('#saveSettingsBtn').onclick=saveSettings;
    $('#logoutBtn').onclick=async()=>{await db.auth.signOut();};
    $('#invoiceFilters').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('#invoiceFilters').querySelectorAll('button').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.invoiceFilter=b.dataset.status;loadInvoices()});
    $('#priceModal').addEventListener('click',e=>{if(e.target===$('#priceModal'))closePrice()});
    window.addEventListener('online',()=>toast('Connessione ripristinata','success'));
  }

  bindEvents();
  db.auth.onAuthStateChange((_event,session)=>setTimeout(()=>bootstrap(session),0));
  db.auth.getSession().then(({data})=>bootstrap(data.session));
  if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
})();

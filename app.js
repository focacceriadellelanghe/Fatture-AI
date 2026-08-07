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

      const current = Array.isArray(card._selectedFiles)
        ? card._selectedFiles
        : [];

      const currentHasPdf = current.some(file =>
        (file.type || guessMime(file.name)) === 'application/pdf'
      );

      const incomingHasPdf = incoming.some(file =>
        (file.type || guessMime(file.name)) === 'application/pdf'
      );

      if (
        currentHasPdf ||
        (incomingHasPdf && (current.length > 0 || incoming.length > 1))
      ) {
        toast(
          'Un PDF deve essere caricato da solo. Per una fattura multipagina usa più foto.',
          'error'
        );
        return;
      }

      const merged = [...current];

      incoming.forEach(file => {
        const key = uploadFileKey(file);

        const alreadyPresent = merged.some(existing =>
          uploadFileKey(existing) === key
        );

        if (!alreadyPresent) {
          merged.push(file);
        }
      });

      if (merged.length > cfg.MAX_FILES_PER_INVOICE) {
        toast(
          `Massimo ${cfg.MAX_FILES_PER_INVOICE} pagine per fattura.`,
          'error'
        );
        return;
      }

      let totalBytes = 0;

      for (const file of merged) {
        if (file.size > cfg.MAX_FILE_MB * 1024 * 1024) {
          toast(
            `${file.name} supera ${cfg.MAX_FILE_MB} MB.`,
            'error'
          );
          return;
        }

        totalBytes += file.size;
      }

      if (totalBytes > cfg.MAX_INVOICE_MB * 1024 * 1024) {
        toast(
          `La fattura supera ${cfg.MAX_INVOICE_MB} MB complessivi.`,
          'error'
        );
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

      card
        .querySelector('.remove-batch')
        .classList.toggle(
          'hidden',
          cards.length === 1
        );
    });
  }

  function renderSelectedFiles(card) {
    const files = Array.isArray(card._selectedFiles)
      ? card._selectedFiles
      : [];

    const host = card.querySelector('.file-preview-list');

    host.innerHTML = files.map((file, index) => `
      <div class="file-preview" data-file-index="${index}">
        <div class="file-preview-main">
          <strong>Pagina ${index + 1}</strong>
          <span class="file-preview-name">${esc(file.name)}</span>
        </div>

        <span class="file-preview-size">
          ${decimal(file.size / 1024 / 1024, 2)} MB
        </span>

        <button
          type="button"
          class="file-remove text-button"
          aria-label="Rimuovi pagina ${index + 1}">
          ×
        </button>
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

      reader.onload = () => {
        resolve(String(reader.result).split(',')[1]);
      };

      reader.onerror = () => {
        reject(reader.error);
      };

      reader.readAsDataURL(file);
    });
  }

  function validateBatch(card) {
    const files = Array.isArray(card._selectedFiles)
      ? card._selectedFiles
      : [];

    if (!files.length) {
      throw new Error(
        'Seleziona almeno un file per ogni fattura.'
      );
    }

    if (files.length > cfg.MAX_FILES_PER_INVOICE) {
      throw new Error(
        `Massimo ${cfg.MAX_FILES_PER_INVOICE} pagine per fattura.`
      );
    }

    if (
      files.length > 1 &&
      files.some(file =>
        (file.type || guessMime(file.name)) === 'application/pdf'
      )
    ) {
      throw new Error(
        'Un PDF deve essere caricato da solo. Le fatture multipagina con più file devono contenere solo immagini.'
      );
    }

    let totalBytes = 0;

    files.forEach(file => {
      if (file.size > cfg.MAX_FILE_MB * 1024 * 1024) {
        throw new Error(
          `${file.name} supera ${cfg.MAX_FILE_MB} MB.`
        );
      }

      totalBytes += file.size;
    });

    if (totalBytes > cfg.MAX_INVOICE_MB * 1024 * 1024) {
      throw new Error(
        `Una fattura supera ${cfg.MAX_INVOICE_MB} MB complessivi.`
      );
    }

    return files;
  }

  async function submitUploads() {
    const cards = $$('#uploadBatches .upload-batch');
    const btn = $('#submitUploadsBtn');

    try {
      cards.forEach(validateBatch);
    } catch (e) {
      return toast(e.message, 'error');
    }

    setBusy(btn, true, 'Preparazione file…');

    $('#uploadProgress').classList.remove('hidden');

    let accepted = 0;

    try {
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const files = validateBatch(card);

        $('#uploadProgress').textContent =
          `Invio fattura ${i + 1} di ${cards.length}…`;

        const encoded = [];

        for (const file of files) {
          encoded.push({
            fileName: file.name,
            mimeType: file.type || guessMime(file.name),
            base64Data: await fileToBase64(file)
          });
        }

        await api('upload_invoice', {
          files: encoded,
          documentDate: card.querySelector('.batch-date').value,
          supplier: card.querySelector('.batch-supplier').value.trim(),
          invoiceNumber: card.querySelector('.batch-number-input').value.trim(),
          total: card.querySelector('.batch-total').value,
          clientTimestamp: new Date().toISOString()
        });

        accepted++;
      }

      $('#uploadProgress').textContent =
        `${accepted} fatture ricevute. L’elaborazione prosegue in background.`;

      toast(
        `${accepted} fatture ricevute`,
        'success'
      );

      $('#uploadBatches').innerHTML = '';

      addUploadBatch();

      await loadHome();

      navigate('invoices');

    } catch (e) {
      toast(e.message, 'error');

      $('#uploadProgress').textContent =
        `${accepted} fatture inviate prima dell’errore: ${e.message}`;

    } finally {
      setBusy(btn, false);
    }
  }

  function guessMime(name) {
    const ext = String(name)
      .split('.')
      .pop()
      .toLowerCase();

    return ({
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heic: 'image/heic',
      heif: 'image/heif'
    })[ext] || 'application/octet-stream';
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

  function closeReview(){ $('#reviewDrawer').classList.add('hidden'); document.body.style.overflow=''; state.reviewInvoice=null;state.reviewRows=[]; }

  function ingredientOptions(selected){return `<option value="">— Seleziona ingrediente —</option>`+state.ingredients.map(i=>`<option value="${i.id}" ${i.id===selected?'selected':''}>${esc(i.name)} · ${esc(i.tracking_unit||'')}</option>`).join('')}
  function trackingUnitOptions(selected){
    const units=['€/kg','€/l','€/pz','€/confezione'];
    const current=String(selected||'').trim();
    if(current&&!units.includes(current))units.push(current);
    return units.map(u=>`<option value="${esc(u)}" ${u===current?'selected':''}>${esc(u)}</option>`).join('');
  }

  function renderReview(){
    const host=$('#reviewBody');
    const canOperate=['owner','manager','operator'].includes(String(state.profile?.role));
    const confirmed=state.reviewRows.filter(r=>r.status==='CONFERMATO').length,excluded=state.reviewRows.filter(r=>r.status==='ESCLUSO').length,pending=state.reviewRows.length-confirmed-excluded;
    const summary=`<div class="row-values review-summary"><div class="mini-kpi"><small>Righe</small><strong>${state.reviewRows.length}</strong></div><div class="mini-kpi"><small>Confermate</small><strong>${confirmed}</strong></div><div class="mini-kpi"><small>Da controllare</small><strong>${pending}</strong></div></div>`;
    host.innerHTML=summary+state.reviewRows.map(r=>`<article class="review-row ${String(r.status).toLowerCase()}" data-row-id="${r.legacy_id}">
      <div class="row-head"><div><div class="row-desc">${esc(r.description_raw)}</div><div class="row-code">${esc(r.item_code||'Nessun codice')} · riga ${r.line_number||'—'}</div></div><div class="row-state"><span class="status-pill ${r.status==='CONFERMATO'?'done':r.status==='SUGGERITO'?'ready':r.status==='ESCLUSO'?'error':'processing'}">${rowStatusLabel(r.status)}</span><div class="confidence">${Number(r.confidence||0)}%</div></div></div>
      <div class="row-values"><div class="mini-kpi"><small>Q.tà documento</small><strong>${decimal(r.document_quantity,3)} ${esc(r.document_unit||'')}</strong></div><div class="mini-kpi"><small>Q.tà tracciata</small><strong>${decimal(r.normalized_quantity,3)} ${esc(r.tracking_unit||'')}</strong></div><div class="mini-kpi"><small>Imponibile</small><strong>${money(r.net_amount)}</strong></div></div>
      <div class="row-edit">
        <label><span>Ingrediente</span><select class="ingredient-select" ${canOperate?'':'disabled'}>${ingredientOptions(r.ingredient_id)}</select></label>
        <label><span>Quantità tracciata</span><input class="normalized-qty" type="number" step="0.000001" min="0" value="${r.normalized_quantity??''}" placeholder="Quantità" ${canOperate?'':'disabled'}></label>
        <label><span>Unità</span><select class="tracking-unit" ${canOperate?'':'disabled'}>${trackingUnitOptions(r.tracking_unit)}</select></label>
        <label><span>Imponibile riga</span><input class="net-amount" type="number" step="0.0001" min="0" value="${r.net_amount??''}" placeholder="Imponibile" ${canOperate?'':'disabled'}></label>
      </div>
      <div class="row-actions ${canOperate?'':'hidden'}"><button class="secondary-button save-row">Salva</button><button class="primary-button confirm-row">Conferma</button><button class="danger-button exclude-row">Escludi</button></div>
      <div class="small muted">${esc(r.review_notes||'')}</div>
    </article>`).join('') || '<div class="empty">Nessuna riga estratta.</div>';
    host.querySelectorAll('.review-row').forEach(card=>{
      const id=card.dataset.rowId;
      const ingredientSelect=card.querySelector('.ingredient-select');
      ingredientSelect.addEventListener('change',()=>{
        const ingredient=state.ingredients.find(i=>i.id===ingredientSelect.value);
        if(ingredient?.tracking_unit)card.querySelector('.tracking-unit').value=ingredient.tracking_unit;
      });
      const save=card.querySelector('.save-row'),confirm=card.querySelector('.confirm-row'),exclude=card.querySelector('.exclude-row');
      if(save)save.onclick=()=>updateReviewRow(card,id,false);
      if(confirm)confirm.onclick=()=>updateReviewRow(card,id,true);
      if(exclude)exclude.onclick=()=>excludeReviewRow(id);
    });
  }

  async function updateReviewRow(card,rowId,confirm){
    const ingredientId=card.querySelector('.ingredient-select').value;
    const qty=card.querySelector('.normalized-qty').value;
    const trackingUnit=card.querySelector('.tracking-unit').value;
    const netAmount=card.querySelector('.net-amount').value;
    if(confirm&&!ingredientId) return toast('Seleziona un ingrediente','error');
    if(confirm&&(!trackingUnit||qty===''||Number(qty)<=0)) return toast('Controlla quantità e unità','error');
    try{
      const result=await api(confirm?'confirm_row':'update_row',{rowId,ingredientId:ingredientId||null,normalizedQuantity:qty===''?null:Number(qty),trackingUnit:trackingUnit||null,netAmount:netAmount===''?null:Number(netAmount)});
      const index=state.reviewRows.findIndex(r=>r.legacy_id===rowId);
      if(index>=0&&result.row)state.reviewRows[index]=result.row;
      renderReview();
      toast(confirm?'Riga confermata':'Riga salvata','success');
    }catch(e){toast(e.message,'error')}
  }


  async function createIngredientFromReview(){
    const name=window.prompt('Nome del nuovo ingrediente');
    if(!name||!name.trim())return;
    const unit=window.prompt('Unità di confronto: €/kg, €/l, €/pz oppure €/confezione','€/kg');
    if(!unit||!unit.trim())return;
    const category=window.prompt('Categoria (facoltativa)','')||'';
    const subcategory=window.prompt('Sottocategoria (facoltativa)','')||'';
    const btn=$('#newIngredientBtn');setBusy(btn,true,'Creazione…');
    try{
      const result=await api('create_ingredient',{name:name.trim(),trackingUnit:unit.trim(),category:category.trim(),subcategory:subcategory.trim()});
      await loadIngredients();
      toast(`Ingrediente ${result.ingredient?.name||name.trim()} creato`,'success');
      renderReview();
    }catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}
  }

  async function excludeReviewRow(rowId){try{const result=await api('exclude_row',{rowId});const index=state.reviewRows.findIndex(r=>r.legacy_id===rowId);if(index>=0&&result.row)state.reviewRows[index]=result.row;renderReview();toast('Riga esclusa','success')}catch(e){toast(e.message,'error')}}
  async function confirmAll(){try{const r=await api('confirm_all_valid',{invoiceId:state.reviewInvoice.legacy_id});state.reviewRows.forEach(row=>{if(row.status==='SUGGERITO'&&row.ingredient_id)row.status='CONFERMATO';});renderReview();toast(`${r.confirmed||0} righe confermate`,'success')}catch(e){toast(e.message,'error')}}
  async function finalizeInvoice(){const btn=$('#finalizeBtn');setBusy(btn,true,'Finalizzazione…');try{const r=await api('finalize_invoice',{invoiceId:state.reviewInvoice.legacy_id});toast(r.duplicate?'Fattura duplicata bloccata':'Fattura finalizzata','success');closeReview();await Promise.all([loadHome(),loadInvoices(),loadIngredients(),loadNotifications()])}catch(e){toast(e.message,'error')}finally{setBusy(btn,false)}}

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
    $('#newIngredientBtn').onclick=createIngredientFromReview; $('#confirmAllBtn').onclick=confirmAll; $('#finalizeBtn').onclick=finalizeInvoice;
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

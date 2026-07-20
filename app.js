(() => {
  'use strict';

  const cfg = window.FCI_CONFIG || {};
  const state = { ingredients: [], currentInvoiceId: '', allPrices: [], uploadGroups: [] };
  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    qsa('[data-nav]').forEach(btn => btn.addEventListener('click', () => {
      const filter = btn.dataset.filter || '';
      if (filter) $('invoiceStatusFilter').value = filter;
      navigate(btn.dataset.nav);
    }));
    $('homeBtn').addEventListener('click', () => navigate('home'));
    $('addInvoiceBtn').addEventListener('click', () => addUploadGroup());
    $('uploadForm').addEventListener('submit', submitUpload);
    $('refreshInvoicesBtn').addEventListener('click', loadInvoices);
    $('invoiceStatusFilter').addEventListener('change', loadInvoices);
    $('confirmAllBtn').addEventListener('click', confirmAllValid);
    $('finalizeBtn').addEventListener('click', finalizeInvoice);
    $('priceSearch').addEventListener('input', renderPriceFilter);
    $('categoryFilter').addEventListener('change', renderPriceFilter);
    addUploadGroup();
  }

  async function navigate(view) {
    qsa('.view').forEach(v => v.classList.remove('active'));
    $('view-' + view).classList.add('active');
    window.scrollTo({top: 0, behavior: 'instant'});
    if (view === 'invoices') await loadInvoices();
    if (view === 'prices') await loadPrices();
  }

  async function api(action, data = {}) {
    const url = cfg.APP_SCRIPT_URL;
    if (!url || url.includes('INCOLLA_QUI')) throw new Error('Configura APP_SCRIPT_URL in config.js');
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({action, apiToken: cfg.API_TOKEN || '', ...data}),
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`Errore HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || json.reason || 'Errore API');
    return json;
  }

  function addUploadGroup() {
    const id = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    state.uploadGroups.push({id, files: []});
    renderUploadGroups();
  }

  function renderUploadGroups() {
    const wrap = $('invoiceBatch');
    wrap.innerHTML = state.uploadGroups.map((g, idx) => `
      <article class="invoice-upload-card" data-upload-id="${esc(g.id)}">
        <div class="invoice-upload-head">
          <h3>Fattura ${idx + 1}</h3>
          ${state.uploadGroups.length > 1 ? '<button class="remove-invoice-btn" type="button">Rimuovi</button>' : ''}
        </div>
        <label class="upload-zone">
          <input class="group-file-input" type="file" accept="image/*,application/pdf" multiple>
          <span class="upload-icon">⌁</span>
          <strong>Aggiungi foto o PDF</strong>
          <small>Più foto = pagine della stessa fattura. Un PDF può essere già multipagina.</small>
        </label>
        <div class="invoice-files">${g.files.map((f, i) => `<div class="invoice-file-row"><span>${esc(f.name)}</span><button type="button" data-remove-file="${i}" aria-label="Rimuovi">×</button></div>`).join('')}</div>
        <div class="form-grid" style="margin-top:12px">
          <label><span>Data documento <em>opzionale</em></span><input class="group-date" type="date" value="${esc(g.documentDate || '')}"></label>
          <label><span>Fornitore <em>opzionale</em></span><input class="group-supplier" type="text" value="${esc(g.supplier || '')}" autocomplete="organization"></label>
          <label><span>Numero documento <em>opzionale</em></span><input class="group-number" type="text" value="${esc(g.invoiceNumber || '')}"></label>
          <label><span>Totale € <em>opzionale</em></span><input class="group-total" type="number" step="0.01" inputmode="decimal" value="${esc(g.total || '')}"></label>
        </div>
        <div class="ocr-auto-note">I campi vuoti vengono compilati dai dati letti da Gemini. I valori inseriti manualmente hanno priorità.</div>
      </article>`).join('');

    qsa('[data-upload-id]').forEach(card => {
      const id = card.dataset.uploadId;
      const group = state.uploadGroups.find(g => g.id === id);
      card.querySelector('.group-file-input').addEventListener('change', e => {
        const incoming = Array.from(e.target.files || []);
        if (!incoming.length) return;
        if (group.files.some(f => f.type === 'application/pdf') || incoming.some(f => f.type === 'application/pdf')) {
          if (group.files.length + incoming.length > 1) {
            toast('Un PDF deve essere l’unico file della fattura. Per una fattura multipagina in foto usa solo immagini.');
            e.target.value = '';
            return;
          }
        }
        group.files.push(...incoming);
        if (group.files.length > 10) {
          group.files = group.files.slice(0, 10);
          toast('Massimo 10 pagine per fattura');
        }
        captureGroupFields(card, group);
        renderUploadGroups();
      });
      card.querySelectorAll('[data-remove-file]').forEach(btn => btn.addEventListener('click', () => {
        captureGroupFields(card, group);
        group.files.splice(Number(btn.dataset.removeFile), 1);
        renderUploadGroups();
      }));
      const remove = card.querySelector('.remove-invoice-btn');
      if (remove) remove.addEventListener('click', () => {
        state.uploadGroups = state.uploadGroups.filter(g => g.id !== id);
        renderUploadGroups();
      });
      ['.group-date','.group-supplier','.group-number','.group-total'].forEach(sel => {
        card.querySelector(sel).addEventListener('input', () => captureGroupFields(card, group));
      });
    });
  }

  function captureGroupFields(card, group) {
    group.documentDate = card.querySelector('.group-date').value;
    group.supplier = card.querySelector('.group-supplier').value.trim();
    group.invoiceNumber = card.querySelector('.group-number').value.trim();
    group.total = card.querySelector('.group-total').value;
  }

  async function submitUpload(e) {
    e.preventDefault();
    qsa('[data-upload-id]').forEach(card => {
      const g = state.uploadGroups.find(x => x.id === card.dataset.uploadId);
      if (g) captureGroupFields(card, g);
    });
    const groups = state.uploadGroups.filter(g => g.files.length);
    if (!groups.length) return toast('Aggiungi almeno una fattura');

    $('uploadStatus').classList.add('hidden');
    const results = [];
    try {
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        setLoader(true, `Fattura ${gi + 1} di ${groups.length} · preparazione file…`);
        const prepared = [];
        let totalBytes = 0;
        for (let fi = 0; fi < g.files.length; fi++) {
          const original = g.files[fi];
          const file = original.type.startsWith('image/') ? await compressImage(original) : original;
          if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name}: file oltre 12 MB`);
          totalBytes += file.size;
          if (totalBytes > 30 * 1024 * 1024) throw new Error(`Fattura ${gi + 1}: dimensione complessiva oltre 30 MB`);
          prepared.push({
            fileName: file.name,
            mimeType: file.type || original.type,
            base64Data: await fileToBase64(file)
          });
        }
        setLoader(true, `Fattura ${gi + 1} di ${groups.length} · caricamento e analisi Gemini…`);
        const result = await api('upload_group_and_analyze', {
          files: prepared,
          documentDate: g.documentDate || '',
          supplier: g.supplier || '',
          invoiceNumber: g.invoiceNumber || '',
          total: g.total || ''
        });
        results.push(result);
      }

      if (results.length === 1) {
        state.currentInvoiceId = results[0].invoiceId;
        await ensureIngredients();
        renderReview(results[0].review);
        await navigate('review');
        toast('OCR completato. Controlla le righe.');
      } else {
        $('invoiceStatusFilter').value = 'DA_REVISIONARE';
        await navigate('invoices');
        toast(`${results.length} fatture analizzate. Aprile una alla volta per la revisione.`);
      }
      state.uploadGroups = [];
      addUploadGroup();
    } catch (err) {
      $('uploadStatus').classList.remove('hidden');
      $('uploadStatus').innerHTML = `<strong>Errore</strong><br><span class="muted">${esc(err.message)}</span>`;
      toast(err.message);
    } finally { setLoader(false); }
  }

  async function compressImage(file) {
    if (file.size < 1.6 * 1024 * 1024) return file;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl;
    });
    const max = 1800, scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .84));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {type:'image/jpeg'});
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Impossibile leggere il file'));
      r.readAsDataURL(file);
    });
  }

  async function ensureIngredients() {
    if (state.ingredients.length) return;
    const r = await api('get_ingredients');
    state.ingredients = r.ingredients || [];
  }

  async function openReview(invoiceId) {
    setLoader(true, 'Caricamento revisione…');
    try {
      await ensureIngredients();
      const r = await api('get_invoice_review', {invoiceId});
      state.currentInvoiceId = invoiceId;
      renderReview(r);
      navigate('review');
    } catch (e) { toast(e.message); } finally { setLoader(false); }
  }

  function renderReview(data) {
    const inv = data.invoice, rows = data.rows || [], stats = data.stats || {};
    $('reviewSubtitle').textContent = [inv.supplier, inv.invoiceNumber ? `Doc. ${inv.invoiceNumber}` : '', inv.documentDate].filter(Boolean).join(' · ');
    $('reviewState').textContent = inv.status || '';
    $('reviewSummary').innerHTML = `<div><strong>${stats.confirmed || 0}</strong><small>Confermate</small></div><div><strong>${stats.excluded || 0}</strong><small>Escluse</small></div><div><strong>${stats.pending || 0}</strong><small>Da gestire</small></div>`;
    $('reviewRows').innerHTML = rows.map(reviewCardHtml).join('') || '<div class="status-card">Nessuna riga trovata.</div>';
    rows.forEach(bindReviewCard);
  }

  function reviewCardHtml(r) {
    const ingredientOptions = ['<option value="">— Seleziona ingrediente —</option>'].concat(state.ingredients.map(i => `<option value="${esc(i.id)}" ${i.id===r.ingredientId?'selected':''}>${esc(i.name)}${i.category?' · '+esc(i.category):''}</option>`)).join('');
    const price = num(r.normalizedQuantity) > 0 && num(r.lineNetAmount) !== null ? num(r.lineNetAmount)/num(r.normalizedQuantity) : null;
    const cls = r.status === 'CONFERMATO' ? 'confirmed' : r.status === 'ESCLUSO' ? 'excluded' : '';
    return `<article class="review-card ${cls}" data-row-id="${esc(r.rowId)}">
      <div class="review-title"><h3>${esc(r.description || 'Riga senza descrizione')}</h3><span class="confidence">${r.confidence || 0}%</span></div>
      <div class="muted small">${r.itemCode ? 'Codice '+esc(r.itemCode)+' · ' : ''}Stato: ${esc(r.status)}</div>
      <div class="meta-grid">
        <div class="meta"><small>Q.tà documento</small><strong>${fmt(r.documentQuantity)} ${esc(r.documentUnit)}</strong></div>
        <div class="meta"><small>Imponibile</small><strong>${money(r.lineNetAmount)}</strong></div>
        <div class="meta"><small>Sconto</small><strong>${r.discountPercent===''?'—':fmt(r.discountPercent)+'%'}</strong></div>
        <div class="meta"><small>IVA</small><strong>${r.vatRate===''?'—':fmt(r.vatRate)+'%'}</strong></div>
      </div>
      <div class="field"><span>Ingrediente / prodotto</span><select class="ingredient-select">${ingredientOptions}</select></div>
      <div class="form-grid" style="margin-top:10px">
        <label><span>Quantità normalizzata</span><input class="qty-input" type="number" step="0.000001" value="${esc(r.normalizedQuantity)}"></label>
        <label><span>Unità confronto</span><input class="unit-input" type="text" value="${esc(r.comparisonUnit)}"></label>
      </div>
      <div class="meta" style="margin-top:10px"><small>Prezzo normalizzato stimato</small><strong>${price===null?'—':fmt(price,4)+' '+esc(r.comparisonUnit)}</strong></div>
      <div class="review-actions">
        <button class="btn danger exclude-btn">Escludi</button>
        <button class="btn primary confirm-btn">Conferma</button>
      </div>
    </article>`;
  }

  function bindReviewCard(card) {
    const el = document.querySelector(`[data-row-id="${cssEsc(card.rowId)}"]`);
    if (!el) return;
    el.querySelector('.confirm-btn').addEventListener('click', async () => {
      try {
        await api('update_row', {rowId:card.rowId, ingredientId:el.querySelector('.ingredient-select').value, normalizedQuantity:el.querySelector('.qty-input').value, comparisonUnit:el.querySelector('.unit-input').value});
        await api('confirm_row', {rowId:card.rowId, ingredientId:el.querySelector('.ingredient-select').value});
        await refreshCurrentReview(); toast('Riga confermata');
      } catch(e){toast(e.message)}
    });
    el.querySelector('.exclude-btn').addEventListener('click', async () => {
      try { await api('exclude_row',{rowId:card.rowId}); await refreshCurrentReview(); toast('Riga esclusa'); } catch(e){toast(e.message)}
    });
  }

  async function refreshCurrentReview() {
    const r = await api('get_invoice_review', {invoiceId:state.currentInvoiceId});
    renderReview(r);
  }

  async function confirmAllValid() {
    if (!state.currentInvoiceId) return;
    setLoader(true, 'Conferma righe valide…');
    try { const r = await api('confirm_all_valid',{invoiceId:state.currentInvoiceId}); await refreshCurrentReview(); toast(`${r.confirmed} righe confermate`); }
    catch(e){toast(e.message)} finally{setLoader(false)}
  }

  async function finalizeInvoice() {
    if (!state.currentInvoiceId) return;
    setLoader(true, 'Registrazione storico e chiusura…');
    try {
      const r = await api('finalize_invoice',{invoiceId:state.currentInvoiceId});
      toast(`Fattura completata · ${r.historyRowsCreated || 0} prezzi registrati`);
      await loadInvoices(); navigate('invoices');
    } catch(e){toast(e.message)} finally{setLoader(false)}
  }

  async function loadInvoices() {
    const list = $('invoiceList'); list.innerHTML = '<div class="status-card">Caricamento…</div>';
    try {
      const r = await api('list_invoices',{status:$('invoiceStatusFilter').value,limit:100});
      list.innerHTML = (r.invoices||[]).map(inv => `<article class="invoice-card">
        <div class="invoice-head"><div><h3>${esc(inv.supplier || 'Fornitore non indicato')}</h3><div class="muted small">${esc(inv.documentDate)}${inv.invoiceNumber?' · Doc. '+esc(inv.invoiceNumber):''}</div></div><span class="status-pill">${esc(inv.status)}</span></div>
        <div class="muted small" style="margin-top:8px">${esc(inv.id)}${inv.total!==''?' · '+money(inv.total):''}</div>
        ${inv.notes?`<div class="muted small" style="margin-top:6px">${esc(inv.notes)}</div>`:''}
        ${inv.status==='DA_REVISIONARE'||inv.status==='ERRORE_OCR'?`<button class="btn primary" data-open-review="${esc(inv.id)}">${inv.status==='ERRORE_OCR'?'Apri dettagli':'Revisiona'}</button>`:''}
      </article>`).join('') || '<div class="status-card">Nessuna fattura trovata.</div>';
      qsa('[data-open-review]').forEach(b => b.addEventListener('click',()=>openReview(b.dataset.openReview)));
    } catch(e){list.innerHTML=`<div class="status-card">${esc(e.message)}</div>`}
  }

  async function loadPrices() {
    $('priceList').innerHTML = '<div class="status-card">Caricamento…</div>';
    try {
      const r = await api('get_price_dashboard');
      state.allPrices = r.items || [];
      const cats = Array.from(new Set(state.allPrices.map(x=>x.category).filter(Boolean))).sort();
      $('categoryFilter').innerHTML = '<option value="">Tutte le categorie</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
      renderPriceFilter();
    } catch(e){$('priceList').innerHTML=`<div class="status-card">${esc(e.message)}</div>`}
  }

  function renderPriceFilter() {
    const s = $('priceSearch').value.trim().toLowerCase(), c = $('categoryFilter').value;
    const items = state.allPrices.filter(x => (!s || x.ingredient.toLowerCase().includes(s)) && (!c || x.category===c));
    $('priceList').innerHTML = items.map(x => {
      const d = num(x.changePercent), cls = d===null?'flat':d>0?'up':d<0?'down':'flat';
      return `<article class="price-card"><div class="price-head"><div><h3>${esc(x.ingredient)}</h3><div class="muted small">${esc(x.category||'Senza categoria')} · ${esc(x.supplier||'')}</div></div><div class="price-value">${fmt(x.latestPrice,4)}</div></div>
        <div class="meta-grid"><div class="meta"><small>Precedente</small><strong>${x.previousPrice===''?'—':fmt(x.previousPrice,4)}</strong></div><div class="meta"><small>Variazione</small><strong class="delta ${cls}">${d===null?'—':(d>0?'+':'')+fmt(d,2)+'%'}</strong></div></div>
        <div class="muted small">${esc(x.unit)} · ultimo acquisto ${esc(x.lastPurchaseDate||'—')}</div></article>`;
    }).join('') || '<div class="status-card">Nessun prezzo disponibile.</div>';
  }

  function setLoader(show,text='Elaborazione…'){ $('loader').classList.toggle('hidden',!show); $('loaderText').textContent=text; }
  function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),3200); }
  function esc(v){return String(v??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}
  function fmt(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('it-IT',{maximumFractionDigits:d}):'—'}
  function money(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('it-IT',{style:'currency',currency:'EUR'}):'—'}
  function num(v){if(v===''||v===null||v===undefined)return null;const n=Number(v);return Number.isFinite(n)?n:null}
  function cssEsc(v){return window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/"/g,'\\"')}
})();

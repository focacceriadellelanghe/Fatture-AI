(() => {
  'use strict';

  const cfg = window.FCI_CONFIG || {};
  const state = { ingredients: [], currentInvoiceId: '', allPrices: [] };
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
    $('fileInput').addEventListener('change', onFileSelected);
    $('uploadForm').addEventListener('submit', submitUpload);
    $('refreshInvoicesBtn').addEventListener('click', loadInvoices);
    $('invoiceStatusFilter').addEventListener('change', loadInvoices);
    $('confirmAllBtn').addEventListener('click', confirmAllValid);
    $('finalizeBtn').addEventListener('click', finalizeInvoice);
    $('priceSearch').addEventListener('input', renderPriceFilter);
    $('categoryFilter').addEventListener('change', renderPriceFilter);
    $('documentDate').value = new Date().toISOString().slice(0, 10);
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

  function onFileSelected() {
    const file = $('fileInput').files[0];
    $('fileLabel').textContent = file ? file.name : 'Scatta foto o seleziona PDF';
  }

  async function submitUpload(e) {
    e.preventDefault();
    const original = $('fileInput').files[0];
    if (!original) return toast('Seleziona una foto o un PDF');
    setLoader(true, 'Preparazione file…');
    try {
      const file = original.type.startsWith('image/') ? await compressImage(original) : original;
      if (file.size > 12 * 1024 * 1024) throw new Error('File oltre 12 MB. Riduci il PDF o usa una foto.');
      setLoader(true, 'Caricamento e analisi Gemini…');
      const base64Data = await fileToBase64(file);
      const result = await api('upload_and_analyze', {
        fileName: file.name,
        mimeType: file.type || original.type,
        base64Data,
        documentDate: $('documentDate').value,
        supplier: $('supplier').value.trim(),
        invoiceNumber: $('invoiceNumber').value.trim(),
        total: $('total').value
      });
      state.currentInvoiceId = result.invoiceId;
      await ensureIngredients();
      renderReview(result.review);
      navigate('review');
      toast('OCR completato. Controlla le righe.');
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

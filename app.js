(() => {
  'use strict';

  const cfg = window.FCI_CONFIG || {};
  const state = {
    ingredients: [],
    units: [],
    categories: [],
    subcategoriesByCategory: {},
    currentInvoiceId: '',
    allPrices: [],
    notifications: [],
    uploadGroups: [],
    newIngredientRowId: '',
    priceChart: null,
    catalogPromise: null,
    navigationToken: 0
  };

  const READ_ACTIONS = new Set([
    'get_app_status',
    'get_invoice_review',
    'get_ingredients',
    'get_tracking_units',
    'list_invoices',
    'get_price_dashboard'
  ]);

  const RETRYABLE_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

  const $ = id => document.getElementById(id);
  const qsa = selector => Array.from(document.querySelectorAll(selector));

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    qsa('[data-nav]').forEach(button => {
      button.addEventListener('click', () => {
        const filter = button.dataset.filter || '';
        if (filter) $('invoiceStatusFilter').value = filter;
        navigate(button.dataset.nav, filter ? {status: filter} : {}, true);
      });
    });

    $('homeBtn').addEventListener('click', () => navigate('home', {}, true));
    $('addInvoiceBtn').addEventListener('click', addUploadGroup);
    $('uploadForm').addEventListener('submit', submitUpload);
    $('refreshInvoicesBtn').addEventListener('click', loadInvoices);
    $('invoiceStatusFilter').addEventListener('change', loadInvoices);
    $('confirmAllBtn').addEventListener('click', confirmAllValid);
    $('finalizeBtn').addEventListener('click', finalizeInvoice);
    $('priceSearch').addEventListener('input', renderPriceFilter);
    $('categoryFilter').addEventListener('change', renderPriceFilter);
    $('priceDetailClose').addEventListener('click', closePriceDetail);
    $('priceDetailModal').addEventListener('click', event => {
      if (event.target.id === 'priceDetailModal') closePriceDetail();
    });
    $('ingredientModalCancel').addEventListener('click', closeIngredientModal);
    $('ingredientModalForm').addEventListener('submit', submitNewIngredient);
    $('ingredientModalCategory').addEventListener('change', handleCategorySelection);
    $('ingredientModalSubcategory').addEventListener('change', handleSubcategorySelection);
    $('ingredientModalUnit').addEventListener('change', async event => {
      if (event.target.value !== '__NEW__') return;
      const unit = await createUnitFromPrompt();
      if (unit) populateUnitSelect(event.target, unit);
      else event.target.value = '';
    });

    window.addEventListener('popstate', applyRouteFromUrl);
    addUploadGroup();
    applyRouteFromUrl();
  }

  function sleep(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  function timeoutForAction(action) {
    if (action === 'upload_group_and_analyze' || action === 'upload_and_analyze') return 90000;
    if (action === 'finalize_invoice') return 90000;
    if (READ_ACTIONS.has(action)) return 35000;
    return 50000;
  }

  async function fetchAttempt(action, data, timeoutMs, attempt) {
    const endpoint = String(cfg.APP_SCRIPT_URL || '').trim();
    if (!endpoint || endpoint.includes('INCOLLA_QUI')) {
      throw new Error('Configura APP_SCRIPT_URL in config.js');
    }

    const url = new URL(endpoint);
    url.searchParams.set('_fci', Date.now().toString());
    url.searchParams.set('_action', action);
    url.searchParams.set('_attempt', String(attempt));

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          action,
          apiToken: cfg.API_TOKEN || '',
          ...data
        }),
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      });

      const text = await response.text();

      if (!response.ok) {
        const error = new Error(`Errore HTTP ${response.status} durante ${action}`);
        error.httpStatus = response.status;
        error.responseText = text;
        throw error;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(`Risposta non valida durante ${action}`);
      }

      if (!json || json.success !== true) {
        throw new Error(
          (json && (json.error || json.reason)) ||
          `Errore API durante ${action}`
        );
      }

      return json;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function isTemporaryError(error) {
    const status = Number(error && error.httpStatus);
    const message = String(error && error.message || '');
    return (
      RETRYABLE_STATUSES.has(status) ||
      error?.name === 'AbortError' ||
      error instanceof TypeError ||
      /failed to fetch|load failed|networkerror|network request failed/i.test(message)
    );
  }

  async function api(action, data = {}, options = {}) {
    const isRead = READ_ACTIONS.has(action);
    const attempts = options.attempts || (isRead ? 2 : 1);
    const timeoutMs = options.timeoutMs || timeoutForAction(action);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fetchAttempt(action, data, timeoutMs, attempt);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isTemporaryError(error)) break;
        await sleep(650 * attempt);
      }
    }

    throw lastError || new Error(`Errore durante ${action}`);
  }

  async function verifyInvoiceReview(invoiceId, predicate, attempts = 4) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const review = await api(
          'get_invoice_review',
          {invoiceId},
          {attempts: 2, timeoutMs: 35000}
        );
        if (predicate(review)) return review;
      } catch (_) {}
      if (attempt < attempts) await sleep(900 * attempt);
    }
    return null;
  }

  async function writeWithRecovery(action, data, verify) {
    try {
      return await api(action, data, {attempts: 1});
    } catch (originalError) {
      if (!isTemporaryError(originalError) || typeof verify !== 'function') {
        throw originalError;
      }

      const recovered = await verify();
      if (recovered) return {success: true, recovered: true, ...recovered};
      throw originalError;
    }
  }

  function readRoute() {
    const params = new URLSearchParams(window.location.search);
    return {
      view: params.get('view') || 'home',
      status: params.get('status') || '',
      invoiceId: params.get('invoice') || '',
      ingredientId: params.get('ingredient') || '',
      notificationId: params.get('notification') || ''
    };
  }

  function writeRoute(view, params = {}) {
    const query = new URLSearchParams();
    if (view && view !== 'home') query.set('view', view);
    if (params.status) query.set('status', params.status);
    if (params.invoiceId) query.set('invoice', params.invoiceId);
    if (params.ingredientId) query.set('ingredient', params.ingredientId);
    if (params.notificationId) query.set('notification', params.notificationId);
    history.pushState({}, '', window.location.pathname + (query.toString() ? `?${query}` : ''));
  }

  async function applyRouteFromUrl() {
    const route = readRoute();
    await navigate(route.view, route, false);
  }

  async function navigate(view, params = {}, updateUrl = true) {
    const token = ++state.navigationToken;
    const target = $('view-' + view) ? view : 'home';

    qsa('.view').forEach(element => element.classList.remove('active'));
    $('view-' + target).classList.add('active');
    window.scrollTo({top: 0, behavior: 'auto'});

    if (updateUrl) writeRoute(target, params);

    try {
      if (target === 'home') {
        await loadHomeStatus();
      } else if (target === 'invoices') {
        if (params.status !== undefined) $('invoiceStatusFilter').value = params.status;
        await loadInvoices();
      } else if (target === 'review' && params.invoiceId) {
        await openReview(params.invoiceId, false);
      } else if (target === 'prices') {
        await loadPrices();
        if (token !== state.navigationToken) return;
        if (params.ingredientId) openPriceDetail(params.ingredientId);
        if (params.notificationId) {
          const card = document.querySelector(
            `[data-notification-id="${cssEsc(params.notificationId)}"]`
          );
          if (card) card.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
      }
    } catch (error) {
      toast(error.message);
    }
  }

  async function loadHomeStatus() {
    const box = $('homeStatus');
    if (!box) return;

    try {
      const result = await api('get_app_status');
      const counts = result.counts || {};
      const active = Number(counts.received || 0) + Number(counts.analyzing || 0);

      box.innerHTML = `
        <button class="home-status-item" data-home-status="ANALISI_IN_CORSO">
          <strong>${active}</strong><span>In elaborazione</span>
        </button>
        <button class="home-status-item" data-home-status="DA_REVISIONARE">
          <strong>${Number(counts.ready || 0)}</strong><span>Da revisionare</span>
        </button>
        <button class="home-status-item" data-home-status="ERRORE_OCR">
          <strong>${Number(counts.errors || 0)}</strong><span>Con errore</span>
        </button>`;

      qsa('[data-home-status]').forEach(button => {
        button.addEventListener('click', () => {
          $('invoiceStatusFilter').value = button.dataset.homeStatus;
          navigate('invoices', {status: button.dataset.homeStatus}, true);
        });
      });
    } catch (error) {
      box.innerHTML = `<div class="status-card">${esc(error.message)}</div>`;
    }
  }

  function addUploadGroup() {
    const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.uploadGroups.push({id, files: []});
    renderUploadGroups();
  }

  function renderUploadGroups() {
    const wrapper = $('invoiceBatch');
    wrapper.innerHTML = state.uploadGroups.map((group, index) => `
      <article class="invoice-upload-card" data-upload-id="${esc(group.id)}">
        <div class="invoice-upload-head">
          <h3>Fattura ${index + 1}</h3>
          ${state.uploadGroups.length > 1 ? '<button class="remove-invoice-btn" type="button">Rimuovi</button>' : ''}
        </div>
        <label class="upload-zone">
          <input class="group-file-input" type="file" accept="image/*,application/pdf" multiple>
          <span class="upload-icon">⌁</span>
          <strong>Aggiungi foto o PDF</strong>
          <small>Più foto = pagine della stessa fattura. Un PDF può essere già multipagina.</small>
        </label>
        <div class="invoice-files">${group.files.map((file, fileIndex) => `
          <div class="invoice-file-row">
            <span>${esc(file.name)}</span>
            <button type="button" data-remove-file="${fileIndex}" aria-label="Rimuovi">×</button>
          </div>`).join('')}</div>
        <div class="form-grid" style="margin-top:12px">
          <label><span>Data documento <em>opzionale</em></span><input class="group-date" type="date" value="${esc(group.documentDate || '')}"></label>
          <label><span>Fornitore <em>opzionale</em></span><input class="group-supplier" type="text" value="${esc(group.supplier || '')}" autocomplete="organization"></label>
          <label><span>Numero documento <em>opzionale</em></span><input class="group-number" type="text" value="${esc(group.invoiceNumber || '')}"></label>
          <label><span>Totale € <em>opzionale</em></span><input class="group-total" type="number" step="0.01" inputmode="decimal" value="${esc(group.total || '')}"></label>
        </div>
        <div class="ocr-auto-note">I campi vuoti vengono compilati dai dati letti da Gemini. I valori inseriti manualmente hanno priorità.</div>
      </article>`).join('');

    qsa('[data-upload-id]').forEach(card => {
      const group = state.uploadGroups.find(item => item.id === card.dataset.uploadId);

      card.querySelector('.group-file-input').addEventListener('change', event => {
        const incoming = Array.from(event.target.files || []);
        if (!incoming.length) return;

        if (
          (group.files.some(file => file.type === 'application/pdf') ||
           incoming.some(file => file.type === 'application/pdf')) &&
          group.files.length + incoming.length > 1
        ) {
          toast('Un PDF deve essere l’unico file della fattura.');
          event.target.value = '';
          return;
        }

        captureGroupFields(card, group);
        group.files.push(...incoming);
        if (group.files.length > 10) {
          group.files = group.files.slice(0, 10);
          toast('Massimo 10 pagine per fattura');
        }
        renderUploadGroups();
      });

      card.querySelectorAll('[data-remove-file]').forEach(button => {
        button.addEventListener('click', () => {
          captureGroupFields(card, group);
          group.files.splice(Number(button.dataset.removeFile), 1);
          renderUploadGroups();
        });
      });

      const remove = card.querySelector('.remove-invoice-btn');
      if (remove) {
        remove.addEventListener('click', () => {
          state.uploadGroups = state.uploadGroups.filter(item => item.id !== group.id);
          renderUploadGroups();
        });
      }

      ['.group-date', '.group-supplier', '.group-number', '.group-total'].forEach(selector => {
        card.querySelector(selector).addEventListener('input', () => captureGroupFields(card, group));
      });
    });
  }

  function captureGroupFields(card, group) {
    group.documentDate = card.querySelector('.group-date').value;
    group.supplier = card.querySelector('.group-supplier').value.trim();
    group.invoiceNumber = card.querySelector('.group-number').value.trim();
    group.total = card.querySelector('.group-total').value;
  }

  async function submitUpload(event) {
    event.preventDefault();

    qsa('[data-upload-id]').forEach(card => {
      const group = state.uploadGroups.find(item => item.id === card.dataset.uploadId);
      if (group) captureGroupFields(card, group);
    });

    const groups = state.uploadGroups.filter(group => group.files.length);
    if (!groups.length) {
      toast('Aggiungi almeno una fattura');
      return;
    }

    const accepted = [];
    const failed = [];
    $('uploadStatus').classList.add('hidden');

    try {
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        setLoader(true, `Invio fattura ${index + 1} di ${groups.length}…`);

        try {
          const files = [];
          let totalBytes = 0;

          for (const original of group.files) {
            const file = original.type.startsWith('image/')
              ? await compressImage(original)
              : original;

            if (file.size > 12 * 1024 * 1024) {
              throw new Error(`${file.name}: file oltre 12 MB`);
            }

            totalBytes += file.size;
            if (totalBytes > 30 * 1024 * 1024) {
              throw new Error('Dimensione complessiva oltre 30 MB');
            }

            files.push({
              fileName: file.name,
              mimeType: file.type || original.type,
              base64Data: await fileToBase64(file)
            });
          }

          const result = await api('upload_group_and_analyze', {
            files,
            documentDate: group.documentDate || '',
            supplier: group.supplier || '',
            invoiceNumber: group.invoiceNumber || '',
            total: group.total || '',
            clientTimestamp: new Date().toISOString()
          }, {attempts: 1, timeoutMs: 90000});

          accepted.push(result);
        } catch (error) {
          failed.push({index: index + 1, message: error.message});
        }
      }

      state.uploadGroups = [];
      addUploadGroup();

      if (accepted.length) {
        const message = accepted.length === 1
          ? 'Fattura ricevuta. Analisi avviata.'
          : `${accepted.length} fatture ricevute. Analisi avviata.`;

        $('uploadStatus').classList.remove('hidden');
        $('uploadStatus').innerHTML = `<strong>${esc(message)}</strong>${
          failed.length ? `<br><span class="muted">${failed.length} invii non riusciti.</span>` : ''
        }`;
        toast(message);
        $('invoiceStatusFilter').value = '';
        setLoader(false);
        await navigate('invoices', {}, true);
      } else {
        throw new Error(failed.map(item => `Fattura ${item.index}: ${item.message}`).join(' · '));
      }
    } catch (error) {
      $('uploadStatus').classList.remove('hidden');
      $('uploadStatus').innerHTML = `<strong>Errore</strong><br><span class="muted">${esc(error.message)}</span>`;
      toast(error.message);
    } finally {
      setLoader(false);
    }
  }

  async function compressImage(file) {
    if (file.size < 1.6 * 1024 * 1024) return file;

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = dataUrl;
    });

    const max = 1800;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
    if (!blob) throw new Error('Compressione immagine non riuscita');

    return new File(
      [blob],
      file.name.replace(/\.[^.]+$/, '') + '.jpg',
      {type: 'image/jpeg'}
    );
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Impossibile leggere il file'));
      reader.readAsDataURL(file);
    });
  }

  async function ensureCatalog() {
    if (state.ingredients.length && state.units.length) return;

    if (!state.catalogPromise) {
      state.catalogPromise = Promise.all([
        state.ingredients.length
          ? Promise.resolve(null)
          : api('get_ingredients'),
        state.units.length
          ? Promise.resolve(null)
          : api('get_tracking_units')
      ]).then(([ingredientsResult, unitsResult]) => {
        if (ingredientsResult) {
          state.ingredients = ingredientsResult.ingredients || [];
          state.categories = ingredientsResult.categories || [];
          state.subcategoriesByCategory = ingredientsResult.subcategoriesByCategory || {};
        }
        if (unitsResult) {
          state.units = unitsResult.units || ['€/kg', '€/pz', '€/confezione'];
        }
      }).finally(() => {
        state.catalogPromise = null;
      });
    }

    await state.catalogPromise;
  }

  async function openReview(invoiceId, updateUrl = true) {
    if (!invoiceId) return;

    state.currentInvoiceId = invoiceId;
    setLoader(true, 'Caricamento revisione…');

    try {
      const [review] = await Promise.all([
        api('get_invoice_review', {invoiceId}),
        ensureCatalog()
      ]);

      renderReview(review);
      showView('review');
      if (updateUrl) writeRoute('review', {invoiceId});
    } catch (error) {
      toast(error.message);
      throw error;
    } finally {
      setLoader(false);
    }
  }

  function showView(view) {
    qsa('.view').forEach(element => element.classList.remove('active'));
    const target = $('view-' + view);
    if (target) target.classList.add('active');
    window.scrollTo({top: 0, behavior: 'auto'});
  }

  function renderReview(data) {
    const invoice = data.invoice || {};
    const rows = data.rows || [];
    const stats = data.stats || {};

    $('reviewSubtitle').textContent = [
      invoice.supplier,
      invoice.invoiceNumber ? `Doc. ${invoice.invoiceNumber}` : '',
      invoice.documentDate
    ].filter(Boolean).join(' · ');

    $('reviewState').textContent = invoice.status || '';
    $('reviewSummary').innerHTML = `
      <div><strong>${stats.confirmed || 0}</strong><small>Confermate</small></div>
      <div><strong>${stats.excluded || 0}</strong><small>Escluse</small></div>
      <div><strong>${stats.pending || 0}</strong><small>Da gestire</small></div>`;

    $('reviewRows').innerHTML = rows.map(reviewCardHtml).join('') ||
      '<div class="status-card">Nessuna riga trovata.</div>';

    rows.forEach(bindReviewCard);
  }

  function reviewCardHtml(row) {
    const ingredientOptions = [
      '<option value="">— Seleziona ingrediente —</option>',
      ...state.ingredients.map(ingredient => `
        <option value="${esc(ingredient.id)}" ${ingredient.id === row.ingredientId ? 'selected' : ''}>
          ${esc(ingredient.name)}${ingredient.category ? ' · ' + esc(ingredient.category) : ''}
        </option>`)
    ].join('');

    const documentUnit = canonicalUnitClient(row.documentUnit);
    const trackingUnit = canonicalUnitClient(row.comparisonUnit);
    const quantity = num(row.normalizedQuantity);
    const net = num(row.lineNetAmount);
    const price = quantity && quantity > 0 && net !== null ? net / quantity : null;
    const cssClass = row.status === 'CONFERMATO'
      ? 'confirmed'
      : row.status === 'ESCLUSO'
        ? 'excluded'
        : '';

    return `<article class="review-card ${cssClass}" data-row-id="${esc(row.rowId)}">
      <div class="review-title">
        <h3>${esc(row.description || 'Riga senza descrizione')}</h3>
        <span class="confidence">${row.confidence || 0}%</span>
      </div>
      <div class="muted small">${row.itemCode ? 'Codice ' + esc(row.itemCode) + ' · ' : ''}Stato: ${esc(row.status)}</div>
      <div class="meta-grid">
        <div class="meta"><small>Imponibile</small><strong>${money(row.lineNetAmount)}</strong></div>
        <div class="meta"><small>Prezzo documento</small><strong>${row.documentUnitPrice === '' ? '—' : money(row.documentUnitPrice)}</strong></div>
        <div class="meta"><small>Sconto</small><strong>${row.discountPercent === '' ? '—' : fmt(row.discountPercent) + '%'}</strong></div>
        <div class="meta"><small>IVA</small><strong>${row.vatRate === '' ? '—' : fmt(row.vatRate) + '%'}</strong></div>
      </div>
      <div class="field">
        <span>Ingrediente / prodotto</span>
        <select class="ingredient-select">${ingredientOptions}</select>
        <button type="button" class="inline-add new-ingredient-btn">＋ Nuovo ingrediente / prodotto</button>
      </div>
      <div class="form-grid review-units-grid" style="margin-top:10px">
        <label><span>Quantità fattura</span><input class="document-qty-input" type="number" step="0.000001" value="${esc(row.documentQuantity)}"></label>
        <label><span>Unità fattura</span><select class="document-unit-select">${unitOptionsHtml(documentUnit)}</select></label>
        <label><span>Quantità da tracciare</span><input class="tracking-qty-input" type="number" step="0.000001" value="${esc(row.normalizedQuantity)}"></label>
        <label><span>Unità da tracciare</span><select class="tracking-unit-select">${unitOptionsHtml(trackingUnit)}</select></label>
      </div>
      <div class="meta" style="margin-top:10px">
        <small>Prezzo da tracciare stimato</small>
        <strong>${price === null ? '—' : fmt(price, 6) + ' ' + esc(trackingUnit)}</strong>
      </div>
      <div class="review-actions">
        <button class="btn danger exclude-btn" type="button">Escludi</button>
        <button class="btn primary confirm-btn" type="button">Conferma</button>
      </div>
    </article>`;
  }

  function bindReviewCard(row) {
    const element = document.querySelector(`[data-row-id="${cssEsc(row.rowId)}"]`);
    if (!element) return;

    const ingredientSelect = element.querySelector('.ingredient-select');
    const trackingUnitSelect = element.querySelector('.tracking-unit-select');
    const documentUnitSelect = element.querySelector('.document-unit-select');

    ingredientSelect.addEventListener('change', () => {
      const ingredient = state.ingredients.find(item => item.id === ingredientSelect.value);
      if (ingredient?.unit) ensureOptionAndSelect(trackingUnitSelect, ingredient.unit);
    });

    [trackingUnitSelect, documentUnitSelect].forEach(select => {
      select.addEventListener('change', async () => {
        if (select.value !== '__NEW__') return;
        const unit = await createUnitFromPrompt();
        if (unit) ensureOptionAndSelect(select, unit);
        else select.value = '';
      });
    });

    element.querySelector('.new-ingredient-btn').addEventListener('click', () => {
      state.newIngredientRowId = row.rowId;
      openIngredientModal();
    });

    element.querySelector('.confirm-btn').addEventListener('click', async () => {
      const button = element.querySelector('.confirm-btn');
      if (button.disabled) return;
      button.disabled = true;

      const payload = {
        rowId: row.rowId,
        ingredientId: ingredientSelect.value,
        documentQuantity: element.querySelector('.document-qty-input').value,
        documentUnit: documentUnitSelect.value,
        normalizedQuantity: element.querySelector('.tracking-qty-input').value,
        comparisonUnit: trackingUnitSelect.value,
        saveTrackingUnitAsDefault: true
      };

      try {
        const result = await writeWithRecovery(
          'confirm_row',
          payload,
          async () => {
            const review = await verifyInvoiceReview(
              state.currentInvoiceId,
              value => (value.rows || []).some(item =>
                item.rowId === row.rowId &&
                String(item.status).toUpperCase() === 'CONFERMATO'
              ),
              3
            );
            return review ? {review} : null;
          }
        );

        if (result.review) renderReview(result.review);
        else await refreshCurrentReview();

        toast(result.recovered ? 'Riga confermata e verificata' : 'Riga confermata');
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    });

    element.querySelector('.exclude-btn').addEventListener('click', async () => {
      const button = element.querySelector('.exclude-btn');
      if (button.disabled) return;
      button.disabled = true;

      try {
        const result = await writeWithRecovery(
          'exclude_row',
          {rowId: row.rowId},
          async () => {
            const review = await verifyInvoiceReview(
              state.currentInvoiceId,
              value => (value.rows || []).some(item =>
                item.rowId === row.rowId &&
                String(item.status).toUpperCase() === 'ESCLUSO'
              ),
              3
            );
            return review ? {review} : null;
          }
        );

        if (result.review) renderReview(result.review);
        else await refreshCurrentReview();
        toast(result.recovered ? 'Riga esclusa e verificata' : 'Riga esclusa');
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    });
  }

  async function refreshCurrentReview() {
    if (!state.currentInvoiceId) return null;
    const review = await api('get_invoice_review', {invoiceId: state.currentInvoiceId});
    renderReview(review);
    return review;
  }

  async function confirmAllValid() {
    if (!state.currentInvoiceId) return;

    const button = $('confirmAllBtn');
    if (button.disabled) return;
    button.disabled = true;
    setLoader(true, 'Conferma righe valide…');

    try {
      const result = await writeWithRecovery(
        'confirm_all_valid',
        {invoiceId: state.currentInvoiceId},
        async () => {
          const review = await verifyInvoiceReview(
            state.currentInvoiceId,
            value => Number(value.stats?.pending || 0) === 0,
            4
          );
          return review ? {review, confirmed: Number(review.stats?.confirmed || 0)} : null;
        }
      );

      const review = result.review || await refreshCurrentReview();
      if (result.review) renderReview(result.review);
      toast(`${Number(result.confirmed ?? review?.stats?.confirmed ?? 0)} righe confermate`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      setLoader(false);
    }
  }

  async function finalizeInvoice() {
    if (!state.currentInvoiceId) return;

    const invoiceId = state.currentInvoiceId;
    const button = $('finalizeBtn');
    if (button.disabled) return;

    button.disabled = true;
    setLoader(true, 'Registrazione storico e chiusura…');

    try {
      const result = await writeWithRecovery(
        'finalize_invoice',
        {invoiceId},
        async () => {
          const review = await verifyInvoiceReview(
            invoiceId,
            value => String(value.invoice?.status || '').toUpperCase() === 'COMPLETATA',
            6
          );
          return review ? {
            finalized: true,
            historyRowsCreated: 0,
            intelligence: {},
            review
          } : null;
        }
      );

      const intelligence = result.intelligence || {};
      const alerts =
        Number(intelligence.priceNotifications || 0) +
        Number(intelligence.marginNotifications || 0);

      toast(
        result.recovered
          ? 'Fattura completata e verificata'
          : `Fattura completata · ${result.historyRowsCreated || 0} prezzi registrati${alerts ? ` · ${alerts} alert` : ''}`
      );

      $('invoiceStatusFilter').value = '';
      setLoader(false);
      await navigate('invoices', {}, true);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      setLoader(false);
    }
  }

  async function loadInvoices() {
    const list = $('invoiceList');
    list.innerHTML = '<div class="status-card">Caricamento…</div>';

    try {
      const result = await api('list_invoices', {
        status: $('invoiceStatusFilter').value,
        limit: 100
      });

      list.innerHTML = (result.invoices || []).map(invoice => {
        const canReview = invoice.status === 'DA_REVISIONARE';
        const isError = invoice.status === 'ERRORE_OCR';

        return `<article class="invoice-card" data-invoice-id="${esc(invoice.id)}">
          <div class="invoice-head">
            <div>
              <h3>${esc(invoice.supplier || 'Fornitore non ancora riconosciuto')}</h3>
              <div class="muted small">${esc(invoice.documentDate)}${invoice.invoiceNumber ? ' · Doc. ' + esc(invoice.invoiceNumber) : ''}</div>
            </div>
            <span class="status-pill">${esc(invoice.status)}</span>
          </div>
          <div class="muted small" style="margin-top:8px">${esc(invoice.id)}${invoice.total !== '' ? ' · ' + money(invoice.total) : ''}</div>
          ${invoice.notes ? `<div class="muted small" style="margin-top:6px">${esc(invoice.notes)}</div>` : ''}
          ${canReview ? `<button class="btn primary" data-open-review="${esc(invoice.id)}">Revisiona</button>` : ''}
          ${isError ? `<button class="btn secondary" data-open-error="${esc(invoice.id)}">Dettagli errore</button>` : ''}
        </article>`;
      }).join('') || '<div class="status-card">Nessuna fattura trovata.</div>';

      qsa('[data-open-review]').forEach(button => {
        button.addEventListener('click', () => openReview(button.dataset.openReview, true));
      });

      qsa('[data-open-error]').forEach(button => {
        button.addEventListener('click', () => {
          const card = button.closest('.invoice-card');
          const note = card?.querySelector('.muted.small:last-of-type');
          toast(note ? note.textContent : 'Controlla le note della fattura');
        });
      });
    } catch (error) {
      list.innerHTML = `<div class="status-card">${esc(error.message)}</div>`;
    }
  }

  async function loadPrices() {
    $('priceList').innerHTML = '<div class="status-card">Caricamento…</div>';
    $('notificationList').innerHTML = '<div class="status-card">Caricamento notifiche…</div>';

    try {
      const result = await api('get_price_dashboard');
      state.allPrices = result.items || [];
      state.notifications = result.notifications || [];

      const categories = result.categories ||
        Array.from(new Set(state.allPrices.map(item => item.category).filter(Boolean))).sort();

      $('categoryFilter').innerHTML =
        '<option value="">Tutte le categorie</option>' +
        categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');

      renderNotifications();
      renderPriceFilter();
    } catch (error) {
      $('priceList').innerHTML = `<div class="status-card">${esc(error.message)}</div>`;
      $('notificationList').innerHTML = '';
    }
  }

  function renderNotifications() {
    const rows = state.notifications || [];
    $('notificationCount').textContent = rows.length;

    $('notificationList').innerHTML = rows.map(notification => {
      const color = String(notification.color || 'NEUTRO').toLowerCase();
      const type = String(notification.type || '').toUpperCase();
      const isMargin = type === 'MARGINE';
      const isInvoice = type === 'FATTURE_PRONTE' || type === 'ERRORE_FATTURA';

      let value = '';
      let detail = '';

      if (isInvoice) {
        value = notification.newValue === '' ? '' : fmt(notification.newValue, 0);
        detail = notification.eventDate ? formatDateIt(notification.eventDate) : '';
      } else if (isMargin) {
        value = `${num(notification.changePoints) > 0 ? '+' : ''}${fmt(notification.changePoints, 2)} pt`;
        detail = `${fmt(notification.previousValue, 2)}% → ${fmt(notification.newValue, 2)}%`;
      } else {
        value = `${num(notification.changePercent) > 0 ? '+' : ''}${fmt(notification.changePercent, 2)}%`;
        detail = `${fmt(notification.previousValue, 5)} → ${fmt(notification.newValue, 5)} ${esc(notification.unit || '')}`;
      }

      return `<article class="notification-card sev-${esc(color)} clickable-notification" data-notification-id="${esc(notification.id)}">
        <div class="notification-accent"></div>
        <div class="notification-main">
          <h4>${esc(notification.item || notification.type)}</h4>
          <p>${esc(notification.detail || '')}</p>
          ${detail ? `<p>${esc(detail)}</p>` : ''}
        </div>
        ${value ? `<div class="notification-value">${value}</div>` : ''}
        <button class="ack-btn" type="button">Segna letta</button>
      </article>`;
    }).join('') || '<div class="status-card">Nessuna nuova notifica.</div>';

    qsa('[data-notification-id]').forEach(card => {
      card.addEventListener('click', event => {
        if (event.target.closest('.ack-btn')) return;
        const notification = state.notifications.find(item => item.id === card.dataset.notificationId);
        if (notification) openNotificationTarget(notification);
      });
    });

    qsa('[data-notification-id] .ack-btn').forEach(button => {
      button.addEventListener('click', async event => {
        event.stopPropagation();
        const card = button.closest('[data-notification-id]');
        const id = card.dataset.notificationId;
        button.disabled = true;

        try {
          await writeWithRecovery(
            'acknowledge_notification',
            {notificationId: id},
            async () => ({verified: true})
          );
          state.notifications = state.notifications.filter(item => item.id !== id);
          renderNotifications();
        } catch (error) {
          button.disabled = false;
          toast(error.message);
        }
      });
    });
  }

  async function openNotificationTarget(notification) {
    const type = String(notification.type || '').toUpperCase();

    if (type === 'FATTURE_PRONTE') {
      if (notification.invoiceId) {
        await openReview(notification.invoiceId, true);
      } else {
        $('invoiceStatusFilter').value = 'DA_REVISIONARE';
        await navigate('invoices', {status: 'DA_REVISIONARE'}, true);
      }
      return;
    }

    if (type === 'ERRORE_FATTURA') {
      $('invoiceStatusFilter').value = 'ERRORE_OCR';
      await navigate('invoices', {status: 'ERRORE_OCR'}, true);
      return;
    }

    if (type === 'PREZZO' && notification.ingredientId) {
      await navigate('prices', {ingredientId: notification.ingredientId}, true);
      return;
    }

    await navigate('prices', {notificationId: notification.id}, true);
  }

  function renderPriceFilter() {
    const search = $('priceSearch').value.trim().toLowerCase();
    const category = $('categoryFilter').value;

    const items = state.allPrices.filter(item =>
      (!search || String(item.ingredient || '').toLowerCase().includes(search)) &&
      (!category || item.category === category)
    );

    $('priceList').innerHTML = items.map(item => {
      const change = num(item.changePercent);
      const changeClass = change === null ? 'flat' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      const borderClass = change === null || change === 0
        ? ''
        : change < 0
          ? 'alert-down'
          : Math.abs(change) >= 7
            ? 'alert-high'
            : Math.abs(change) >= 3
              ? 'alert-mid'
              : 'alert-low';

      const average90 = num(item.weightedAverage90Days);
      const change90 = num(item.changeVs90DaysAveragePercent);
      const change90Class = change90 === null ? 'flat' : change90 > 0 ? 'up' : change90 < 0 ? 'down' : 'flat';

      return `<article class="price-card ${borderClass}" data-price-id="${esc(item.ingredientId)}">
        <div class="price-head">
          <div><h3>${esc(item.ingredient)}</h3><div class="muted small">${esc(item.category || 'Senza categoria')} · ${esc(item.supplier || '')}</div></div>
          <div class="price-value">${fmt(item.latestPrice, 4)}</div>
        </div>
        <div class="meta-grid">
          <div class="meta"><small>Precedente</small><strong>${item.previousPrice === '' ? '—' : fmt(item.previousPrice, 4)}</strong></div>
          <div class="meta"><small>Variazione</small><strong class="delta ${changeClass}">${change === null ? '—' : (change > 0 ? '+' : '') + fmt(change, 2) + '%'}</strong></div>
        </div>
        <div class="price-submetrics">
          <div class="meta"><small>Media 90 gg</small><strong>${average90 === null ? '—' : fmt(average90, 4)}</strong></div>
          <div class="meta"><small>Vs media 90 gg</small><strong class="delta ${change90Class}">${change90 === null ? '—' : (change90 > 0 ? '+' : '') + fmt(change90, 2) + '%'}</strong></div>
        </div>
        <div class="muted small" style="margin-top:9px">${esc(item.unit)} · ultimo acquisto ${esc(formatDateIt(item.lastPurchaseDate || ''))}</div>
      </article>`;
    }).join('') || '<div class="status-card">Nessun prezzo disponibile.</div>';

    qsa('[data-price-id]').forEach(card => {
      card.addEventListener('click', () => openPriceDetail(card.dataset.priceId));
    });
  }

  function openPriceDetail(id) {
    const item = state.allPrices.find(value => value.ingredientId === id);
    if (!item) return;

    $('priceDetailTitle').textContent = item.ingredient;
    $('priceDetailSubtitle').textContent = `${item.category || 'Senza categoria'} · ${item.unit || ''}`;

    const kpis = [
      ['Ultimo prezzo', fmt(item.latestPrice, 5) + ' ' + (item.unit || '')],
      ['Prezzo precedente', item.previousPrice === '' ? '—' : fmt(item.previousPrice, 5) + ' ' + (item.unit || '')],
      ['Media 90 gg', item.weightedAverage90Days === '' ? '—' : fmt(item.weightedAverage90Days, 5) + ' ' + (item.unit || '')],
      ['Media storica', item.weightedAverageHistorical === '' ? '—' : fmt(item.weightedAverageHistorical, 5) + ' ' + (item.unit || '')],
      ['Min storico', item.minHistoricalPrice === '' ? '—' : fmt(item.minHistoricalPrice, 5) + ' ' + (item.unit || '')],
      ['Max storico', item.maxHistoricalPrice === '' ? '—' : fmt(item.maxHistoricalPrice, 5) + ' ' + (item.unit || '')]
    ];

    $('priceDetailKpis').innerHTML = kpis.map(kpi =>
      `<div class="kpi-card"><small>${esc(kpi[0])}</small><strong>${esc(kpi[1])}</strong></div>`
    ).join('');

    const history = item.history || [];
    $('priceHistoryTable').innerHTML =
      '<div class="history-row head"><span>Data</span><span>Fornitore</span><span class="history-qty">Quantità</span><strong>Prezzo</strong></div>' +
      history.slice().reverse().map(entry => `
        <div class="history-row">
          <span>${esc(formatDateIt(entry.date))}</span>
          <span>${esc(entry.supplier || '—')}</span>
          <span class="history-qty">${entry.quantity === '' ? '—' : fmt(entry.quantity, 3)}</span>
          <strong>${fmt(entry.price, 5)}</strong>
        </div>`).join('');

    renderPriceChart(item);
    $('priceDetailModal').classList.remove('hidden');
  }

  function closePriceDetail() {
    $('priceDetailModal').classList.add('hidden');
    if (state.priceChart) {
      state.priceChart.destroy();
      state.priceChart = null;
    }
  }

  function renderPriceChart(item) {
    if (state.priceChart) state.priceChart.destroy();
    if (!window.Chart) {
      toast('Grafico non disponibile.');
      return;
    }

    const history = item.history || [];
    const context = $('priceChart').getContext('2d');

    state.priceChart = new Chart(context, {
      type: 'line',
      data: {
        labels: history.map(entry => formatDateIt(entry.date)),
        datasets: [
          {
            label: 'Prezzo reale',
            data: history.map(entry => num(entry.price)),
            borderColor: '#DFA145',
            backgroundColor: '#DFA145',
            pointRadius: 4,
            tension: 0,
            spanGaps: false
          },
          {
            label: 'Media ponderata 90 gg',
            data: history.map(entry => num(entry.rollingAverage90Days)),
            borderColor: '#8f939b',
            backgroundColor: '#8f939b',
            borderDash: [6, 4],
            pointRadius: 0,
            tension: 0.2,
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {mode: 'index', intersect: false},
        plugins: {
          legend: {labels: {color: '#f2f2f3'}},
          tooltip: {
            callbacks: {
              label: context => `${context.dataset.label}: ${fmt(context.parsed.y, 5)} ${item.unit || ''}`
            }
          }
        },
        scales: {
          x: {ticks: {color: '#aaaab0'}, grid: {color: 'rgba(255,255,255,.06)'}},
          y: {ticks: {color: '#aaaab0'}, grid: {color: 'rgba(255,255,255,.06)'}}
        }
      }
    });
  }

  function formatDateIt(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
  }

  function canonicalUnitClient(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const unit = raw.toLowerCase().replace(/\s+/g, '');
    if (['kg', '€/kg', '€kg', 'l', 'lt', '€/l', '€l'].includes(unit)) return '€/kg';
    if (['pz', 'pz.', 'pezzo', 'pezzi', 'nr', '€/pz', '€/pezzo', '€pz'].includes(unit)) return '€/pz';
    if (['ct', 'cf', 'conf', 'confezione', 'confezioni', '€/confezione', '€confezione'].includes(unit)) return '€/confezione';
    return raw;
  }

  function unitOptionsHtml(selected = '') {
    const value = canonicalUnitClient(selected);
    const all = [...state.units];
    if (value && !all.includes(value)) all.push(value);

    return [
      '<option value="">— Seleziona —</option>',
      ...all.map(unit => `<option value="${esc(unit)}" ${unit === value ? 'selected' : ''}>${esc(unit)}</option>`),
      '<option value="__NEW__">＋ Aggiungi nuova unità</option>'
    ].join('');
  }

  function populateUnitSelect(select, selected = '') {
    select.innerHTML = unitOptionsHtml(selected);
  }

  function ensureOptionAndSelect(select, value) {
    const normalized = canonicalUnitClient(value);
    if (!normalized) return;

    if (![...select.options].some(option => option.value === normalized)) {
      const option = document.createElement('option');
      option.value = normalized;
      option.textContent = normalized;
      select.insertBefore(option, select.lastElementChild);
    }

    select.value = normalized;
  }

  async function createUnitFromPrompt() {
    const raw = window.prompt('Scrivi la nuova unità da salvare, ad esempio €/metro:');
    if (!raw?.trim()) return '';

    try {
      const result = await api('create_tracking_unit', {unit: raw.trim()}, {attempts: 1});
      state.units = result.units || state.units;
      return result.unit;
    } catch (error) {
      toast(error.message);
      return '';
    }
  }

  function populateCategorySelect(selected = '') {
    const values = [...state.categories];
    if (selected && !values.includes(selected)) values.push(selected);

    $('ingredientModalCategory').innerHTML =
      '<option value="">— Seleziona categoria —</option>' +
      values.sort((a, b) => a.localeCompare(b, 'it'))
        .map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`)
        .join('') +
      '<option value="__NEW__">＋ Aggiungi nuova categoria</option>';
  }

  function populateSubcategorySelect(category, selected = '') {
    const values = [...(state.subcategoriesByCategory[category] || [])];
    if (selected && !values.includes(selected)) values.push(selected);

    $('ingredientModalSubcategory').innerHTML =
      '<option value="">— Seleziona sottocategoria —</option>' +
      values.sort((a, b) => a.localeCompare(b, 'it'))
        .map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`)
        .join('') +
      '<option value="__NEW__">＋ Aggiungi nuova sottocategoria</option>';
  }

  function handleCategorySelection() {
    const select = $('ingredientModalCategory');
    const isNew = select.value === '__NEW__';
    $('ingredientModalNewCategoryWrap').classList.toggle('hidden', !isNew);
    populateSubcategorySelect(isNew ? $('ingredientModalNewCategory').value.trim() : select.value, '');
    $('ingredientModalNewSubcategoryWrap').classList.add('hidden');
  }

  function handleSubcategorySelection() {
    $('ingredientModalNewSubcategoryWrap').classList.toggle(
      'hidden',
      $('ingredientModalSubcategory').value !== '__NEW__'
    );
  }

  function selectedCategoryValue() {
    return $('ingredientModalCategory').value === '__NEW__'
      ? $('ingredientModalNewCategory').value.trim()
      : $('ingredientModalCategory').value;
  }

  function selectedSubcategoryValue() {
    return $('ingredientModalSubcategory').value === '__NEW__'
      ? $('ingredientModalNewSubcategory').value.trim()
      : $('ingredientModalSubcategory').value;
  }

  function openIngredientModal() {
    $('ingredientModalTitle').textContent = 'Nuovo ingrediente / prodotto';
    $('ingredientModalName').value = '';
    populateCategorySelect('');
    populateSubcategorySelect('', '');
    $('ingredientModalNewCategoryWrap').classList.add('hidden');
    $('ingredientModalNewSubcategoryWrap').classList.add('hidden');
    $('ingredientModalNewCategory').value = '';
    $('ingredientModalNewSubcategory').value = '';
    populateUnitSelect($('ingredientModalUnit'), '');
    $('ingredientModal').classList.remove('hidden');
    window.setTimeout(() => $('ingredientModalName').focus(), 50);
  }

  function closeIngredientModal() {
    $('ingredientModal').classList.add('hidden');
    state.newIngredientRowId = '';
  }

  async function submitNewIngredient(event) {
    event.preventDefault();

    const unitSelect = $('ingredientModalUnit');
    if (unitSelect.value === '__NEW__') {
      const unit = await createUnitFromPrompt();
      if (!unit) return;
      populateUnitSelect(unitSelect, unit);
    }

    const category = selectedCategoryValue();
    const subcategory = selectedSubcategoryValue();

    if (!category) {
      toast('Seleziona o inserisci una categoria');
      return;
    }
    if (!subcategory) {
      toast('Seleziona o inserisci una sottocategoria');
      return;
    }

    try {
      const result = await api('create_ingredient', {
        name: $('ingredientModalName').value.trim(),
        category,
        subcategory,
        unit: unitSelect.value
      }, {attempts: 1});

      state.ingredients.push(result.ingredient);
      state.ingredients.sort((a, b) => a.name.localeCompare(b.name, 'it'));
      state.categories = result.categories || state.categories;
      state.subcategoriesByCategory = result.subcategoriesByCategory || state.subcategoriesByCategory;

      const rowId = state.newIngredientRowId;
      closeIngredientModal();

      const element = document.querySelector(`[data-row-id="${cssEsc(rowId)}"]`);
      if (element) {
        const select = element.querySelector('.ingredient-select');
        const option = document.createElement('option');
        option.value = result.ingredient.id;
        option.textContent = `${result.ingredient.name}${result.ingredient.category ? ' · ' + result.ingredient.category : ''}`;
        select.appendChild(option);
        select.value = result.ingredient.id;
        ensureOptionAndSelect(element.querySelector('.tracking-unit-select'), result.ingredient.unit);
      }

      toast(`${result.ingredient.id} creato`);
    } catch (error) {
      toast(error.message);
    }
  }

  function setLoader(show, text = 'Elaborazione…') {
    $('loader').classList.toggle('hidden', !show);
    $('loaderText').textContent = text;
  }

  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('show');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => element.classList.remove('show'), 4000);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[character]));
  }

  function fmt(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString('it-IT', {maximumFractionDigits: digits})
      : '—';
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString('it-IT', {style: 'currency', currency: 'EUR'})
      : '—';
  }

  function num(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cssEsc(value) {
    return window.CSS?.escape
      ? window.CSS.escape(String(value))
      : String(value).replace(/"/g, '\\"');
  }
})();

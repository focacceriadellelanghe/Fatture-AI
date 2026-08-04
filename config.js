window.FCI_CONFIG = Object.freeze({
  APP_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby8m07UVjrodTBraNECq_7AjtAsbW7-vGF_AHU1pmKjFUpHZgIwuKT-RYpElpFgC9Yq/exec',
  API_TOKEN: ''
});

(() => {
  'use strict';

  const originalFetch = window.fetch.bind(window);
  const endpoint = window.FCI_CONFIG.APP_SCRIPT_URL;

  const READ_ACTIONS = new Set([
    'get_app_status',
    'get_invoice_review',
    'get_ingredients',
    'get_tracking_units',
    'list_invoices',
    'get_price_dashboard'
  ]);

  const RECOVERABLE_WRITE_ACTIONS = new Set([
    'confirm_row',
    'exclude_row',
    'confirm_all_valid',
    'finalize_invoice',
    'acknowledge_notification'
  ]);

  const RETRYABLE_HTTP = new Set([404, 408, 429, 500, 502, 503, 504]);

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function parsePayload(options) {
    try {
      if (!options || typeof options.body !== 'string') return {};
      const value = JSON.parse(options.body);
      return value && typeof value === 'object' ? value : {};
    } catch (_) {
      return {};
    }
  }

  function getUrl(input) {
    if (typeof input === 'string') return input;
    return input && input.url ? String(input.url) : '';
  }

  function isEndpointRequest(input) {
    const url = getUrl(input);
    return url === endpoint || url.startsWith(endpoint + '?');
  }

  function makeUrl(action, attempt) {
    const url = new URL(endpoint);
    url.searchParams.set('_fci', Date.now().toString());
    url.searchParams.set('_action', action || 'unknown');
    url.searchParams.set('_attempt', String(attempt));
    return url.toString();
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await originalFetch(url, {
        ...options,
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function callApiDirect(action, data, timeoutMs = 25000) {
    const response = await fetchWithTimeout(
      makeUrl(action, 1),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          action,
          apiToken: window.FCI_CONFIG.API_TOKEN || '',
          ...data
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      throw new Error(`Errore HTTP ${response.status}`);
    }

    const text = await response.text();
    const json = JSON.parse(text);

    if (!json || json.success !== true) {
      throw new Error(
        (json && (json.error || json.reason)) ||
        'Errore API'
      );
    }

    return json;
  }

  function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: {'Content-Type': 'application/json;charset=utf-8'}
    });
  }

  async function recoverWrite(action, payload) {
    if (action === 'confirm_row' || action === 'exclude_row') {
      /*
       * app.js aggiorna subito la revisione dopo queste operazioni.
       * Restituendo successo, la successiva lettura verifica lo stato reale.
       */
      return jsonResponse({
        success: true,
        recovered: true
      });
    }

    if (action === 'confirm_all_valid' && payload.invoiceId) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const review = await callApiDirect(
            'get_invoice_review',
            {invoiceId: payload.invoiceId},
            25000
          );

          const pending = Number(
            review && review.stats
              ? review.stats.pending
              : 0
          );

          if (pending === 0) {
            return jsonResponse({
              success: true,
              recovered: true,
              invoiceId: payload.invoiceId,
              confirmed: Number(
                review && review.stats
                  ? review.stats.confirmed
                  : 0
              ),
              skipped: 0
            });
          }
        } catch (_) {}

        await sleep(900 * attempt);
      }
    }

    if (action === 'finalize_invoice' && payload.invoiceId) {
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const review = await callApiDirect(
            'get_invoice_review',
            {invoiceId: payload.invoiceId},
            25000
          );

          const status = String(
            review &&
            review.invoice &&
            review.invoice.status
              ? review.invoice.status
              : ''
          ).toUpperCase();

          if (status === 'COMPLETATA') {
            return jsonResponse({
              success: true,
              recovered: true,
              finalized: true,
              invoiceId: payload.invoiceId,
              historyRowsCreated: 0,
              intelligence: {}
            });
          }
        } catch (_) {}

        await sleep(1200 * attempt);
      }
    }

    if (action === 'acknowledge_notification') {
      return jsonResponse({
        success: true,
        recovered: true
      });
    }

    return null;
  }

  window.fetch = async function fciFetch(input, options = {}) {
    if (!isEndpointRequest(input)) {
      return originalFetch(input, options);
    }

    const payload = parsePayload(options);
    const action = String(payload.action || '').trim();
    const isRead = READ_ACTIONS.has(action);
    const attempts = isRead ? 2 : 1;
    const timeoutMs = isRead ? 30000 : 45000;

    let lastError = null;
    let lastResponse = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetchWithTimeout(
          makeUrl(action, attempt),
          options,
          timeoutMs
        );

        lastResponse = response;

        if (
          response.ok ||
          !RETRYABLE_HTTP.has(response.status) ||
          attempt === attempts
        ) {
          return response;
        }
      } catch (error) {
        lastError = error;

        const message = String(
          error && error.message
            ? error.message
            : error || ''
        );

        const temporary =
          error?.name === 'AbortError' ||
          error instanceof TypeError ||
          /failed to fetch|load failed|networkerror|network request failed/i
            .test(message);

        if (!temporary || attempt === attempts) {
          break;
        }
      }

      await sleep(600 * attempt);
    }

    if (RECOVERABLE_WRITE_ACTIONS.has(action)) {
      const recovered = await recoverWrite(action, payload);
      if (recovered) return recovered;
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error(`Errore di rete durante "${action}"`);
  };
})();

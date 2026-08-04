window.FCI_CONFIG = Object.freeze({
  APP_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby8m07UVjrodTBraNECq_7AjtAsbW7-vGF_AHU1pmKjFUpHZgIwuKT-RYpElpFgC9Yq/exec',
  API_TOKEN: ''
});

(() => {
  'use strict';

  const originalFetch = window.fetch.bind(window);
  const appsScriptUrl = window.FCI_CONFIG.APP_SCRIPT_URL;

  /*
   * Queste operazioni modificano dati.
   * Non devono essere ripetute automaticamente, perché la prima richiesta
   * potrebbe essere stata eseguita da Apps Script anche se la risposta
   * non è arrivata correttamente al browser.
   */
  const nonRetryableActions = new Set([
    'upload_and_analyze',
    'upload_group_and_analyze',
    'create_tracking_unit',
    'create_ingredient',
    'update_row',
    'confirm_row',
    'exclude_row',
    'confirm_all_valid',
    'finalize_invoice',
    'acknowledge_notification',
    'rebuild_intelligence',
    'rebuild_price_analysis',
    'backfill_v122'
  ]);

  /*
   * Errori temporanei sui quali è ragionevole riprovare
   * esclusivamente per le operazioni di lettura.
   */
  const retryableStatuses = new Set([
    404,
    408,
    429,
    500,
    502,
    503,
    504
  ]);

  function sleep(milliseconds) {
    return new Promise(resolve => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function readAction(options) {
    try {
      if (!options || typeof options.body !== 'string') {
        return '';
      }

      const payload = JSON.parse(options.body);

      return String(
        payload && payload.action
          ? payload.action
          : ''
      ).trim();
    } catch (_) {
      return '';
    }
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') {
      return input;
    }

    if (input && input.url) {
      return input.url;
    }

    return '';
  }

  function isAppsScriptRequest(input) {
    const requestUrl = getRequestUrl(input);

    return (
      requestUrl === appsScriptUrl ||
      requestUrl.startsWith(appsScriptUrl + '?')
    );
  }

  function withCacheBuster(input, action, attempt) {
    const requestUrl = getRequestUrl(input);
    const url = new URL(requestUrl);

    url.searchParams.set('_fci', Date.now().toString());
    url.searchParams.set('_attempt', String(attempt));

    if (action) {
      url.searchParams.set('_action', action);
    }

    return url.toString();
  }

  window.fetch = async function fciFetch(input, options = {}) {
    /*
     * Le richieste che non riguardano Apps Script, per esempio Chart.js,
     * continuano a usare fetch normalmente.
     */
    if (!isAppsScriptRequest(input)) {
      return originalFetch(input, options);
    }

    const action = readAction(options);
    const maxAttempts = nonRetryableActions.has(action) ? 1 : 3;

    let lastError = null;
    let lastResponse = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestUrl = withCacheBuster(
          input,
          action,
          attempt
        );

        const requestOptions = Object.assign(
          {},
          options,
          {
            redirect: 'follow',
            cache: 'no-store'
          }
        );

        const response = await originalFetch(
          requestUrl,
          requestOptions
        );

        lastResponse = response;

        const shouldRetry =
          retryableStatuses.has(response.status) &&
          attempt < maxAttempts;

        if (!shouldRetry) {
          return response;
        }
      } catch (error) {
        lastError = error;

        const message = String(
          error && error.message
            ? error.message
            : ''
        );

        const isNetworkError =
          error instanceof TypeError ||
          /failed to fetch|load failed|networkerror|network request failed/i
            .test(message);

        if (!isNetworkError || attempt === maxAttempts) {
          throw error;
        }
      }

      /*
       * Attesa progressiva:
       * dopo il primo errore 700 ms;
       * dopo il secondo errore 1.400 ms.
       */
      await sleep(700 * attempt);
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw (
      lastError ||
      new Error(
        'Errore di rete durante la chiamata Apps Script'
      )
    );
  };
})();

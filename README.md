# Fatture-AI — Food Cost Intelligence POC

Proof of Concept per validare questa architettura:

```text
GitHub Pages
    ↓
Google Apps Script
    ↓
Google Sheets
```

## Obiettivo del test

Il test è superato solo quando:

1. la pagina GitHub Pages invia una richiesta;
2. Apps Script riceve il payload;
3. Apps Script scrive una nuova riga nel foglio `API_TEST`;
4. il frontend mostra `Operazione completata`.

## File

- `index.html`: frontend mobile pubblicato su GitHub Pages.
- `Code.gs`: backend da copiare in Google Apps Script.
- `ISTRUZIONI.md`: procedura operativa completa.

## Vincolo

Non sviluppare OCR, fotocamera, dashboard o altre funzioni finché questo test non funziona in modo affidabile.

# ISTRUZIONI OPERATIVE — POC FOOD COST INTELLIGENCE

## 1. Carica i file su GitHub

Nel repository `Fatture-AI`:

1. clicca **Add file**;
2. clicca **Upload files**;
3. carica `index.html`, `README.md` e `ISTRUZIONI.md`;
4. conferma con **Commit changes**.

Il file `Code.gs` va copiato in Google Apps Script.

## 2. Recupera l'ID del Google Sheet

Apri il file Google Sheets `Menù Primavera/Estate AI`.

Nell'URL, copia la parte compresa tra `/d/` e `/edit`.

## 3. Crea il backend Apps Script

Dal Google Sheet:

1. apri **Estensioni → Apps Script**;
2. elimina il codice presente;
3. copia il contenuto del file `Code.gs`;
4. sostituisci `INCOLLA_QUI_ID_DEL_GOOGLE_SHEET` con l'ID reale;
5. salva il progetto come `Food Cost Intelligence API`.

## 4. Pubblica Apps Script come Web App

1. clicca **Distribuisci → Nuova distribuzione**;
2. seleziona **App web**;
3. imposta **Esegui come: Me**;
4. imposta **Chi ha accesso: Chiunque**;
5. distribuisci e autorizza;
6. copia l'URL che termina con `/exec`.

## 5. Attiva GitHub Pages

Nel repository:

1. apri **Settings → Pages**;
2. Source: `Deploy from a branch`;
3. Branch: `main`;
4. Folder: `/root`;
5. salva.

URL previsto:

```text
https://focacceriadellelanghe.github.io/Fatture-AI/
```

## 6. Esegui il test

1. apri la pagina GitHub Pages;
2. incolla l'URL Apps Script;
3. clicca **Invia test al database**.

Il risultato corretto è `Operazione completata` e nel Google Sheet compare il tab `API_TEST` con una nuova riga.

## 7. Criterio di collaudo

Il livello è validato soltanto se:

- il test funziona da desktop;
- il test funziona da smartphone;
- vengono create più righe consecutive;
- un errore viene mostrato correttamente.

# ISTRUZIONI V2 — CARICAMENTO FATTURA SENZA OCR

## Obiettivo

Validare questo flusso:

```text
GitHub Pages
→ selezione foto/PDF
→ Apps Script
→ cartella Drive annuale
→ foglio FATTURE
```

Non viene ancora eseguito alcun OCR.

---

## 1. Aggiorna GitHub

Nel repository `Fatture-AI`:

1. apri `index.html`;
2. clicca l'icona della matita;
3. sostituisci tutto il contenuto con il nuovo `index.html`;
4. clicca **Commit changes**.

In alternativa usa **Add file → Upload files** e sostituisci il file esistente.

GitHub Pages aggiornerà automaticamente il sito.

---

## 2. Aggiorna Apps Script

Nel progetto `Food Cost Intelligence API`:

1. apri `Code.gs`;
2. sostituisci tutto il codice con il nuovo contenuto;
3. reinserisci il vero ID del Google Sheet in:

```javascript
const SPREADSHEET_ID = 'INCOLLA_QUI_ID_DEL_GOOGLE_SHEET';
```

4. salva.

---

## 3. Crea una nuova versione del deployment

Questa parte è obbligatoria. Salvare il codice non aggiorna automaticamente il Web App già pubblicato.

1. clicca **Esegui il deployment → Gestisci deployment**;
2. clicca l'icona della matita;
3. in **Versione** scegli **Nuova versione**;
4. inserisci una descrizione, per esempio:

```text
V2 caricamento fatture
```

5. clicca **Esegui il deployment**.

L'URL `/exec` dovrebbe restare lo stesso.

---

## 4. Esegui il test

Apri:

```text
https://focacceriadellelanghe.github.io/Fatture-AI/
```

Compila:

- data fattura;
- numero fattura;
- fornitore;
- totale facoltativo;
- presenza del cartaceo;
- foto o PDF.

Poi clicca:

```text
Carica e registra fattura
```

---

## 5. Risultato atteso

Su Google Drive deve comparire:

```text
Food Cost Intelligence
└── Fatture
    └── 2026
        └── documento caricato
```

Nel Google Sheet deve comparire il tab:

```text
FATTURE
```

con:

- ID fattura;
- data;
- fornitore;
- numero fattura;
- totale;
- link Drive;
- anno archivio;
- stato documento digitale;
- disponibilità cartacea;
- ID tecnico del file Drive.

---

## 6. Criterio di collaudo

La V2 è validata solo se:

- una foto viene caricata da smartphone;
- un PDF viene caricato da desktop;
- entrambi vengono archiviati nella cartella annuale corretta;
- il link Drive nel foglio funziona;
- data, numero fattura e fornitore vengono registrati correttamente;
- due fatture consecutive generano due ID diversi.

Non passare all'OCR prima di aver completato tutti questi test.

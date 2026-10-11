# Coding Pilot

Kontierung von Staking- und Wertschriftenbelegen im Browser. Live unter **https://munot.app/codingpilot** (Google-Login über Cloudflare Access).

Die Seiten lesen PDF-Belege nur im Browser (PDF.js). Weder die PDF-Datei noch daraus gelesene Werte gehen an Cloudflare oder GitHub. Das Backend bekommt genau zwei Arten von Anfragen:

| Anfrage | Was übertragen wird |
|---|---|
| `GET /codingpilot/api/reference` | nichts (keine Parameter); liefert Stammdaten, Tageskurse und gelernte Regeln |
| `POST /codingpilot/api/rules` | genau eine gelernte Zuordnung (RuleType, Schlüssel, Wert), wenn auf "Merken" geklickt wird |

Auch die Bibliotheken (PDF.js, SheetJS) liegen im Repo (`public/codingpilot/vendor/`) statt auf einem CDN.

## Seiten

- **Staking** (`/codingpilot/staking`): ETH/SOL-Staking-Belege auslesen, AmtLC/AmtCHF mit Tageskursen berechnen.
- **Wertschriftentransaktionen** (`/codingpilot/wertschriften`): Kauf/Verkauf von Wertschriften & Krypto (Swissquote) und Raiffeisen-Zeichnungen. Abgleich mit `security_master`, Umrechnung zwischen Handels-, Sicherheitswährung und CHF, FIBU-Konten über gelernte Regeln.

Beide Seiten erzeugen eine Datei `entries_<Modul>_<Datum>.xlsx` mit den Tabs **FIBU** und **Securities** und benennen das PDF lokal nach einem festen Schema um.

## Architektur

```
Browser (Google-Login via Cloudflare Access)
   │
   └── munot.app/codingpilot*        Worker "codingpilot" (dieses Repo)
         ├── public/codingpilot/     statische Seiten (Workers Static Assets)
         ├── /api/reference  ──────► D1 "securities"  (security_master, security_prices; nur lesend)
         │                   ──────► D1 "codingpilot" (codingpilot_rules)
         └── /api/rules      ──────► D1 "codingpilot" (codingpilot_rules)
```

GitHub dient nur noch dem Deployment: Cloudflare Workers Builds deployt bei jedem Push auf `main`. Es gibt keine GitHub Actions, keine CSV-Dateien im Repo und keinen Turso-Zugriff mehr.

### Worker (`src/index.js`)

- `/codingpilot` und `/codingpilot/` → Redirect auf die Wertschriften-Seite
- `GET /codingpilot/api/reference` → `{ user, priceIds, master, prices, rules }`
  - `prices`: pro Security und Kalendertag der letzte Kurs, letzte 730 Tage, für ETH (40149561), SOL (22000), USD/CHF (275000) und EUR/CHF (897789). Anpassen über `PRICE_IDS` / `PRICE_DAYS_BACK`.
- `POST /codingpilot/api/rules` → Regel speichern (Upsert). Nur same-origin; Schlüsselspalten werden pro RuleType geprüft.

Alle `/api/`-Routen verlangen ein Cloudflare-Access-Token. Sind `ACCESS_TEAM_DOMAIN` und `ACCESS_AUD` gesetzt, prüft der Worker das JWT vollständig (Signatur, Audience, Ablauf). workers.dev- und Preview-URLs sind deaktiviert.

### Gelernte Regeln (`codingpilot_rules`)

Generische Struktur `RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID, Value`; ein RuleType legt fest, welche Spalten Schlüssel sind:

| RuleType | Schlüssel | Beispiel-Value |
|---|---|---|
| `CustodyID` | Broker + AccountOwner | `SQ PG` |
| `ProjectID` | SecurityID | `INV_Solana_2025 ff.` |
| `EntryNo` | SecurityID | `SOL - Solana - Transactions` |
| `FIBUKonto` | Broker + AccountOwner + Currency | `SQ WS USD PG (#315)` |
| `FIBU_Depot` | CustodyID | `WS SQ Depot - Costs PG` |

Die sechs Swissquote-Bankkonten sind als Startbelegung im Code (`FIBU_BANK_DEFAULTS` in `wertschriften.html`) und werden von einer gelernten Regel überschrieben. Schema: `schema/d1_schema.sql`. Jede Zeile speichert zusätzlich, wer sie wann zuletzt geändert hat (`updated_by`, `updated_at`).

## Setup (einmalig)

1. **D1 `codingpilot`**: ist angelegt (`bed9ee45-…`), Tabelle und die 24 bisherigen Regeln aus `Data/codingpilot_rules.csv` sind übernommen.
2. **Worker verbinden**: Cloudflare Dashboard → Workers & Pages → Create → *Import a repository* → `Munotstadt/codingpilot`, Root-Verzeichnis `/`. Der Name muss `codingpilot` sein (wie in `wrangler.jsonc`).
3. **Route**: `wrangler.jsonc` legt die Route `munot.app/codingpilot*` an. Dafür braucht die Zone `munot.app` einen proxied DNS-Eintrag für die Apex-Domain `munot.app` (orange Wolke).
4. **Cloudflare Access**: Zero Trust → Access → Applications → *Self-hosted*, Public Hostname `munot.app`, Pfad `codingpilot`. Identity Provider Google, Policy z. B. feste E-Mail-Liste (wie bei energy.munot.app).
5. **JWT-Prüfung** (empfohlen): im Worker unter Settings → Variables and Secrets setzen:
   - `ACCESS_TEAM_DOMAIN`: z. B. `<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: "Application Audience (AUD) Tag" der Access-Application aus Schritt 4

   `keep_vars` in `wrangler.jsonc` sorgt dafür, dass Deploys diese Werte nicht überschreiben.

## Lokal testen

```bash
npx wrangler d1 execute codingpilot --local --file schema/d1_schema.sql
npx wrangler dev --local
```

Die lokale D1 `securities` braucht `security_master` und `security_prices` mit Testdaten. Die API-Routen erwarten den Header `Cf-Access-Jwt-Assertion` (lokal ohne gesetzte Access-Vars reicht ein beliebiger Wert).

## Versionierung

`APP_VERSION` in `public/codingpilot/common.js` wird an jedem Tag mit Anpassungen um eins erhöht. Sie steht in der Fusszeile und in der `Source`-Spalte des Securities-Tabs. Aktuell: **V2 - 11.10.2026**.

## Bekannte Einschränkungen

- **Krypto-Matching:** Ohne ISIN läuft der Stammdaten-Abgleich über einen ungefähren Namensvergleich (Ticker gegen `SecurityName`). Bei mehrdeutigen Namen manuell korrigieren.
- **Kurse:** Die Seiten verwenden den letzten Tageskurs am oder vor dem Transaktionsdatum (bis 730 Tage zurück).

## Dateistruktur

```
codingpilot/
├── wrangler.jsonc
├── src/index.js                 Worker (API + Routing)
├── schema/d1_schema.sql         D1 "codingpilot"
└── public/codingpilot/
    ├── staking.html
    ├── wertschriften.html
    ├── app.css                  Layout analog energy.munot.app
    ├── common.js                PDF lesen, Referenzdaten, Regeln, Excel-Export
    └── vendor/                  PDF.js 3.11.174, SheetJS 0.18.5
```

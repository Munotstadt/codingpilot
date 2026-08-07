# Coding Pilot

Browserbasierte Tools zur Beleg-Kontierung für Wertschriften-, Krypto- und Staking-Transaktionen. Belege werden vollständig lokal im Browser gelesen (PDF.js) — die PDF-Datei selbst verlässt den Browser nie, nur die daraus erfassten und geprüften Tabellenwerte werden übertragen.

**Live:** `index.html` als Einstiegspunkt (z.B. via GitHub Pages).

---

## Inhalt

- [Überblick](#überblick)
- [Seiten](#seiten)
- [Datenfluss](#datenfluss)
- [GitHub Actions](#github-actions)
- [Datendateien](#datendateien-data)
- [Gelernte Regeln](#gelernte-regeln-codingpilot_rulescsv)
- [Setup](#setup)
- [Versionierung](#versionierung)
- [Bekannte Einschränkungen / offene Punkte](#bekannte-einschränkungen--offene-punkte)
- [Dateistruktur](#dateistruktur)

---

## Überblick

Coding Pilot liest Transaktionsbelege (Swissquote, Raiffeisen) clientseitig aus, gleicht sie gegen Referenzdaten aus Turso ab (via GitHub als Zwischenspeicher, dazu unten mehr) und erzeugt Buchungsvorschläge als Excel-Export. Zwei funktionale Module:

| Modul | Datei | Zweck |
|---|---|---|
| Staking | `staking.html` | ETH/SOL-Staking-Erträge: Netto-Gutschrift auslesen, Kurswert berechnen, Buchungsvorschlag |
| Wertschriften | `wertschriften.html` | Kauf/Verkauf von Wertschriften & Krypto: Stammdaten-Abgleich, Mehrwährungsumrechnung, Buchungsvorschlag |

Beide Module sind eigenständige, einzelne HTML-Dateien (kein Build-Prozess, kein Server nötig — direkt aus dem Repo oder via GitHub Pages nutzbar).

## Seiten

- **`index.html`** — Übersichtsseite mit Links zu allen Modulen und einer Kurzübersicht der Infrastruktur.
- **`staking.html`** — Staking-Modul. Liest Crypto Asset, Transaktionsdatum, Netto-Quantity und Transaktionsnummer aus dem Beleg; berechnet `AmtLC`/`AmtCHF` anhand importierter Kurse; erzeugt `FIBUentries.xlsx` und `WSentries.xlsx`; benennt das PDF lokal um.
- **`wertschriften.html`** — Wertschriften-Modul. Erkennt Swissquote-Börsentransaktionen (Kauf/Verkauf, Wertschriften & Krypto) sowie Raiffeisen-Zeichnungen; matched die Wertschrift gegen `security_master`; rechnet Handelswährung/Sicherheitswährung/CHF um; löst Konten (Kosten-, Depot-, Transfer-, Bankkonto) über gelernte Regeln auf; erzeugt `FIBUentries.xlsx` und `WSentries.xlsx`.

## Datenfluss

Der Kerngedanke: **Turso-Zugriffe passieren ausschließlich serverseitig** (in GitHub Actions), nie direkt aus dem Browser — das vermeidet CORS-Probleme vollständig, ohne einen Proxy zu benötigen.

```
Turso (security_prices, security_master)
        │  (GitHub Actions, 1–2×/Tag, serverseitig)
        ▼
Data/security_prices_recent.csv
Data/security_master.csv
        │  (fetch von raw.githubusercontent.com, CORS-frei)
        ▼
staking.html / wertschriften.html  (Browser)
        │  (PDF-Belege werden hier lokal geparst)
        ▼
FIBUentries.xlsx / WSentries.xlsx  (lokaler Download)
        │
        ▼
Externes Buchhaltungstool (manueller Import)
```

Zusätzlich schreiben beide Module bei Bedarf **gelernte Kontenzuordnungen** direkt über die GitHub-Contents-API zurück nach `Data/codingpilot_rules.csv` (dafür ist ein Personal Access Token im Browser nötig, siehe [Setup](#setup)).

## GitHub Actions

| Workflow | Datei | Zeitplan | Schreibt |
|---|---|---|---|
| Import Turso Security Prices | `.github/workflows/import-turso-security-prices.yml` | 03:00 & 15:00 UTC täglich | `Data/security_prices_recent.csv` |
| Import Turso Security Master | `.github/workflows/import-turso-security-master.yml` | 03:15 UTC täglich | `Data/security_master.csv` |

Zugehörige Skripte: `scripts/import_turso_security_prices.py`, `scripts/import_turso_security_master.py` (Python, nutzen die Turso HTTP-API `/v2/pipeline`).

Beide Workflows sind zusätzlich manuell auslösbar (`workflow_dispatch`) über den Actions-Tab — sinnvoll für den ersten Lauf oder nach Schema-Änderungen.

**Preise:** Die letzten 90 Tage für SecurityIDs `40149561` (ETH), `22000` (SOL), `275000` (USD/CHF), `897789` (EUR/CHF). Weitere Securities lassen sich in `import_turso_security_prices.py` (Liste `SECURITY_IDS`) ergänzen.

**Stammdaten:** Alle Zeilen aus `security_master` (`SecurityID, SecurityName, ID_Valor, ID_ISIN, Currency`).

## Datendateien (`Data/`)

| Datei | Herkunft | Inhalt |
|---|---|---|
| `security_prices_recent.csv` | Action (automatisch) | `SecurityID, PriceDate, Price` — Kurshistorie, letzte 90 Tage |
| `security_master.csv` | Action (automatisch) | `SecurityID, SecurityName, ID_Valor, ID_ISIN, Currency` — Wertschriften-Stammdaten |
| `codingpilot_rules.csv` | App (bei "Merken"-Klick) | Generische gelernte Zuordnungen, siehe unten |

## Gelernte Regeln (`codingpilot_rules.csv`)

Statt für jede Zuordnungsart eine eigene Tabelle zu pflegen, läuft alles über eine generische Struktur:

```
RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID, Value
```

Ein `RuleType` definiert, welche Spalten als Schlüssel dienen; nicht benötigte Schlüsselspalten bleiben leer.

| RuleType | Schlüssel | Beispiel-Value |
|---|---|---|
| `CustodyID` | Broker + AccountOwner | `SQ PG` |
| `ProjectID` | SecurityID | `INV_Solana_2025 ff.` |
| `EntryNo` | SecurityID | `SOL - Solana - Staking` |
| `FIBUKonto` | Broker + AccountOwner + Currency | `SQ WS USD PG (#315)` (Bankkonto) |
| `FIBU_Depot` | CustodyID | `WS SQ Depot - Costs PG` |

Sechs Swissquote-Bankkonten (Philipp/Vero × CHF/EUR/USD) sind als Startbelegung fest im Code hinterlegt (`FIBU_BANK_DEFAULTS` in `wertschriften.html`) und werden von einer gelernten Regel automatisch überschrieben, sobald eine existiert. Alle anderen Zuordnungen (insbesondere Raiffeisen, Samantha) müssen einmalig manuell eingetragen und über den jeweiligen "Merken"-Button gespeichert werden — danach werden sie für alle künftigen Belege automatisch vorgeschlagen.

Schreibzugriffe verwenden eine Retry-Logik (bis zu 3 Versuche mit kurzem Backoff), um gelegentliche HTTP-409-Konflikte der GitHub-API bei schnell aufeinanderfolgenden Speichervorgängen abzufangen.

## Setup

1. **Repo-Secrets** (Settings → Secrets and variables → Actions):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
2. Beide Import-Workflows einmal manuell auslösen (Actions-Tab → *Run workflow*), damit `Data/security_prices_recent.csv` und `Data/security_master.csv` initial entstehen.
3. In `staking.html` / `wertschriften.html`: falls die Referenzdaten nicht automatisch laden, im Abschnitt "Referenzdaten-Import" die URLs prüfen (Standard: `raw.githubusercontent.com/<owner>/<repo>/main/Data/...`).
4. Für das Speichern gelernter Zuordnungen (`wertschriften.html`, Abschnitt "GitHub-Zugang"): ein Personal Access Token mit **Contents: Read & Write** auf dieses Repo eintragen. Nur nötig für "Merken"-Klicks, nicht fürs reine Lesen der Referenzdaten.
5. Optional: Token im Browser merken (Checkbox) — funktioniert nur außerhalb von Sandbox-/Vorschau-Umgebungen, die `localStorage` blockieren; auf einer regulär gehosteten Seite (z.B. GitHub Pages) normal nutzbar.

## Versionierung

Jede Seite zeigt unten in der Fußzeile ihre Version, z.B. `V3 - 07.08.2026`. Konvention: Version wird an jedem Tag, an dem Anpassungen vorgenommen werden, um eins erhöht (Konstante `APP_VERSION` am Anfang des jeweiligen `<script>`-Blocks). Der Wert fließt auch in die `Source`-Spalte der WSentries-Exporte ein (`CodingPilot_Staking Vx - DD.MM.YYYY` bzw. `CodingPilot_Wertschriften Vx - DD.MM.YYYY`).

Aktueller Stand (bei Erstellung dieser README): **V1 - 07.08.2026** auf beiden Modulen.

## Bekannte Einschränkungen / offene Punkte

- **Distributions-Modul** (Dividenden/Ausschüttungen) ist auf der Startseite als "geplant" markiert, aber noch nicht gebaut.
- **PDF-Umbenennung** ist nur in beiden aktiven Modulen implementiert; das Namensschema unterscheidet sich je Modul (Staking: `YYYYMMDD_{ETH|SOL}_Kauf_SQ_{Referenz}.pdf`; Wertschriften: `YYYYMMDD_VN_{ID_Valor}_{Buy|Sell}_({Cry}_{AmtLC})_{SQ|RB}_{Referenz}.pdf`).
- **Concurrency:** Die gelernten Regeln werden nur im Arbeitsspeicher der jeweiligen Browser-Session gecached; bei gleichzeitiger Nutzung durch mehrere Personen gilt "letzter Schreibvorgang gewinnt" (kein Merge).
- **Krypto-Matching:** Ohne ISIN läuft der Stammdaten-Abgleich über einen Fuzzy-Namens-Vergleich (Ticker gegen `SecurityName`) — bei mehrdeutigen Namen ggf. manuell korrigieren.

## Dateistruktur

```
codingpilot/
├── index.html
├── staking.html
├── wertschriften.html
├── scripts/
│   ├── import_turso_security_prices.py
│   └── import_turso_security_master.py
├── .github/workflows/
│   ├── import-turso-security-prices.yml
│   └── import-turso-security-master.yml
└── Data/
    ├── security_prices_recent.csv   (automatisch, nicht manuell bearbeiten)
    ├── security_master.csv          (automatisch, nicht manuell bearbeiten)
    └── codingpilot_rules.csv        (von den Apps gepflegt, manuell korrigierbar)
```

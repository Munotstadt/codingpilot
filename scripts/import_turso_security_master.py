"""
Importiert die Wertschriften-Stammdaten (security_master) aus Turso
nach Data/security_master.csv (im codingpilot-Repo).

Benötigte Secrets (Repo Settings -> Secrets and variables -> Actions):
  TURSO_DATABASE_URL   z.B. https://munotstadtsecuritydb-<org>.turso.io
  TURSO_AUTH_TOKEN     Auth-Token mit Leserecht auf die Datenbank

Falls die Spaltennamen in deinem security_master-Schema abweichen,
einfach die SELECT-Anweisung unten anpassen.
"""
import os
import sys
import csv
import requests

OUTPUT_PATH = "Data/security_master.csv"
COLUMNS = ["SecurityID", "SecurityName", "ID_Valor", "ID_ISIN", "Currency"]


def normalize_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://"):]
    elif url.startswith("wss://"):
        url = "https://" + url[len("wss://"):]
    return url


def main():
    turso_url = os.environ.get("TURSO_DATABASE_URL")
    turso_token = os.environ.get("TURSO_AUTH_TOKEN")
    if not turso_url or not turso_token:
        print("ERROR: TURSO_DATABASE_URL und TURSO_AUTH_TOKEN müssen als Secrets gesetzt sein.", file=sys.stderr)
        sys.exit(1)
    turso_url = normalize_url(turso_url)

    sql = f"SELECT {', '.join(COLUMNS)} FROM security_master ORDER BY SecurityID"

    resp = requests.post(
        f"{turso_url}/v2/pipeline",
        headers={
            "Authorization": f"Bearer {turso_token}",
            "Content-Type": "application/json",
        },
        json={"requests": [{"type": "execute", "stmt": {"sql": sql}}, {"type": "close"}]},
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()

    results = payload.get("results") or []
    if not results:
        print("ERROR: Keine Antwort von Turso erhalten.", file=sys.stderr)
        sys.exit(1)
    exec_result = results[0]
    if exec_result.get("type") == "error":
        print("ERROR: Turso meldet Fehler:", exec_result.get("error"), file=sys.stderr)
        sys.exit(1)

    result = exec_result.get("response", {}).get("result", {})
    cols = [c["name"] for c in result.get("cols", [])]
    rows = []
    for raw_row in result.get("rows", []):
        obj = {}
        for i, cell in enumerate(raw_row):
            col_name = cols[i] if i < len(cols) else f"col{i}"
            obj[col_name] = cell.get("value") if cell else None
        rows.append(obj)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow({c: r.get(c) for c in COLUMNS})

    print(f"OK: {len(rows)} Zeilen nach {OUTPUT_PATH} geschrieben.")


if __name__ == "__main__":
    main()

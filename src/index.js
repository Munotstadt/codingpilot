// codingpilot Worker — munot.app/codingpilot
//
// Statische Seiten kommen aus public/codingpilot/ (Workers Static Assets).
// Dieser Worker liefert nur Referenzdaten und speichert gelernte Regeln.
// PDF-Belege und deren Inhalte erreichen ihn nie: das Lesen der PDFs passiert
// vollständig im Browser.
//
// Routen:
//   GET  /codingpilot, /codingpilot/   -> Redirect auf die Wertschriften-Seite
//   GET  /codingpilot/api/reference    Stammdaten + Tageskurse + gelernte Regeln (keine Parameter)
//   POST /codingpilot/api/rules        eine gelernte Regel speichern (einzige Schreib-Route)
//
// Bindings (wrangler.jsonc):
//   DB_SECURITIES -> D1 "securities"  (security_master, security_prices; nur lesend)
//   DB            -> D1 "codingpilot" (codingpilot_rules)
//   ASSETS        -> public/
// Vars (Dashboard): ACCESS_TEAM_DOMAIN (z.B. "munot.cloudflareaccess.com"), ACCESS_AUD

const BASE = "/codingpilot";

// Kurse, die die Seiten für Umrechnungen brauchen (ETH/USD, SOL/USD, USD/CHF, EUR/CHF).
const PRICE_IDS = { ETH: 40149561, SOL: 22000, USDCHF: 275000, EURCHF: 897789 };
const PRICE_DAYS_BACK = 730;

// Pro RuleType die Schlüsselspalten; alle anderen bleiben leer.
const RULE_KEYS = {
  CustodyID: ["Broker", "AccountOwner"],
  ProjectID: ["SecurityID"],
  EntryNo: ["SecurityID"],
  FIBUKonto: ["Broker", "AccountOwner", "Currency"],
  FIBU_Depot: ["CustodyID"],
};
const RULE_KEY_COLUMNS = ["Broker", "AccountOwner", "Currency", "SecurityID", "CustodyID"];
const MAX_FIELD_LEN = 200;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------- Cloudflare Access ----------
// Access sitzt vor munot.app/codingpilot. Zusätzlich prüft der Worker das Access-JWT,
// sobald ACCESS_TEAM_DOMAIN und ACCESS_AUD gesetzt sind; sonst genügt der Access-Header.

let certCache = { domain: null, keys: null, fetchedAt: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function accessKeys(domain) {
  if (certCache.domain === domain && certCache.keys && Date.now() - certCache.fetchedAt < 3600_000) {
    return certCache.keys;
  }
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Access-Zertifikate nicht abrufbar");
  const { keys } = await res.json();
  certCache = { domain, keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  return payload.email || payload.sub || "unknown";
}

async function authenticatedUser(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    if (!token) return null;
    try { return await verifyAccessJwt(token, env); } catch { return null; }
  }
  return token ? (request.headers.get("Cf-Access-Authenticated-User-Email") || "unknown") : null;
}

// ---------- Referenzdaten ----------

async function loadRules(env) {
  const { results } = await env.DB.prepare(
    `SELECT RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID, Value
     FROM codingpilot_rules ORDER BY RuleType, Value`
  ).all();
  return results;
}

async function handleReference(env, user) {
  const ids = Object.values(PRICE_IDS);
  const [master, prices, rules] = await Promise.all([
    env.DB_SECURITIES.prepare(
      `SELECT SecurityID, SecurityName, ID_Valor, ID_ISIN, Currency FROM security_master ORDER BY SecurityID`
    ).all(),
    // Pro Security und Kalendertag nur der letzte Kurs des Tages.
    env.DB_SECURITIES.prepare(
      `SELECT SecurityID, PriceDate, Price FROM (
         SELECT SecurityID, substr(Price_date, 1, 10) AS PriceDate, Price,
                ROW_NUMBER() OVER (PARTITION BY SecurityID, substr(Price_date, 1, 10) ORDER BY Price_date DESC) AS rn
         FROM security_prices
         WHERE SecurityID IN (${ids.map(() => "?").join(",")})
           AND Price_date >= date('now', ?)
       ) WHERE rn = 1
       ORDER BY SecurityID, PriceDate`
    ).bind(...ids, `-${PRICE_DAYS_BACK} days`).all(),
    loadRules(env),
  ]);
  return json({
    user,
    priceIds: PRICE_IDS,
    master: master.results,
    prices: prices.results,
    rules,
    loadedAt: new Date().toISOString(),
  });
}

// ---------- Regeln speichern ----------

async function handleSaveRule(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Ungültiges JSON" }, 400); }

  const type = body?.RuleType;
  const keys = RULE_KEYS[type];
  if (!keys) return json({ error: "Unbekannter RuleType" }, 400);

  const row = { RuleType: type };
  for (const col of RULE_KEY_COLUMNS) {
    const v = keys.includes(col) ? String(body.criteria?.[col] ?? "").trim() : "";
    if (keys.includes(col) && !v) return json({ error: `${col} fehlt` }, 400);
    if (v.length > MAX_FIELD_LEN) return json({ error: `${col} zu lang` }, 400);
    row[col] = v;
  }
  const value = String(body.Value ?? "").trim();
  if (!value) return json({ error: "Value fehlt" }, 400);
  if (value.length > MAX_FIELD_LEN) return json({ error: "Value zu lang" }, 400);

  await env.DB.prepare(
    `INSERT INTO codingpilot_rules (RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID, Value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID)
     DO UPDATE SET Value = excluded.Value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(type, row.Broker, row.AccountOwner, row.Currency, row.SecurityID, row.CustodyID, value, user).run();

  return json({ ok: true, rules: await loadRules(env) });
}

// ---------- Routing ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === BASE || path === BASE + "/") {
      return Response.redirect(`${url.origin}${BASE}/wertschriften`, 302);
    }

    if (path.startsWith(BASE + "/api/")) {
      const user = await authenticatedUser(request, env);
      if (!user) return json({ error: "Nicht angemeldet" }, 401);
      try {
        if (path === BASE + "/api/reference" && request.method === "GET") {
          return await handleReference(env, user);
        }
        if (path === BASE + "/api/rules" && request.method === "POST") {
          // Nur same-origin-Aufrufe aus den eigenen Seiten.
          if (request.headers.get("Origin") !== url.origin) return json({ error: "Ungültiger Origin" }, 403);
          return await handleSaveRule(request, env, user);
        }
        return json({ error: "not found" }, 404);
      } catch (err) {
        return json({ error: err.message || "internal error" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

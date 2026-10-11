/* Coding Pilot — gemeinsame Helfer für Staking & Wertschriften.
   Datenschutz: PDFs werden nur hier im Browser gelesen. Ans Backend gehen ausschliesslich
   GET /api/reference (ohne Parameter) und POST /api/rules (eine gelernte Zuordnung). */

/* Manuell hochgezählt an jedem Tag mit Anpassungen. */
const APP_VERSION = 'V2 - 11.10.2026';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ================= Formatierung ================= */
function grab(re, t, idx){ idx = idx || 1; const m = t.match(re); return m ? m[idx].trim() : ''; }
function toISO(d){ if(!d) return ''; const m = d.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); if(!m) return ''; return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'); }
function toDDMMYYYY(iso){ if(!iso) return ''; const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/); if(!m) return ''; return m[3]+'.'+m[2]+'.'+m[1]; }
function parseSwissNumber(str){
  if(str===undefined||str===null||str==='') return null;
  const n = parseFloat(String(str).replace(/'/g,'').replace(/\s/g,'').replace(',','.'));
  return isNaN(n) ? null : n;
}
function roundTo2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function personSuffix(custody){ return (custody||'').trim().split(/\s+/).pop() || ''; }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setStatus(el, cls, text){ el.className = 'status' + (cls ? ' ' + cls : ''); el.textContent = text; }
function todayISO(){ return new Date().toISOString().slice(0,10); }

/* ================= PDF-Text lokal extrahieren ================= */
async function extractPdfText(arrayBuffer){
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer.slice(0)}).promise;
  let lines = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let lastY=null, line=[];
    for(const item of content.items){
      const y = item.transform[5];
      if(lastY!==null && Math.abs(y-lastY)>2){ lines.push(line.join(' ')); line=[]; }
      line.push(item.str); lastY=y;
    }
    if(line.length) lines.push(line.join(' '));
  }
  return lines.join('\n');
}

/* ================= Lokaler Download (PDF umbenennen, Excel) ================= */
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}
function downloadRenamedPdfBuffer(arrayBuffer, filename){
  downloadBlob(new Blob([arrayBuffer], {type:'application/pdf'}), filename);
}

/* Ein Workbook mit zwei Tabs: FIBU und Securities. */
function exportEntries(filename, fibuColumns, fibuRows, wsColumns, wsRows){
  const pick = (cols) => (r) => { const o={}; cols.forEach(c => o[c] = r[c]); return o; };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fibuRows.map(pick(fibuColumns)), {header: fibuColumns}), 'FIBU');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(wsRows.map(pick(wsColumns)), {header: wsColumns}), 'Securities');
  XLSX.writeFile(wb, filename);
}

/* ================= Referenzdaten (Cloudflare, nur lesend) ================= */
const Ref = { master: [], prices: [], rules: [], priceIds: {}, user: '', loadedAt: '' };

async function loadReference(statusEl){
  if(statusEl) setStatus(statusEl, '', 'Lade Referenzdaten…');
  try{
    const res = await fetch('api/reference', {cache:'no-store', credentials:'same-origin'});
    if(res.status === 401) throw new Error('Nicht angemeldet — Seite neu laden');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    Object.assign(Ref, await res.json());
    const userEl = document.getElementById('userEmail');
    if(userEl) userEl.textContent = Ref.user || '';
    if(statusEl) setStatus(statusEl, 'ok', '✓ ' + Ref.master.length + ' Wertschriften · ' + Ref.prices.length + ' Tageskurse · '
      + Ref.rules.length + ' gelernte Regeln · Stand ' + new Date(Ref.loadedAt).toLocaleTimeString('de-CH'));
    return true;
  } catch(e){
    if(statusEl) setStatus(statusEl, 'err', '✗ ' + e.message);
    return false;
  }
}

/* Letzter Tageskurs am oder vor dem Datum. */
function lookupPrice(securityId, dateISO){
  let best = null;
  for(const r of Ref.prices){
    if(String(r.SecurityID)!==String(securityId) || !r.PriceDate || r.PriceDate > dateISO) continue;
    if(!best || r.PriceDate > best.PriceDate) best = r;
  }
  return best ? {price: parseFloat(best.Price), date: best.PriceDate} : null;
}

/* ================= Gelernte Regeln ================= */
const RULE_COL_MAP = {broker:'Broker', owner:'AccountOwner', currency:'Currency', securityId:'SecurityID', custodyId:'CustodyID'};
function findRule(type, criteria){
  return Ref.rules.find(r => {
    if(r.RuleType !== type) return false;
    for(const k in criteria){
      if(String(r[RULE_COL_MAP[k]]||'') !== String(criteria[k]||'')) return false;
    }
    return true;
  }) || null;
}
/* Einziger Schreibzugriff: genau eine Zuordnung (Schlüssel + Wert), keine Belegdaten. */
async function saveRule(type, criteria, value){
  const crit = {};
  Object.keys(criteria).forEach(k => { crit[RULE_COL_MAP[k]] = criteria[k]; });
  const res = await fetch('api/rules', {
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({RuleType:type, criteria:crit, Value:value})
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  Ref.rules = data.rules;
}
/* "Merken"-Button: Validierung + Status-Anzeige. */
async function learn(statusEl, ok, missingMsg, type, criteria, value){
  if(!ok){ setStatus(statusEl, 'err', missingMsg); return; }
  setStatus(statusEl, '', 'Speichere…');
  try{ await saveRule(type, criteria, value); setStatus(statusEl, 'ok', '✓ gemerkt'); }
  catch(e){ setStatus(statusEl, 'err', '✗ ' + e.message); }
}

/* ================= Seitenrahmen ================= */
function initDropzone(onFiles){
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  dropzone.addEventListener('click', ()=> fileInput.click());
  dropzone.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', (e)=>{ onFiles(e.target.files); e.target.value=''; });
  ['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e)=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e)=> onFiles(e.dataTransfer.files));
}
function isPdf(file){ return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'); }

document.addEventListener('DOMContentLoaded', ()=>{
  const v = document.getElementById('appVersion');
  if(v) v.textContent = 'Coding Pilot ' + APP_VERSION;
  const refStatus = document.getElementById('refStatus');
  document.getElementById('reloadRef')?.addEventListener('click', ()=> loadReference(refStatus));
});

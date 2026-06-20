/* ─────────────────────────────────────────────────────────────────────────────
   MYGIGPAL — app.js
   PWA logic. Onboarding, scan bridge bookmarklet, scrape memory, ICS export.
   A product of Hughessential™ Digital Studio.
   ────────────────────────────────────────────────────────────────────────── */

const APP_ORIGIN = location.origin;
const APP_URL = new URL('./index.html', location.href).href;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  events: [],          // currently displayed events
  memory: {},          // {eventId: {fp, lastExported}}
  onboardStep: 0,
  onboardTotal: 5
};

// ── Storage ──────────────────────────────────────────────────────────────────
const MEM_KEY = 'mygigpal_memory_v1';
const ONBOARDED_KEY = 'mygigpal_onboarded_v1';

function loadMemory() {
  try { return JSON.parse(localStorage.getItem(MEM_KEY) || '{}'); }
  catch { return {}; }
}
function saveMemory(m) {
  try { localStorage.setItem(MEM_KEY, JSON.stringify(m)); } catch {}
}
function isOnboarded() {
  return localStorage.getItem(ONBOARDED_KEY) === '1';
}
function markOnboarded() {
  localStorage.setItem(ONBOARDED_KEY, '1');
}
function resetMemory() {
  localStorage.removeItem(MEM_KEY);
  state.memory = {};
}

// ── Out-of-state detection ───────────────────────────────────────────────────
const OTHER_STATE_ABBRS = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy'];
const OTHER_STATE_NAMES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];

function isOOS(addr) {
  if (!addr) return false;
  const l = addr.toLowerCase();
  if (/\bmaryland\b/.test(l) || /\bmd\b/.test(l)) return false;
  if (/\bdc\b/.test(l) || /washington d\.?c\.?/i.test(l)) return false;
  for (const s of OTHER_STATE_NAMES) {
    if (new RegExp('\\b' + s.replace(/ /g,'\\s+') + '\\b').test(l)) return true;
  }
  for (const s of OTHER_STATE_ABBRS) {
    if (new RegExp('\\b' + s + '\\b').test(l)) return true;
  }
  return false;
}

// ── Time math ────────────────────────────────────────────────────────────────
function parseTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) {
    const m2 = s.match(/(\d{1,2})\s*(am|pm)/i);
    if (!m2) return null;
    let h = parseInt(m2[1]);
    const ap = m2[2].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return { h, min: 0 };
  }
  let h = parseInt(m[1]), min = parseInt(m[2]);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, min };
}

function subHours(t, hrs) {
  let tot = t.h * 60 + t.min - hrs * 60;
  if (tot < 0) tot += 1440;
  return { h: Math.floor(tot / 60) % 24, min: tot % 60 };
}

function fmt24(t) {
  if (!t) return '—';
  return String(t.h).padStart(2, '0') + ':' + String(t.min).padStart(2, '0');
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const raw = String(dateStr).trim();
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // Handles DJEP-style values like "Friday, June 19, 2026".
  const cleaned = raw.replace(/^\w+,\s*/, '');
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addMinutes(t, mins) {
  const total = (t.h * 60 + t.min + mins + 1440) % 1440;
  return { h: Math.floor(total / 60), min: total % 60 };
}

function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function computeShopCall(ev) {
  const d = ev.detail || {};
  if (d.shopCall) {
    const parsed = parseTime(d.shopCall);
    if (parsed) return { time: parsed, source: 'set on event' };
  }
  const addr = d.venueAddress || d.venueDisplay || ev.location || '';
  if (isOOS(addr)) return { time: { h: 5, min: 0 }, source: 'out of state default' };
  const setup = parseTime(d.setupTime || '');
  if (setup) return { time: subHours(setup, 2), source: 'setup minus 2h' };
  const start = parseTime(d.startTime || ev.startTime || '');
  if (start) return { time: subHours(start, 2), source: 'start minus 2h' };
  return null;
}

// ── Fingerprint & classification ─────────────────────────────────────────────
function fingerprint(ev) {
  const d = ev.detail || {};
  const shop = ev.shopCallResult ? `${ev.shopCallResult.time.h}:${ev.shopCallResult.time.min}` : '';
  return [
    ev.eventId, d.eventName, d.eventType || ev.eventType, d.eventDate || ev.date,
    d.setupTime, d.startTime || ev.startTime, d.endTime || ev.endTime, d.shopCall, shop,
    d.venueAddress || d.venueDisplay || ev.location,
    d.myRole || ev.role, d.attire, d.vehicle, d.logisticsNotes, d.confirmStatus
  ].join('||');
}

function classify(ev) {
  const stored = state.memory[ev.eventId];
  if (!stored) return 'new';
  if (stored.fp !== fingerprint(ev)) return 'changed';
  return 'unchanged';
}

// ── ICS generation ───────────────────────────────────────────────────────────
function formatICSDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function toICSdt(dateStr, t) {
  try {
    const d = parseLocalDate(dateStr);
    if (!d || !t) return null;
    d.setHours(t.h, t.min, 0, 0);
    const p = n => String(n).padStart(2, '0');
    return `${formatICSDate(d)}T${p(d.getHours())}${p(d.getMinutes())}00`;
  } catch { return null; }
}
function toICSdate(dateStr) {
  try {
    const d = parseLocalDate(dateStr);
    return d ? formatICSDate(d) : null;
  } catch { return null; }
}
function toICSnextDate(dateStr) {
  try {
    const d = parseLocalDate(dateStr);
    return d ? formatICSDate(addDays(d, 1)) : null;
  } catch { return null; }
}
function nowICS() {
  return new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'').slice(0,15) + 'Z';
}
function icsEscape(s) {
  return String(s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}
function foldLine(line) {
  const chunks = [];
  let rest = String(line);
  while (rest.length > 74) {
    chunks.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  chunks.push(rest);
  return chunks.join('\r\n');
}
function vevent({ uid, dtstart, dtend, dateOnly, summary, location, description }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}@mygigpal`, 'DTSTAMP:' + nowICS()];
  if (dtstart) {
    lines.push('DTSTART:' + dtstart);
    lines.push('DTEND:' + (dtend || dtstart));
  } else if (dateOnly) {
    lines.push('DTSTART;VALUE=DATE:' + dateOnly);
    lines.push('DTEND;VALUE=DATE:' + (toICSnextDate(dateOnly) || dateOnly));
  }
  lines.push('SUMMARY:' + icsEscape(summary));
  if (location) lines.push('LOCATION:' + icsEscape(location));
  if (description) lines.push('DESCRIPTION:' + icsEscape(description));
  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}

// ── Bookmarklet (the bridge) ─────────────────────────────────────────────────
// The bookmarklet runs IN the planner page where the user is logged in.
// It scrapes the cards, fetches each detail page using the user's session,
// and pipes the result back to this PWA via the broadcast channel + URL.

function generateBookmarklet() {
  // Inline scrape logic — kept tight to fit comfortably in a bookmarklet
  const code = `(async()=>{
const TARGET=${JSON.stringify(APP_URL)};
const EVENT_PAGE='/dj_event_planner/employee_events.asp';
let scanDoc=document;
const docText=(doc)=>((doc.body&&doc.body.innerText)||'').toLowerCase();
const tableText=(doc)=>((doc.querySelector('table')&&doc.querySelector('table').innerText)||'').toLowerCase();
const looksUpcoming=(doc)=>{const p=docText(doc),t=tableText(doc);return p.includes('your upcoming events')||p.includes('please confirm these upcoming events')||p.includes('events list')||t.includes('event date')||location.href.includes('employee_events.asp');};
if(!looksUpcoming(scanDoc)){try{const r=await fetch(EVENT_PAGE,{credentials:'include'});const html=await r.text();const fetched=new DOMParser().parseFromString(html,'text/html');if(looksUpcoming(fetched))scanDoc=fetched;}catch(e){}}
if(!looksUpcoming(scanDoc)){if(!confirm('MyGigPal needs the direct Events – Upcoming page to scan gigs.\n\nClick OK to open that page. After it loads, click the MyGigPal bookmark again.'))return;location.href=EVENT_PAGE;return;}
const cards=scanDoc.querySelectorAll('div.e_c[id^="ec_"]');
if(!cards.length){alert('No gigs found on this page. Make sure your event list is loaded.');return;}
const list=[];
cards.forEach(c=>{const id=c.id.replace('ec_','');const ev={eventId:id};c.querySelectorAll('table.available_events_card tr').forEach(r=>{const cs=r.querySelectorAll('td');if(cs.length<2)return;const l=cs[0].textContent.trim().replace(/:$/,'').toLowerCase();const v=cs[1].textContent.trim().replace(/\\s+/g,' ');if(l==='date')ev.date=v;else if(l==='event type')ev.eventType=v;else if(l==='event location')ev.location=v;else if(l==='client')ev.client=v;else if(l==='role')ev.role=v;else if(l==='start time')ev.startTime=v;else if(l==='end time')ev.endTime=v;});list.push(ev);});
const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.92);color:#00d9ff;font:14px/1.5 monospace;z-index:99999;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;';overlay.innerHTML='<div style="max-width:340px;"><div style="font-size:20px;font-weight:900;letter-spacing:0.1em;margin-bottom:14px;">MYGIGPAL · SCAN BRIDGE</div><div id="hg_p" style="color:#fff;">Scanning '+list.length+' gigs...</div></div>';document.body.appendChild(overlay);
const F=async(url)=>{try{const r=await fetch(url,{credentials:'include'});const t=await r.text();const doc=new DOMParser().parseFromString(t,'text/html');const d={};const lab=(name)=>{const els=doc.querySelectorAll('.fieldtitle strong');for(const e of els){if(e.textContent.trim().replace(/:$/,'').toLowerCase()===name.toLowerCase()){const row=e.closest('.padding-tb-3');if(row){const fd=row.querySelector('.fielddata');if(fd)return fd.innerText.trim().replace(/\\s+/g,' ');}}}return '';};
d.setupTime=lab('Setup Time');d.startTime=lab('Start Time');d.endTime=lab('End Time');d.shopCall=lab('Shop Call');d.vehicle=lab('Vehicle');d.attire=lab('Attire');d.eventName=lab('Event Name');d.eventType=lab('Event Type');d.eventDate=lab('Event Date');d.clientName=lab('Client Name');
const va=doc.querySelector('#venue .fielddata');if(va)d.venueAddress=va.innerText.trim().replace(/\\s+/g,' ');
const vt=doc.querySelector('.toolboxtitletext a[href*="venues.asp"]');if(vt)d.venueDisplay=vt.textContent.trim();
const m2=doc.getElementById('custom_event_memo_2');if(m2&&!m2.innerText.includes('No Notes'))d.logisticsNotes=m2.innerText.trim();
const cards2=doc.querySelectorAll('.wages_card');for(const card of cards2){const re=card.innerText.match(/Position:.*?Role:\\s*(.+?)(?:\\n|$)/);if(re)d.myRole=re[1].trim();}
const ce=doc.querySelector('#confirm_event');if(ce)d.confirmStatus=ce.textContent.trim();return d;}catch(e){return{fetchError:e.message};}};
for(let i=0;i<list.length;i++){document.getElementById('hg_p').textContent='Reading gig '+(i+1)+' of '+list.length+'...';list[i].detail=await F('/dj_event_planner/events_report.asp?action=report&eventid='+list[i].eventId);await new Promise(r=>setTimeout(r,120));}
document.getElementById('hg_p').textContent='Sending '+list.length+' gigs to MyGigPal...';
const payload=JSON.stringify({type:'mygigpal_scrape',ts:Date.now(),events:list});
let opened=false;const encoded=encodeURIComponent(payload);
if(encoded.length<6500){try{const w=window.open(TARGET+'/?h='+encoded,'_blank');if(w)opened=true;}catch(e){}}
if(!opened){try{await navigator.clipboard.writeText(payload);overlay.innerHTML='<div style="max-width:340px;"><div style="font-size:20px;font-weight:900;letter-spacing:0.1em;margin-bottom:14px;color:#00d9ff;">MYGIGPAL · SCAN BRIDGE</div><div style="color:#fff;margin-bottom:18px;">'+list.length+' gigs copied to clipboard.<br><br>Now open MyGigPal and tap SCAN to paste them in.</div><button onclick="this.closest(\\'div\\').parentElement.remove();window.open(\\''+TARGET+'/?paste=1\\',\\'_blank\\');" style="background:#00d9ff;color:#000;border:0;padding:14px 22px;font:700 13px monospace;letter-spacing:0.1em;cursor:pointer;">OPEN MYGIGPAL &rarr;</button></div>';return;}catch(e){overlay.innerHTML='<div style="max-width:340px;color:#fff;"><div style="font-size:20px;font-weight:900;letter-spacing:0.1em;margin-bottom:14px;color:#00d9ff;">SCAN BRIDGE ERROR</div>Could not open MyGigPal or copy to clipboard. Please allow popups for this site and try again.</div>';return;}}
setTimeout(()=>overlay.remove(),1500);
})();`;
  return 'javascript:' + encodeURIComponent(code.replace(/\s+/g, ' ').trim());
}

// ── Receive scrape from the bridge ───────────────────────────────────────────
function listenForScrape() {
  // BroadcastChannel for same-origin (won't fire across origins, but harmless)
  try {
    const bc = new BroadcastChannel('mygigpal');
    bc.onmessage = e => handleScrapePayload(e.data);
  } catch {}

  // URL param payload — works when the bookmarklet can open a new tab
  const params = new URLSearchParams(location.search);
  if (params.get('h')) {
    try { handleScrapePayload(decodeURIComponent(params.get('h'))); } catch {}
    history.replaceState(null, '', location.pathname);
    return;
  }

  // Paste fallback — when payload was copied to clipboard by the bookmarklet
  if (params.get('paste') === '1') {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => promptPaste(), 300);
  }
}

async function promptPaste() {
  // Try modern clipboard API first
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.includes('mygigpal_scrape')) {
      handleScrapePayload(text);
      return;
    }
  } catch {}

  // Fall back to manual paste prompt
  showPasteModal();
}

function showPasteModal() {
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;';
  m.innerHTML = `
    <div style="max-width:340px;text-align:center;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.18em;color:#00d9ff;margin-bottom:14px;">PASTE FROM SCAN BRIDGE</div>
      <div style="font-family:'Inter',sans-serif;font-weight:900;font-size:26px;line-height:1;letter-spacing:-0.02em;color:#f4f1ea;margin-bottom:18px;">Paste your gigs here.</div>
      <div style="color:#b8b6ae;font-size:15px;margin-bottom:18px;">The Scan Gigs bridge copied them to your clipboard. Tap the box and paste.</div>
      <textarea id="paste-area" placeholder="Long-press here and tap PASTE…" style="width:100%;height:84px;background:#0a0a0a;color:#00d9ff;border:1px solid #333333;padding:12px;font-family:monospace;font-size:12px;resize:none;"></textarea>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button id="paste-cancel" style="flex:1;background:transparent;border:1px solid #333333;color:#8d8b84;padding:15px;font-family:'Inter',sans-serif;font-weight:700;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;">CANCEL</button>
        <button id="paste-ok" style="flex:1;background:#00d9ff;border:0;color:#000;padding:15px;font-family:'Inter',sans-serif;font-weight:900;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;">LOAD</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  document.getElementById('paste-cancel').onclick = () => m.remove();
  document.getElementById('paste-ok').onclick = () => {
    const text = document.getElementById('paste-area').value.trim();
    if (text) handleScrapePayload(text);
    m.remove();
  };
  setTimeout(() => document.getElementById('paste-area').focus(), 100);
}

function handleScrapePayload(rawData) {
  let payload;
  try { payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData; }
  catch { return; }
  if (!payload || payload.type !== 'mygigpal_scrape' || !Array.isArray(payload.events)) return;

  // Move to board view if onboarding
  markOnboarded();
  showView('board');

  // Process and classify
  state.memory = loadMemory();
  const enriched = payload.events.map(ev => {
    const shopCallResult = computeShopCall(ev);
    const oos = isOOS(ev.detail?.venueAddress || ev.detail?.venueDisplay || ev.location || '');
    const event = { ...ev, oos, shopCallResult };
    event.exportState = classify(event);
    return event;
  });

  state.events = enriched;
  renderBoard();
  toast(`Received ${enriched.length} gig${enriched.length !== 1 ? 's' : ''} from the planner.`, 'ok');
  setReadout('LIVE');
}

// ── Render board ─────────────────────────────────────────────────────────────
function renderBoard() {
  const rows = document.getElementById('rows');
  const empty = document.getElementById('board-empty');
  const sum = document.getElementById('board-summary');
  const sub = document.getElementById('board-sub');
  const cnt = document.getElementById('board-count');

  rows.innerHTML = '';

  if (!state.events.length) {
    empty.style.display = '';
    sum.hidden = true;
    cnt.textContent = '—  EVENTS';
    sub.textContent = 'Click Scan Gigs from the planner to pull your gigs.';
    updateExportBtn();
    return;
  }

  empty.style.display = 'none';

  // Count categories
  let cn = 0, cc = 0, cd = 0;
  state.events.forEach(ev => {
    if (ev.exportState === 'new') cn++;
    else if (ev.exportState === 'changed') cc++;
    else cd++;
  });

  cnt.textContent = String(state.events.length).padStart(2, '0') + ' EVENTS';
  sub.textContent = (cn || cc)
    ? `${cn + cc} new or updated — pre-selected.`
    : 'Everything already on your calendar.';

  sum.hidden = false;
  document.getElementById('sum-new').textContent = cn;
  document.getElementById('sum-changed').textContent = cc;
  document.getElementById('sum-done').textContent = cd;

  state.events.forEach((ev, i) => {
    const d = ev.detail || {};
    const name = d.eventName || ev.client || ev.eventType || 'Gig';
    const startStr = d.startTime || ev.startTime || '';
    const startT = parseTime(startStr);
    const timeDisplay = startT ? fmt24(startT) : '— : —';
    const dateStr = d.eventDate || ev.date || '';
    const dateShort = dateStr.replace(/^\w+,\s*/, '');
    const loc = (ev.location || d.venueDisplay || '').split(' - ')[0];
    const shopT = ev.shopCallResult?.time;
    const shopStr = shopT ? fmt24(shopT) : null;
    const preSelected = ev.exportState !== 'unchanged';

    let badgeClass, badgeText;
    if (ev.exportState === 'new') { badgeClass = 'b-new'; badgeText = 'NEW'; }
    else if (ev.exportState === 'changed') { badgeClass = 'b-changed'; badgeText = 'UPDATED'; }
    else { badgeClass = 'b-done'; badgeText = '✓ SENT'; }

    const oosClass = ev.oos ? ' is-oos' : '';
    const checkedClass = preSelected ? ' is-checked' : '';

    const li = document.createElement('li');
    li.className = 'row' + oosClass + checkedClass;
    li.innerHTML = `
      <input type="checkbox" class="row-checkbox" data-idx="${i}" ${preSelected ? 'checked' : ''}>
      <div class="row-body">
        <div class="row-time">${escapeHtml(timeDisplay)} · ${escapeHtml(dateShort)}</div>
        <div class="row-name">${escapeHtml(name)}</div>
        <div class="row-meta">${escapeHtml(loc || '—')}</div>
        ${shopStr ? `<div class="row-shop"><span class="row-shop-label">SHOP&nbsp;CALL</span> ${shopStr}</div>` : ''}
      </div>
      <div>
        <div class="row-badge ${badgeClass}">${badgeText}</div>
        ${ev.oos ? '<div class="row-badge b-oos-flag">OOS</div>' : ''}
      </div>`;

    rows.appendChild(li);
  });

  // Wire checkbox interactions
  rows.querySelectorAll('.row-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      e.target.closest('.row').classList.toggle('is-checked', e.target.checked);
      updateExportBtn();
    });
  });
  // Row click toggles checkbox
  rows.querySelectorAll('.row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      const cb = row.querySelector('.row-checkbox');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });

  updateExportBtn();
}

function updateExportBtn() {
  const btn = document.getElementById('btn-export');
  const cnt = document.querySelectorAll('.row-checkbox:checked').length;
  document.getElementById('exp-count').textContent = cnt;
  btn.disabled = cnt === 0;
}

function escapeHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Export ICS ───────────────────────────────────────────────────────────────
function exportSelected() {
  const indices = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => parseInt(cb.dataset.idx));
  if (!indices.length) return;

  const vevents = [];
  const now = new Date().toISOString();

  for (const idx of indices) {
    const ev = state.events[idx];
    if (!ev) continue;
    const d = ev.detail || {};
    const dateStr = d.eventDate || ev.date || '';
    const name = d.eventName || ev.client || ev.eventType || 'Gig';
    const addr = d.venueAddress || d.venueDisplay || ev.location || '';
    const oos = ev.oos;
    const sc = ev.shopCallResult;
    const startT = parseTime(d.startTime || ev.startTime || '');
    const endT = parseTime(d.endTime || ev.endTime || '');
    const setupT = parseTime(d.setupTime || '');
    const uid = 'gig_' + ev.eventId;

    const desc = [
      oos ? '⚠️ OUT OF STATE' : '',
      d.myRole || ev.role ? 'Role: ' + (d.myRole || ev.role) : '',
      d.setupTime ? 'Setup: ' + d.setupTime : '',
      d.startTime || ev.startTime ? 'Start: ' + (d.startTime || ev.startTime) : '',
      d.endTime || ev.endTime ? 'End: ' + (d.endTime || ev.endTime) : '',
      sc ? `Shop Call: ${fmt24(sc.time)} (${sc.source})` : '',
      d.attire ? 'Attire: ' + d.attire : '',
      d.vehicle ? 'Vehicle: ' + d.vehicle : '',
      d.logisticsNotes ? '\n' + d.logisticsNotes : ''
    ].filter(Boolean).join('\n');

    vevents.push(vevent({
      uid: uid + '_main',
      dtstart: startT ? toICSdt(dateStr, startT) : null,
      dtend: endT ? toICSdt(dateStr, endT) : (startT ? toICSdt(dateStr, addMinutes(startT, 240)) : null),
      dateOnly: !startT ? toICSdate(dateStr) : null,
      summary: (oos ? '✈ ' : '◆ ') + name,
      location: addr,
      description: desc
    }));

    if (setupT) {
      vevents.push(vevent({
        uid: uid + '_setup',
        dtstart: toICSdt(dateStr, setupT),
        dtend: toICSdt(dateStr, addMinutes(setupT, 60)),
        summary: '◇ Setup – ' + name,
        location: addr,
        description: 'Venue load-in for: ' + name
      }));
    }

    if (sc) {
      vevents.push(vevent({
        uid: uid + '_shop',
        dtstart: toICSdt(dateStr, sc.time),
        dtend: toICSdt(dateStr, addMinutes(sc.time, 60)),
        summary: '▣ Shop Call – ' + name,
        location: 'Extraordinary Entertainment · 7805 Cessna Ave, Gaithersburg MD',
        description: [
          'Report to warehouse for: ' + name,
          addr ? 'Gig: ' + addr : '',
          oos ? 'Out of state · 5:00 AM default' : 'Shop call = 2h before setup',
          d.vehicle ? 'Vehicle: ' + d.vehicle : ''
        ].filter(Boolean).join('\n')
      }));
    }

    // Update memory
    state.memory[ev.eventId] = { fp: fingerprint(ev), lastExported: now };
    ev.exportState = 'unchanged';
  }

  saveMemory(state.memory);

  const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//MyGigPal//Hughessential Digital Studio//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH', ...vevents, 'END:VCALENDAR'].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const file = 'gigs_' + new Date().toISOString().slice(0,10) + '.ics';

  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  renderBoard();
  toast(`Exported ${indices.length} gig${indices.length !== 1 ? 's' : ''} → ${file}`, 'ok');
}

// ── Views & navigation ───────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.removeAttribute('data-active'));
  document.getElementById('view-' + name).setAttribute('data-active', '');
  document.getElementById('readout-section').textContent = name === 'onboard' ? 'SETUP' : 'GIG LOGISTICS, AUTOMATED';
}

function setReadout(text) {
  const el = document.getElementById('readout-state');
  el.textContent = text;
  el.className = 'readout-state';
  if (text === 'BUSY') el.classList.add('busy');
  if (text === 'IDLE') el.classList.add('idle');
}

// ── Onboarding ───────────────────────────────────────────────────────────────
function setOnboardStep(n) {
  state.onboardStep = Math.max(0, Math.min(state.onboardTotal - 1, n));
  document.querySelectorAll('.onboard-step').forEach((s, i) => {
    const isActive = i === state.onboardStep;
    if (isActive) {
      // Re-trigger the reveal animation: clear active, force reflow, re-add.
      s.classList.remove('active');
      void s.offsetWidth; // reflow
      s.classList.add('active');
    } else {
      s.classList.remove('active');
    }
  });
  document.querySelectorAll('.onboard-dots .dot').forEach((d, i) => {
    d.classList.toggle('active', i === state.onboardStep);
  });
  document.getElementById('btn-back').classList.toggle('is-hidden', state.onboardStep === 0);
  // NEXT button has a nested .anim-label span — update that, not the whole button.
  const nextLabel = document.querySelector('#btn-next .anim-label');
  if (nextLabel) nextLabel.textContent = state.onboardStep === state.onboardTotal - 1 ? 'GO' : 'NEXT';
}

function finishOnboard() {
  markOnboarded();
  showView('board');
}

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  t.className = 'toast is-' + type;
  document.getElementById('toast-msg').textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  state.memory = loadMemory();

  // Wire bookmarklet
  document.getElementById('bookmarklet').href = generateBookmarklet();

  // Onboarding navigation
  document.getElementById('btn-next').addEventListener('click', () => {
    if (state.onboardStep === state.onboardTotal - 1) finishOnboard();
    else setOnboardStep(state.onboardStep + 1);
  });
  document.getElementById('btn-back').addEventListener('click', () => setOnboardStep(state.onboardStep - 1));
  setOnboardStep(0);

  // Board buttons
  document.getElementById('btn-scan').addEventListener('click', () => {
    promptPaste();
  });
  document.getElementById('btn-export').addEventListener('click', exportSelected);
  document.getElementById('btn-tutorial').addEventListener('click', () => {
    setOnboardStep(0);
    showView('onboard');
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Reset export memory? Next scan will treat all gigs as new.')) {
      resetMemory();
      state.events.forEach(ev => ev.exportState = 'new');
      renderBoard();
      toast('Memory reset.', 'ok');
    }
  });

  // Listen for scrape payloads
  listenForScrape();

  // Decide starting view
  if (isOnboarded() && !new URLSearchParams(location.search).get('tutorial')) {
    showView('board');
  } else {
    showView('onboard');
  }

  setReadout('IDLE');

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);


/* ════════════════════════════════════════════════════════════════════════
   MyGigPal — Intro dismiss + Install button
   Added during integration. Self-contained; leaks no globals; touches
   none of the existing logic (bridge, scrape, export, onboarding).
   The intro mode is decided pre-paint by the gate script in <head>.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var DEMO = (window.MGP_DEMO === true);
  var KEY = 'mygigpal_intro_seen_v1';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var docEl = document.documentElement;
    var isQuick = docEl.classList.contains('mgp-intro-quick');

    /* ---- INTRO ---- */
    var intro = document.getElementById('mgpIntro');
    function dismissIntro() {
      if (!intro || intro.classList.contains('mgp-intro--done')) return;
      intro.classList.add('mgp-intro--done');
      // Record this version as seen only after the FULL intro plays, so the
      // next load drops to the quick fade. Bumping MGP_VERSION re-triggers full.
      if (!DEMO && !isQuick) { try { localStorage.setItem(KEY, window.MGP_VERSION || 'v5'); } catch (e) {} }
    }
    if (docEl.classList.contains('mgp-intro-pending') && intro) {
      intro.addEventListener('animationend', function (e) {
        if (e.animationName === 'mgpIntroOut') dismissIntro();
      });
      // Failsafe: never let the overlay trap the user, whatever goes wrong.
      setTimeout(dismissIntro, isQuick ? 1500 : 5000);
    }

    /* ---- INSTALL BUTTON ---- */
    var btn = document.getElementById('mgpInstallBtn');
    var installed = document.getElementById('mgpInstalledState');
    var subEl = document.getElementById('mgpInstallSub');
    var modal = document.getElementById('mgpModal');
    var steps = document.getElementById('mgpModalSteps');
    var closeBtn = document.getElementById('mgpModalClose');
    var deferredPrompt = null;

    function isStandalone() {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
             window.navigator.standalone === true;
    }
    function showInstalledState() {
      if (btn) btn.hidden = true;
      if (subEl) subEl.hidden = true;
      if (installed) installed.hidden = false;
    }

    // Capture the native prompt where the browser offers it (Chrome/Edge/Android).
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });
    // Confirm + clean up after a successful install.
    window.addEventListener('appinstalled', function () { deferredPrompt = null; showInstalledState(); });

    // Platform-aware instructions when no native prompt is available.
    function platformSteps() {
      var ua = navigator.userAgent || '';
      var isiOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isiOS) return ['In Safari, tap the <b>Share</b> button.', 'Tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.'];
      if (/Android/.test(ua)) return ['Open this page in <b>Chrome</b>.', 'Tap the <b>\u22EE</b> menu.', 'Tap <b>Add to Home screen</b>.'];
      return ['Open this page in <b>Chrome</b> or <b>Edge</b>.', 'Open the browser menu.', 'Choose <b>Install MyGigPal</b>.'];
    }
    function openModal() {
      if (!modal || !steps) return;
      steps.innerHTML = '';
      platformSteps().forEach(function (txt, i) {
        var li = document.createElement('li');
        li.innerHTML = '<span class="mgp-modal__num">' + (i + 1) + '</span><span>' + txt + '</span>';
        steps.appendChild(li);
      });
      modal.hidden = false;
      if (closeBtn) closeBtn.focus();
    }
    function closeModal() { if (modal) modal.hidden = true; if (btn) btn.focus(); }

    if (btn) {
      btn.addEventListener('click', function () {
        if (deferredPrompt) {
          btn.classList.add('is-working');
          btn.textContent = 'Opening install prompt\u2026';
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () {
            deferredPrompt = null;
            btn.classList.remove('is-working');
            btn.innerHTML = 'Install MyGigPal <span class="mgp-arrow" aria-hidden="true">\u2193</span>';
          });
        } else {
          openModal();  // no dead button — always help the user
        }
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    // Already installed? Don't keep pestering.
    if (isStandalone()) showInstalledState();
  });
})();

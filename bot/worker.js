/*
 * Yirmi — WhatsApp & Instagram rezervasyon asistanı (Cloudflare Worker)
 *
 * Müşteri WhatsApp'tan veya Instagram DM'den yazınca adım adım rezervasyon bilgilerini sorar,
 * talebi kaydeder ve personelin WhatsApp numaralarına bildirir. Yönetim paneli (admin.html)
 * talepleri buradan çekip boş bir masaya "Beklemede" olarak yerleştirir; personel onaylayınca
 * ya da iptal edince müşteriye otomatik mesaj gider.
 *
 * Bu dosyada gizli bilgi yoktur; anahtarlar Cloudflare'de "Variables and Secrets" olarak girilir.
 * Kurulum adımları: bot/KURULUM.md
 *
 * Ortam değişkenleri
 *   DB                D1 veritabanı bağlantısı (binding adı: DB)
 *   SITE_URL          https://yirmirestoran.github.io  (menu.json buradan okunur)
 *   ALLOWED_ORIGIN    Yönetim panelinin adresi (CORS), ör. https://yirmirestoran.github.io
 *   VERIFY_TOKEN      Meta webhook doğrulama kelimesi (kendiniz uydurun)
 *   META_APP_SECRET   Meta uygulamasının "App secret" değeri (webhook imzası)
 *   IG_APP_SECRET     Instagram ürününün "Instagram app secret" değeri (varsa)
 *   WA_TOKEN          WhatsApp Cloud API kalıcı erişim anahtarı (System User token)
 *   WA_PHONE_ID       WhatsApp "Phone number ID"
 *   IG_TOKEN          Instagram erişim anahtarı (60 günlük; bot her hafta kendisi yeniler)
 *   STAFF_NUMBERS     Bildirim alacak personel numaraları, virgülle: 905321112233,905441112233
 *   ADMIN_KEY         Yönetim panelinin bota bağlanırken kullandığı uzun, rastgele anahtar
 *   STAFF_TEMPLATE    (isteğe bağlı) 24 saat penceresi dışında personele gidecek şablonun adı
 *   CONFIRM_TEMPLATE  (isteğe bağlı) 24 saat dışında müşteriye gidecek onay şablonunun adı
 *   MAX_GUESTS        (isteğe bağlı) bottan alınabilecek en kalabalık grup, varsayılan 30
 *   GRAPH_VERSION     (isteğe bağlı) Meta Graph API sürümü, varsayılan v23.0
 */

const SESSION_MS = 30 * 60e3;          // bu kadar sessiz kalan sohbet baştan başlar
const HUMAN_MS = 12 * 3600e3;          // "yetkili" istenince bot bu süre susar
const WINDOW_MS = 23.5 * 3600e3;       // WhatsApp/Instagram 24 saat mesajlaşma penceresi (pay bırakılarak)
const LEAD_MIN = 30;                   // bugün için en erken saat: şimdiden 30 dk sonrası
const MAX_DAYS = 60;                   // en fazla kaç gün sonrası için talep alınır
const SLOT = 30;
const TR_OFFSET = 180;                 // Türkiye UTC+3 (yaz saati uygulanmıyor)

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const MONTHS_N = ['ocak', 'subat', 'mart', 'nisan', 'mayis', 'haziran', 'temmuz', 'agustos', 'eylul', 'ekim', 'kasim', 'aralik'];
const DAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const DAYS_S = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const DAYS_N = ['pazar', 'pazartesi', 'sali', 'carsamba', 'persembe', 'cuma', 'cumartesi'];
const AREA = {ic: 'İç alan', dis: 'Dış alan', any: 'Fark etmez'};
const OCCASIONS = [
  ['dogum', '🎂', 'Doğum günü', /dogum/],
  ['yildonumu', '💍', 'Yıldönümü', /yil ?donum/],
  ['teklif', '💐', 'Evlilik teklifi', /teklif|evlenme/],
  ['is', '💼', 'İş yemeği', /\bis\b|toplanti/],
  ['kutlama', '🎓', 'Mezuniyet / kutlama', /mezun|kutlama|terfi/],
  ['diger', '✨', 'Diğer', /^diger$/]
];
const MAIN_OPTIONS = [
  {id: 'm:rez', title: '📅 Rezervasyon', desc: 'Masa ayırtın'},
  {id: 'm:ozel', title: '🎉 Özel gün', desc: 'Doğum günü, yıldönümü, kutlama…'},
  {id: 'm:bilgi', title: '📖 Menü & bilgi', desc: 'Menü, çalışma saatleri, adres'},
  {id: 'm:yetkili', title: '💬 Yetkiliyle görüş', desc: 'Ekibimize bağlanın'}
];

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    try{
      if(url.pathname === '/webhook') return await webhook(req, url, env, ctx);
      if(url.pathname.startsWith('/api/')){
        if(req.method === 'OPTIONS') return cors(env, new Response(null, {status: 204}));
        return cors(env, await api(req, url, env));
      }
      return new Response('Yirmi rezervasyon asistanı çalışıyor.', {headers: {'content-type': 'text/plain; charset=utf-8'}});
    }catch(e){
      console.error(e && e.stack || e);
      return cors(env, json({error: 'Sunucu hatası: ' + (e && e.message || e)}, 500));
    }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(daily(env).catch(e => console.error('daily', e && e.stack || e)));
  }
};

/* ---------- Veritabanı (Cloudflare D1) ---------- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS sessions (k TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS contacts (k TEXT PRIMARY KEY, last_in INTEGER NOT NULL, name TEXT)',
  'CREATE TABLE IF NOT EXISTS requests (ref TEXT PRIMARY KEY, channel TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, imported INTEGER NOT NULL DEFAULT 0, notified TEXT)',
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, t INTEGER NOT NULL)'
];
let schemaReady = null;
async function db(env){
  if(!env.DB) throw new Error('D1 veritabanı bağlanmamış (binding adı DB olmalı)');
  if(!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(q => env.DB.prepare(q))).catch(e => { schemaReady = null; throw e; });
  await schemaReady;
  return env.DB;
}
async function getSetting(env, k){
  const r = await (await db(env)).prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
  return r ? JSON.parse(r.v) : null;
}
async function setSetting(env, k, v){
  await (await db(env)).prepare('INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind(k, JSON.stringify(v)).run();
}
// Meta aynı mesajı birden fazla kez gönderebilir; her mesaj bir kez işlenir
async function firstSeen(env, id){
  const r = await (await db(env)).prepare('INSERT OR IGNORE INTO seen (id, t) VALUES (?, ?)').bind(id, Date.now()).run();
  return r.meta.changes > 0;
}
async function daily(env){
  const D = await db(env), now = Date.now(), day = 864e5;
  await D.batch([
    D.prepare('DELETE FROM sessions WHERE updated < ?').bind(now - 2 * day),
    D.prepare('DELETE FROM seen WHERE t < ?').bind(now - 3 * day),
    D.prepare('DELETE FROM requests WHERE created < ?').bind(now - 120 * day),
    D.prepare('DELETE FROM contacts WHERE last_in < ?').bind(now - 120 * day)
  ]);
  await refreshIgToken(env).catch(e => console.error('ig token', e && e.message || e));
}

/* ---------- Dış alan durumu ---------- */
// {closedUntil: null | 'YYYY-MM-DD' | 'always', note}
async function outdoorState(env){ return (await getSetting(env, 'outdoor')) || {closedUntil: null, note: ''}; }
function outdoorClosedOn(o, date){ return !!(o && o.closedUntil) && (o.closedUntil === 'always' || date <= o.closedUntil); }

/* ---------- İşletme bilgileri (menu.json) ---------- */
let siteCache = null, siteAt = 0;
async function siteInfo(env){
  if(siteCache && Date.now() - siteAt < 300e3) return siteCache;
  try{
    const r = await fetch(siteUrl(env) + '/menu.json', {cf: {cacheTtl: 300}});
    if(r.ok){ siteCache = (await r.json()).site || {}; siteAt = Date.now(); }
  }catch(e){ console.error('menu.json', e && e.message); }
  return siteCache || {};
}
const siteUrl = env => String(env.SITE_URL || 'https://yirmirestoran.github.io').replace(/\/+$/, '');

/* ---------- Tarih / saat ---------- */
const pad = n => String(n).padStart(2, '0');
function trNow(){
  const d = new Date(Date.now() + TR_OFFSET * 60e3);
  return {date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), year: d.getUTCFullYear()};
}
function addDays(date, n){ return new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
const dObj = date => new Date(date + 'T00:00:00Z');
function dateLong(date){ const d = dObj(date); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + DAYS[d.getUTCDay()]; }
function dateShort(date){ const d = dObj(date); return DAYS_S[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3); }
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(dObj(s));
function parseHM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m && +m[1] < 25 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}
const hm = m => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
// Servis saatleri dakika olarak; gece yarısını geçen kapanış ertesi güne taşar (00:00 → 1440)
function serviceHours(site){
  const o = parseHM(site.opening), c = parseHM(site.closing);
  const open = o != null ? o : 12 * 60;
  let close = c != null ? c : 24 * 60;
  if(close <= open) close += 1440;
  return {open, close};
}
// Rezervasyon alınabilecek saatler (son giriş kapanıştan 1 saat önce)
function slotsFor(date, site){
  const h = serviceHours(site), now = trNow(), out = [];
  for(let m = h.open; m <= h.close - 60; m += SLOT) if(date !== now.date || m >= now.min + LEAD_MIN) out.push(m);
  return out;
}
function parseDate(t){
  const now = trNow();
  if(/\bbugun\b/.test(t)) return now.date;
  if(/\byarin\b/.test(t)) return addDays(now.date, 1);
  if(/\b(obur|ertesi) ?gun\b/.test(t)) return addDays(now.date, 2);
  let m = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/.exec(t), day, mon, yr = null;
  if(m){ day = +m[1]; mon = +m[2]; yr = m[3] ? +m[3] : null; }
  else if((m = new RegExp('\\b(\\d{1,2}) ?(' + MONTHS_N.join('|') + ')').exec(t))){
    day = +m[1]; mon = MONTHS_N.indexOf(m[2]) + 1;
    const y = /\b(20\d{2})\b/.exec(t); yr = y ? +y[1] : null;
  }else{
    const wd = DAYS_N.findIndex(n => new RegExp('\\b' + n + '\\b').test(t));
    if(wd < 0) return null;
    let diff = (wd - dObj(now.date).getUTCDay() + 7) % 7;
    if(/\b(haftaya|gelecek|sonraki|onumuzdeki)\b/.test(t) && diff < 7) diff += 7;
    return addDays(now.date, diff);
  }
  if(yr != null && yr < 100) yr += 2000;
  const make = y => {
    const s = y + '-' + pad(mon) + '-' + pad(day), d = dObj(s);
    return !isNaN(d) && d.getUTCDate() === day && d.getUTCMonth() + 1 === mon ? s : null;
  };
  if(yr != null) return make(yr);
  const s = make(now.year);
  return s && s >= now.date ? s : make(now.year + 1);
}
// "20:30", "20.30", "2030", "8" (→ 20:00), "8 buçuk" → servis saatleri içindeki dakika
function parseTime(t, site){
  if(!/[:.]/.test(t)) t = t.replace(/\b(\d{1,2})(\d{2})\b/, '$1:$2');
  const m = /\b(\d{1,2})(?: ?[:.] ?(\d{2}))?\b/.exec(t);
  if(!m) return null;
  const h = +m[1], mi = m[2] != null ? +m[2] : (/bucuk/.test(t) ? 30 : 0);
  if(h > 24 || mi > 59) return null;
  const sh = serviceHours(site);
  const c = [h, h + 12, h + 24, h + 36].map(x => x * 60 + mi).find(x => x >= sh.open && x <= sh.close - 60);
  return c != null ? c : h * 60 + mi;
}
const NUM_WORDS = {tek: 1, bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10};
function parseCount(t){
  const m = /\d+/.exec(t);
  if(m) return +m[0];
  const w = t.split(' ').find(x => NUM_WORDS[x]);
  return w ? NUM_WORDS[w] : null;
}
function fmtPhone(d){ return '0' + d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6, 8) + ' ' + d.slice(8); }
function parsePhone(text){
  const raw = String(text || '').trim();
  let d = raw.replace(/\D/g, '');
  if(d.startsWith('0090')) d = d.slice(2);
  if(d.length === 12 && d.startsWith('90')) d = d.slice(2);
  if(d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if(d.length === 10) return fmtPhone(d);
  if(raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}
function localPhone(waId){ return /^90\d{10}$/.test(waId) ? fmtPhone(waId.slice(2)) : '+' + waId; }

/* ---------- Metin yardımcıları ---------- */
// Karşılaştırma için: küçük harf, Türkçe karakterler sadeleşir, emoji/noktalama atılır
function norm(s){
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase()
    .replace(/[çğıöşü]/g, c => ({ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u'})[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9:./\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const oneLine = s => String(s || '').replace(/[\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, 900);
const firstName = n => clean(n, 40).split(' ')[0] || '';
const json = (obj, status) => new Response(JSON.stringify(obj), {status: status || 200, headers: {'content-type': 'application/json; charset=utf-8'}});
const enc = s => new TextEncoder().encode(s);
function safeEqual(a, b){
  const x = enc(a), y = enc(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}
function staffNumbers(env){ return String(env.STAFF_NUMBERS || '').split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(Boolean); }
const channelName = ch => ch === 'wa' || ch === 'whatsapp' ? 'WhatsApp' : 'Instagram';

/* ---------- Webhook ---------- */
async function webhook(req, url, env, ctx){
  if(req.method === 'GET'){
    const p = url.searchParams;
    const ok = p.get('hub.mode') === 'subscribe' && env.VERIFY_TOKEN && p.get('hub.verify_token') === env.VERIFY_TOKEN;
    return ok ? new Response(p.get('hub.challenge') || '') : new Response('Forbidden', {status: 403});
  }
  if(req.method !== 'POST') return new Response('Method not allowed', {status: 405});
  const raw = new Uint8Array(await req.arrayBuffer());
  if(!await validSignature(req.headers.get('x-hub-signature-256'), raw, env)) return new Response('Bad signature', {status: 401});
  let body;
  try{ body = JSON.parse(new TextDecoder().decode(raw)); }catch(e){ return new Response('Bad JSON', {status: 400}); }
  // Meta'ya hemen 200 dönülür; mesaj arka planda işlenir
  ctx.waitUntil(handleUpdate(body, env).catch(e => console.error('webhook', e && e.stack || e)));
  return new Response('EVENT_RECEIVED');
}
async function hmacHex(secret, bytes){
  const key = await crypto.subtle.importKey('raw', enc(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function validSignature(header, raw, env){
  if(!header || !header.startsWith('sha256=')) return false;
  for(const secret of [env.META_APP_SECRET, env.IG_APP_SECRET].filter(Boolean)){
    if(safeEqual(header.slice(7), await hmacHex(secret, raw))) return true;
  }
  return false;
}

async function handleUpdate(body, env){
  if(body.object === 'whatsapp_business_account'){
    for(const entry of body.entry || []) for(const ch of entry.changes || []){
      const v = ch.value || {};
      // Telefondaki WhatsApp Business uygulamasından personel yazdıysa bot o müşteriye karışmaz
      for(const e of v.message_echoes || []) if(e.to) await takeOver(env, 'wa:' + e.to);
      const names = {};
      (v.contacts || []).forEach(c => { names[c.wa_id] = (c.profile && c.profile.name) || ''; });
      for(const m of v.messages || []){
        if(['reaction', 'system', 'unsupported', 'ephemeral'].includes(m.type)) continue;
        if(!await firstSeen(env, 'wa:' + m.id)) continue;
        const inp = {channel: 'wa', uid: m.from, name: names[m.from] || '', text: '', choice: null, media: false};
        if(m.type === 'text') inp.text = (m.text && m.text.body) || '';
        else if(m.type === 'interactive'){
          const r = (m.interactive && (m.interactive.button_reply || m.interactive.list_reply)) || {};
          inp.choice = r.id || null; inp.text = r.title || '';
        }else if(m.type === 'button') inp.text = (m.button && m.button.text) || '';
        else inp.media = true;
        await onMessage(env, inp);
      }
    }
  }else if(body.object === 'instagram'){
    for(const entry of body.entry || []) for(const ev of entry.messaging || []){
      const msg = ev.message, pb = ev.postback;
      if((!msg && !pb) || !ev.sender || ev.sender.id === entry.id) continue;
      if(msg && (msg.is_echo || msg.is_deleted || (msg.attachments || []).some(a => a.type === 'story_mention'))) continue;
      const mid = (msg && msg.mid) || (pb && pb.mid) || ev.sender.id + ':' + ev.timestamp;
      if(!await firstSeen(env, 'ig:' + mid)) continue;
      const inp = {channel: 'ig', uid: ev.sender.id, name: '', text: '', choice: null, media: false};
      if(pb){ inp.text = pb.title || ''; inp.choice = pb.payload || null; }
      else{ inp.text = msg.text || ''; inp.choice = (msg.quick_reply && msg.quick_reply.payload) || null; inp.media = !msg.text && !!msg.attachments; }
      if(!inp.text && !inp.choice && !inp.media) continue;
      await onMessage(env, inp);
    }
  }
}
async function takeOver(env, key){
  await (await db(env)).prepare('INSERT INTO sessions (k, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET data = ?2, updated = ?3')
    .bind(key, JSON.stringify({step: 'human', human: Date.now() + HUMAN_MS}), Date.now()).run();
}

/* ---------- Sohbet ---------- */
async function onMessage(env, m){
  const D = await db(env);
  const key = m.channel + ':' + m.uid, now = Date.now();
  await D.prepare("INSERT INTO contacts (k, last_in, name) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET last_in = ?2, name = CASE WHEN ?3 <> '' THEN ?3 ELSE contacts.name END")
    .bind(key, now, m.name || '').run();
  const row = await D.prepare('SELECT data, updated FROM sessions WHERE k = ?').bind(key).first();
  let s = row ? JSON.parse(row.data) : null;
  if(s && !s.human && now - row.updated > SESSION_MS) s = null;     // yarım kalmış eski sohbet
  const ctx = {env, m, t: norm(m.text), out: [], notes: [], after: []};

  const staff = m.channel === 'wa' && staffNumbers(env).includes(m.uid);
  if(staff && !(s && s.test)) s = await staffCommand(ctx);
  else{
    if(s && s.human){
      if(s.human > now && !/^(menu|bot|asistan|personel)$/.test(ctx.t)) return;   // yetkili ilgileniyor, bot susar
      s = {test: s.test};
    }
    s = await converse(ctx, s);
  }

  if(s) await D.prepare('INSERT INTO sessions (k, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET data = ?2, updated = ?3').bind(key, JSON.stringify(s), now).run();
  else await D.prepare('DELETE FROM sessions WHERE k = ?').bind(key).run();

  for(const msg of ctx.out){
    try{ await send(env, m.channel, m.uid, msg); }
    catch(e){ console.error('gönderilemedi', m.channel, e.message); break; }
  }
  for(const fn of ctx.after){ try{ await fn(); }catch(e){ console.error('sonraki iş', e.message); } }
}
function say(ctx, text, options, button){
  ctx.out.push({text: ctx.notes.concat(text).join('\n\n'), options, button});
  ctx.notes = [];
}

async function converse(ctx, s){
  const t = ctx.t;
  if(!s || !s.step) return greet(ctx, s || {});
  if(s.test && t === 'personel'){ say(ctx, '🧪 Test modu kapandı. Personel komutları için *yardım* yazın.'); return null; }
  if(/^(menu|ana menu|basa don|bastan basla|baslangic)$/.test(t)) return greet(ctx, s);
  if(/\b(yetkili|temsilci|canli destek|insanla|gercek kisi|biriyle gorus)/.test(t)) return handoff(ctx, s);
  if(/^(iptal|vazgec|vazgectim|cikis)$/.test(t) && s.step !== 'menu' && s.step !== 'done'){
    say(ctx, 'Tamam, talebi iptal ettim. Yeniden başlamak için *menü* yazmanız yeterli.');
    return {step: 'done', test: s.test};
  }
  if(ctx.m.media && s.step !== 'done' && s.step !== 'menu'){
    ctx.notes.push('Şimdilik yalnızca yazılı mesajları anlayabiliyorum 🙏');
    return ask(ctx, s);
  }
  const h = ANSWERS[s.step];
  return h ? h(ctx, s) : greet(ctx, s);
}

async function greet(ctx, base){
  const site = await siteInfo(ctx.env), first = firstName(ctx.m.name);
  say(ctx, 'Merhaba' + (first ? ' ' + first : '') + '! 👋\n*' + (site.name || 'Yirmi') + ' Restoran*\'a hoş geldiniz.\nSize nasıl yardımcı olabiliriz?', MAIN_OPTIONS, 'Seçenekler');
  return {step: 'menu', d: {}, test: base && base.test};
}
async function infoText(env){
  const site = await siteInfo(env), lines = ['📖 *Menümüz:* ' + siteUrl(env)];
  if(site.opening && site.closing) lines.push('🕕 *Çalışma saatleri:* ' + site.opening + ' – ' + site.closing);
  if(site.address) lines.push('📍 *Adres:* ' + site.address, '🗺 Yol tarifi: https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(site.address));
  if(site.phone) lines.push('📞 ' + site.phone);
  return lines.join('\n');
}
async function contactLabel(ctx){
  if(ctx.m.channel === 'wa') return (ctx.m.name ? ctx.m.name + ' · ' : '') + localPhone(ctx.m.uid);
  return (await igUsername(ctx.env, ctx.m.uid)) || 'Instagram kullanıcısı';
}
async function handoff(ctx, s, reason){
  say(ctx, (reason ? reason + '\n\n' : '') + '🙋 Sizi ekibimize aktardım; en kısa sürede buradan dönüş yapacağız.\n(Otomatik asistana dönmek için *menü* yazabilirsiniz.)');
  const who = await contactLabel(ctx), d = (s && s.d) || {};
  const lines = ['💬 *Yetkili isteniyor* — ' + channelName(ctx.m.channel), '👤 ' + who];
  if(reason) lines.push('Sebep: ' + oneLine(reason));
  if(d.date) lines.push('Yarım kalan talep: ' + [dateLong(d.date), d.time, d.guests && d.guests + ' kişi', d.area && AREA[d.area]].filter(Boolean).join(' · '));
  if(ctx.m.text) lines.push('Son mesaj: “' + clean(ctx.m.text, 200) + '”');
  lines.push(ctx.m.channel === 'wa' ? 'Müşteriye bu numaradan (WhatsApp Business uygulaması) dönebilirsiniz.' : 'Müşteriye Instagram DM\'den dönebilirsiniz.');
  ctx.after.push(() => notifyStaff(ctx.env, lines.join('\n'), who + ' yetkiliyle görüşmek istiyor (' + channelName(ctx.m.channel) + ')'));
  return {step: 'human', human: Date.now() + HUMAN_MS, test: s && s.test};
}

// Seçilen düğmenin kimliğini (ör. "a:dis") ya da yazılan metne uyan kuralı döndürür.
// Başka bir adımın eski düğmesine basılırsa null döner.
function pick(ctx, prefix, rules){
  const c = ctx.m.choice;
  if(c) return c.startsWith(prefix + ':') ? c.slice(prefix.length + 1) : null;
  const hit = rules.find(([, re]) => re.test(ctx.t));
  return hit ? hit[0] : null;
}
function reask(ctx, s, hint){ ctx.notes.push(hint); return ask(ctx, s); }

/* Sıradaki boş soruyu sorar. Otomatik doldurulabilen adımlar (ör. dış alan kapalıysa alan) atlanır. */
function nextStep(d){
  if(d.kind === 'ozel' && !d.occasion) return 'occasion';
  if(!d.date) return 'date';
  if(!d.time) return 'time';
  if(!d.area) return 'area';
  if(!d.guests) return 'guests';
  if(!d.smoking) return 'smoking';
  if(d.request == null) return 'request';
  if(!d.name) return 'name';
  if(!d.phone) return 'phone';
  return 'confirm';
}
async function ask(ctx, s){
  for(let i = 0; i < 12; i++){
    s.step = nextStep(s.d);
    const q = await QUESTIONS[s.step](ctx, s);
    if(q){ say(ctx, q.text, q.options, q.button); return s; }
  }
  return s;
}

const QUESTIONS = {
  async occasion(ctx, s){
    if(s.d.occasionAsk) return {text: 'Kısaca ne kutluyoruz? ✍️'};
    return {text: '🎉 Ne kutluyoruz?', button: 'Seçin', options: OCCASIONS.map(([id, e, l]) => ({id: 'o:' + id, title: e + ' ' + l}))};
  },
  async date(ctx, s){
    const site = await siteInfo(ctx.env), today = trNow().date, options = [];
    for(let i = 0; options.length < 8 && i < 10; i++){
      const d = addDays(today, i);
      if(!slotsFor(d, site).length) continue;
      options.push({id: 'd:' + d, title: i === 0 ? 'Bugün' : i === 1 ? 'Yarın' : dateShort(d), desc: dateLong(d)});
    }
    options.push({id: 'd:other', title: '📝 Başka bir tarih', desc: 'Tarihi yazarak belirtin'});
    return {text: 'Hangi gün gelmek istersiniz? 📅', options, button: 'Tarih seç'};
  },
  async time(ctx, s){
    const all = slotsFor(s.d.date, await siteInfo(ctx.env));
    let step = SLOT, list = all;
    while(list.length > 10){ step += SLOT; list = all.filter(m => (m - all[0]) % step === 0); }
    return {text: dateLong(s.d.date) + ' saat kaçta gelmek istersiniz? 🕗' + (list.length < all.length ? '\n(Listede olmayan bir saat için yazabilirsiniz, ör. *20:30*)' : ''),
      options: list.map(m => ({id: 't:' + m, title: hm(m)})), button: 'Saat seç'};
  },
  async area(ctx, s){
    const o = await outdoorState(ctx.env);
    if(outdoorClosedOn(o, s.d.date)){
      s.d.area = 'ic';
      ctx.notes.push('🌧 ' + dateLong(s.d.date) + ' için dış alanımız ' + (o.note || 'hava koşulları nedeniyle') + ' kapalı; rezervasyonunuzu iç alanımıza alıyoruz.');
      return null;
    }
    return {text: 'Nerede oturmak istersiniz?', options: [{id: 'a:ic', title: '🏠 İç alan'}, {id: 'a:dis', title: '🌿 Dış alan'}, {id: 'a:any', title: 'Fark etmez'}]};
  },
  async guests(ctx, s){
    if(s.d.guestsAsk) return {text: 'Kaç kişi olacaksınız? Lütfen rakamla yazın (ör. 12).'};
    const options = [];
    for(let n = 1; n <= 9; n++) options.push({id: 'g:' + n, title: n + ' kişi'});
    options.push({id: 'g:more', title: '10 kişi ve üzeri'});
    return {text: 'Kaç kişi olacaksınız? 👥', options, button: 'Kişi sayısı'};
  },
  async smoking(ctx, s){
    // İç mekânda sigara yasak (4207 sayılı kanun); iç alanda soru sorulmaz, bilgi verilir
    if(s.d.area === 'ic'){
      s.d.smoking = 'no';
      ctx.notes.push('🚭 Bilginize: iç alanımızda sigara içilmemektedir.');
      return null;
    }
    return {text: 'Sigara tercihiniz nedir?', options: [{id: 's:yes', title: '🚬 Sigaralı'}, {id: 's:no', title: '🚭 Sigarasız'}]};
  },
  async request(ctx, s){
    return {text: '🍽 Menüden önceden hazırlanmasını istediğiniz bir şey ya da özel bir isteğiniz var mı?\n' +
      (s.d.kind === 'ozel' ? '(ör. pasta, süsleme, sürpriz, alerji)' : '(ör. belirli bir yemek, alerji, mama sandalyesi)') +
      '\n\nVarsa yazın, yoksa *Geç*\'e dokunun.', options: [{id: 'r:skip', title: 'Geç'}, {id: 'r:menu', title: '📖 Menüyü gör'}]};
  },
  async name(ctx, s){
    const p = clean(s.d.profile, 40);
    return {text: 'Rezervasyon kimin adına olsun? (Ad Soyad)', options: p && p.length <= 20 ? [{id: 'n:p', title: p}] : undefined};
  },
  async phone(ctx, s){
    return {text: '📞 Size ulaşabilmemiz için telefon numaranızı yazar mısınız? (ör. 0532 123 45 67)'};
  },
  async confirm(ctx, s){
    return {text: summary(s.d) + '\n\nBilgiler doğru mu?', options: [{id: 'c:ok', title: '✅ Onayla'}, {id: 'c:edit', title: '✏️ Baştan al'}, {id: 'c:no', title: '❌ Vazgeç'}]};
  }
};
function summary(d){
  return ['📋 *Rezervasyon özeti*',
    '📅 ' + dateLong(d.date) + ' · ' + d.time,
    '👥 ' + d.guests + ' kişi',
    '📍 ' + AREA[d.area] + ' · ' + (d.smoking === 'yes' ? '🚬 Sigaralı' : '🚭 Sigarasız')]
    .concat(d.occasion ? ['🎉 Özel gün: ' + d.occasion] : [], d.request ? ['🍽 İstek: ' + d.request] : [], ['👤 ' + d.name + ' · 📞 ' + d.phone])
    .join('\n');
}
function freshData(ctx, kind){
  const d = {kind, profile: ctx.m.name || ''};
  if(ctx.m.channel === 'wa') d.phone = localPhone(ctx.m.uid);
  return d;
}

const ANSWERS = {
  async menu(ctx, s){
    const c = pick(ctx, 'm', [['ozel', /dogum|yil ?donum|ozel gun|kutlama|teklif|surpriz|mezun/], ['rez', /rezerv|rezarv|masa|yer ayir|yer ayirt/],
      ['bilgi', /menu|fiyat|adres|konum|saat|nerede|bilgi|yol tarifi|acik mi/], ['yetkili', /gorus/]]);
    if(c === 'rez' || c === 'ozel'){
      s.d = freshData(ctx, c);
      // "doğum günü için yer ayırtmak istiyorum" gibi yazdıysa kutlama türü yeniden sorulmaz
      const o = !ctx.m.choice && c === 'ozel' && OCCASIONS.find(x => x[0] !== 'diger' && x[3].test(ctx.t));
      if(o) s.d.occasion = o[2];
      return ask(ctx, s);
    }
    if(c === 'bilgi'){ say(ctx, await infoText(ctx.env)); say(ctx, 'Başka nasıl yardımcı olabiliriz?', MAIN_OPTIONS, 'Seçenekler'); return s; }
    if(c === 'yetkili') return handoff(ctx, s);
    say(ctx, 'Lütfen aşağıdaki seçeneklerden birini seçin 👇', MAIN_OPTIONS, 'Seçenekler');
    return s;
  },
  async occasion(ctx, s){
    if(s.d.occasionAsk && !ctx.m.choice && ctx.t.length >= 2){ s.d.occasion = clean(ctx.m.text, 80); return ask(ctx, s); }
    const c = pick(ctx, 'o', OCCASIONS.map(o => [o[0], o[3]]));
    if(c === 'diger'){ s.d.occasionAsk = true; return ask(ctx, s); }
    const o = OCCASIONS.find(x => x[0] === c);
    if(o){ s.d.occasion = o[2]; return ask(ctx, s); }
    if(!ctx.m.choice && ctx.t.length >= 3){ s.d.occasion = clean(ctx.m.text, 80); return ask(ctx, s); }
    return reask(ctx, s, 'Listeden seçebilir ya da kısaca yazabilirsiniz.');
  },
  async date(ctx, s){
    const c = ctx.m.choice;
    if(c === 'd:other'){ say(ctx, 'Hangi tarih? Lütfen yazın (ör. *25.10* veya *25 Ekim*).'); return s; }
    const d = c ? (c.startsWith('d:') ? c.slice(2) : null) : parseDate(ctx.t);
    if(!d || !validDate(d)) return reask(ctx, s, 'Tarihi anlayamadım 🤔 Listeden seçebilir ya da *25.10* gibi yazabilirsiniz.');
    const today = trNow().date;
    if(d < today) return reask(ctx, s, 'Bu tarih geçmişte kaldı.');
    if(d > addDays(today, MAX_DAYS)) return reask(ctx, s, 'En fazla ' + MAX_DAYS + ' gün sonrası için rezervasyon alabiliyoruz.');
    if(!slotsFor(d, await siteInfo(ctx.env)).length) return reask(ctx, s, dateLong(d) + ' için rezervasyon saatlerimiz doldu, başka bir gün seçer misiniz?');
    s.d.date = d;
    return ask(ctx, s);
  },
  async time(ctx, s){
    const site = await siteInfo(ctx.env), c = ctx.m.choice;
    const min = c ? (c.startsWith('t:') ? +c.slice(2) : null) : parseTime(ctx.t, site);
    const h = serviceHours(site), now = trNow();
    if(min == null) return reask(ctx, s, 'Saati anlayamadım 🤔 Listeden seçebilir ya da *20:30* gibi yazabilirsiniz.');
    if(min < h.open || min > h.close - 60)
      return reask(ctx, s, 'Bu saatte rezervasyon alamıyoruz. Açık olduğumuz saatler ' + hm(h.open) + ' – ' + hm(h.close) + ', son rezervasyon ' + hm(h.close - 60) + '.');
    if(s.d.date === now.date && min < now.min + LEAD_MIN) return reask(ctx, s, 'Bu saat geçti ya da çok yakın; daha ileri bir saat seçer misiniz?');
    s.d.time = hm(min);
    return ask(ctx, s);
  },
  async area(ctx, s){
    const c = pick(ctx, 'a', [['any', /fark ?etmez|farketmez|hangisi olursa|ikisi de/], ['dis', /\b(dis|disari|disarda|disarisi|bahce|teras|acik hava)/], ['ic', /\b(ic|iceri|icerde|icerisi|salon)/]]);
    if(!c) return reask(ctx, s, 'Lütfen bir seçenek seçin 👇');
    if(c !== 'ic' && outdoorClosedOn(await outdoorState(ctx.env), s.d.date)) return ask(ctx, s);   // bu arada kapatıldıysa soru iç alana döner
    s.d.area = c;
    return ask(ctx, s);
  },
  async guests(ctx, s){
    if(ctx.m.choice === 'g:more'){ s.d.guestsAsk = true; return ask(ctx, s); }
    const c = ctx.m.choice;
    const n = c ? (/^g:\d+$/.test(c) ? +c.slice(2) : null) : parseCount(ctx.t);
    if(!n || n < 1) return reask(ctx, s, 'Kişi sayısını rakamla yazar mısınız? (ör. 4)');
    const max = +ctx.env.MAX_GUESTS || 30;
    if(n > max){ s.d.guests = n; return handoff(ctx, s, n + ' kişilik gruplar için ekibimiz sizinle özel olarak ilgilenecek.'); }
    s.d.guests = n;
    return ask(ctx, s);
  },
  async smoking(ctx, s){
    const c = pick(ctx, 's', [['no', /sigarasiz|icmiyor|icmeyen|icilmeyen|hayir|yok/], ['yes', /sigarali|iciyor|icen|icilen|icecek|evet|var/]]);
    if(!c) return reask(ctx, s, 'Lütfen bir seçenek seçin 👇');
    s.d.smoking = c;
    if(c === 'yes' && s.d.area === 'any') s.d.area = 'dis';   // sigara yalnızca dış alanda
    return ask(ctx, s);
  },
  async request(ctx, s){
    const c = ctx.m.choice;
    if(c === 'r:menu'){ say(ctx, '📖 Menümüz: ' + siteUrl(ctx.env)); return ask(ctx, s); }
    if(c === 'r:skip' || /^(gec|yok|hayir|yok tesekkurler|istemiyorum|gerek yok|-|bos)$/.test(ctx.t)) s.d.request = '';
    else if(c || ctx.t.length < 2) return reask(ctx, s, 'İsteğinizi yazabilir ya da *Geç*\'e dokunabilirsiniz.');
    else s.d.request = clean(ctx.m.text, 500);
    return ask(ctx, s);
  },
  async name(ctx, s){
    if(ctx.m.choice === 'n:p'){ s.d.name = clean(s.d.profile, 60); return ask(ctx, s); }
    const n = clean(ctx.m.text, 60);
    if(ctx.m.choice || n.length < 2 || !/[a-zçğıöşü]/i.test(n) || /\d{3}/.test(n)) return reask(ctx, s, 'Lütfen adınızı ve soyadınızı yazın.');
    s.d.name = n;
    return ask(ctx, s);
  },
  async phone(ctx, s){
    const p = ctx.m.choice ? null : parsePhone(ctx.m.text);
    if(!p) return reask(ctx, s, 'Numarayı anlayamadım. Lütfen *0532 123 45 67* biçiminde yazın.');
    s.d.phone = p;
    return ask(ctx, s);
  },
  async confirm(ctx, s){
    const c = pick(ctx, 'c', [['no', /^(hayir|vazgec|iptal|istemiyorum)/], ['edit', /duzelt|degistir|bastan|yanlis/], ['ok', /^(evet|onay|onayla|tamam|dogru|ok|olur|e$)/]]);
    if(c === 'ok'){ await createRequest(ctx, s.d, s.test); return {step: 'done', test: s.test}; }
    if(c === 'edit'){ s.d = freshData(ctx, s.d.kind); ctx.notes.push('Tamam, baştan alalım 👍'); return ask(ctx, s); }
    if(c === 'no'){ say(ctx, 'Tamam, talebi iptal ettim. Yeniden başlamak için *menü* yazmanız yeterli.'); return {step: 'done', test: s.test}; }
    return reask(ctx, s, 'Lütfen aşağıdaki düğmelerden birini seçin 👇');
  },
  async done(ctx, s){
    say(ctx, 'Rica ederiz 😊 Yeni bir talep için *menü*, ekibimizle görüşmek için *yetkili* yazabilirsiniz.');
    return s;
  }
};

async function createRequest(ctx, d, test){
  const D = await db(ctx.env);
  let ref;
  do{ ref = Array.from(crypto.getRandomValues(new Uint8Array(5)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join(''); }
  while(await D.prepare('SELECT 1 FROM requests WHERE ref = ?').bind(ref).first());
  const rec = {ref, channel: ctx.m.channel === 'wa' ? 'whatsapp' : 'instagram', kind: d.kind, occasion: d.occasion || '',
    date: d.date, time: d.time, area: d.area, guests: d.guests, smoking: d.smoking, request: d.request || '',
    name: d.name, phone: d.phone, test: !!test, createdAt: new Date().toISOString()};
  if(ctx.m.channel === 'ig') rec.igUser = await igUsername(ctx.env, ctx.m.uid);
  await D.prepare('INSERT INTO requests (ref, channel, user_id, data, created) VALUES (?, ?, ?, ?, ?)')
    .bind(ref, ctx.m.channel, ctx.m.uid, JSON.stringify(rec), Date.now()).run();
  say(ctx, '✅ *Rezervasyon talebiniz alınmıştır!*\n\nTalep kodunuz: *' + ref + '*\nEkibimiz masanızı ayarlayıp onayı kısa süre içinde buradan iletecek. Teşekkür ederiz 🙏');
  const lines = ['🆕 *Yeni rezervasyon talebi*' + (rec.test ? ' (TEST)' : '') + ' — ' + channelName(rec.channel),
    'Kod: *' + ref + '*',
    '📅 ' + dateLong(rec.date) + ' · ' + rec.time,
    '👥 ' + rec.guests + ' kişi · ' + AREA[rec.area] + ' · ' + (rec.smoking === 'yes' ? '🚬 Sigaralı' : '🚭 Sigarasız')];
  if(rec.occasion) lines.push('🎉 Özel gün: ' + rec.occasion);
  if(rec.request) lines.push('🍽 İstek: ' + rec.request);
  lines.push('👤 ' + rec.name + ' · ' + rec.phone + (rec.igUser ? ' · ' + rec.igUser : ''), '', 'Masaya yerleştirildi, onay bekliyor: ' + siteUrl(ctx.env) + '/admin.html');
  const short = rec.name + ', ' + dateLong(rec.date) + ' ' + rec.time + ', ' + rec.guests + ' kişi, ' + AREA[rec.area] + ' (kod ' + ref + ')';
  ctx.after.push(() => notifyStaff(ctx.env, lines.join('\n'), short));
}

/* ---------- Personel ---------- */
const STAFF_HELP = '👋 *Personel komutları*\n' +
  '• *dış kapat* – bugün dış alanı kapat (yağmur vb.)\n' +
  '• *dış kapat yarın* – bugün ve yarın kapalı\n' +
  '• *dış kapat süresiz* – siz açana kadar kapalı\n' +
  '• *dış aç* – dış alanı aç\n' +
  '• *durum* – bot durumu\n' +
  '• *test* – botu müşteri gibi deneyin\n\n' +
  'İpucu: Her gün bu numaraya bir kez yazmanız (ör. *durum*), o gün gelen bildirimlerin ayrıntılı ve ücretsiz gelmesini sağlar.';
async function staffCommand(ctx){
  const t = ctx.t, env = ctx.env, today = trNow().date;
  if(t === 'test'){
    ctx.notes.push('🧪 Test modu açıldı: artık müşteri gibi konuşabilirsiniz. Çıkmak için *personel* yazın.');
    return greet(ctx, {test: true});
  }
  let m;
  if((m = /^dis(?: alan(?:i)?)? (?:kapat|kapa|kapali)(.*)$/.exec(t))){
    const arg = m[1];
    const until = /suresiz|surekli|acana kadar|hep/.test(arg) ? 'always' : /yarin/.test(arg) ? addDays(today, 1) : today;
    await setSetting(env, 'outdoor', {closedUntil: until, note: ''});
    say(ctx, '🌧 Dış alan kapatıldı (' + (until === 'always' ? 'siz açana kadar' : dateLong(until) + ' dahil') + '). Bot bu günlerde yalnızca iç alana rezervasyon alacak.');
    return null;
  }
  if(/^dis(?: alan(?:i)?)? (?:ac|acik)$/.test(t)){
    await setSetting(env, 'outdoor', {closedUntil: null, note: ''});
    say(ctx, '☀️ Dış alan açıldı; bot yeniden dış alan için de rezervasyon alacak.');
    return null;
  }
  if(t === 'durum'){
    const D = await db(env), o = await outdoorState(env);
    const waiting = await D.prepare('SELECT COUNT(*) AS n FROM requests WHERE imported = 0').first();
    const day = await D.prepare('SELECT COUNT(*) AS n FROM requests WHERE created > ?').bind(Date.now() - 864e5).first();
    say(ctx, '📊 *Bot durumu*\n' +
      '• Dış alan: ' + (outdoorClosedOn(o, today) ? 'kapalı (' + (o.closedUntil === 'always' ? 'siz açana kadar' : dateLong(o.closedUntil) + ' dahil') + ')' : 'açık') + '\n' +
      '• Son 24 saatte gelen talep: ' + day.n + '\n' +
      '• Panele henüz aktarılmamış talep: ' + waiting.n + (waiting.n ? ' (yönetim panelini açınca aktarılır)' : ''));
    return null;
  }
  say(ctx, STAFF_HELP);
  return null;
}
// Personel numaralarına bildirim. Personel son 24 saatte bu numaraya yazdıysa düz metin (ücretsiz),
// yazmadıysa onaylı şablon (STAFF_TEMPLATE) kullanılır; WhatsApp pencere dışında düz metni teslim etmez.
async function notifyStaff(env, text, short){
  const D = await db(env);
  const res = await Promise.allSettled(staffNumbers(env).map(async num => {
    const c = await D.prepare('SELECT last_in FROM contacts WHERE k = ?').bind('wa:' + num).first();
    if(env.STAFF_TEMPLATE && !(c && Date.now() - c.last_in < WINDOW_MS)) return waTemplate(env, num, env.STAFF_TEMPLATE, [short]);
    return waSend(env, num, {text});
  }));
  res.forEach(r => { if(r.status === 'rejected') console.error('personel bildirimi', r.reason && r.reason.message); });
}

/* ---------- Mesaj gönderme ---------- */
const graphVer = env => env.GRAPH_VERSION || 'v23.0';
async function graph(url, token, body){
  const r = await fetch(url, {method: 'POST', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if(!r.ok){ const e = new Error((j.error && j.error.message) || 'HTTP ' + r.status); e.code = j.error && j.error.code; throw e; }
  return j;
}
function send(env, channel, uid, msg){ return channel === 'wa' ? waSend(env, uid, msg) : igSend(env, uid, msg); }
// En fazla 3 kısa seçenek → düğme; daha fazlası → açılır liste (en fazla 10 satır)
function waSend(env, to, msg){
  const opts = msg.options || [], text = cut(msg.text, opts.length ? 1024 : 4096);
  let payload;
  if(!opts.length) payload = {type: 'text', text: {body: text, preview_url: /https?:\/\//.test(text)}};
  else if(opts.length <= 3 && opts.every(o => o.title.length <= 20 && !o.desc))
    payload = {type: 'interactive', interactive: {type: 'button', body: {text},
      action: {buttons: opts.map(o => ({type: 'reply', reply: {id: o.id, title: o.title}}))}}};
  else payload = {type: 'interactive', interactive: {type: 'list', body: {text},
    action: {button: cut(msg.button || 'Seçenekler', 20), sections: [{title: 'Seçenekler',
      rows: opts.slice(0, 10).map(o => Object.assign({id: o.id, title: cut(o.title, 24)}, o.desc ? {description: cut(o.desc, 72)} : {}))}]}}};
  return graph('https://graph.facebook.com/' + graphVer(env) + '/' + env.WA_PHONE_ID + '/messages', env.WA_TOKEN,
    Object.assign({messaging_product: 'whatsapp', recipient_type: 'individual', to}, payload));
}
function waTemplate(env, to, name, params){
  return graph('https://graph.facebook.com/' + graphVer(env) + '/' + env.WA_PHONE_ID + '/messages', env.WA_TOKEN, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: {name, language: {code: env.TEMPLATE_LANG || 'tr'},
      components: params.length ? [{type: 'body', parameters: params.map(p => ({type: 'text', text: oneLine(p)}))}] : []}
  });
}
async function igSend(env, to, msg){
  // Instagram kalın yazı (*…*) desteklemez; hızlı yanıt düğmeleri en fazla 13 adet, 20 karakter
  const message = {text: cut(String(msg.text).replace(/\*/g, ''), 1000)};
  if(msg.options && msg.options.length) message.quick_replies = msg.options.slice(0, 13).map(o => ({content_type: 'text', title: cut(o.title, 20), payload: o.id}));
  return graph('https://graph.instagram.com/' + graphVer(env) + '/me/messages', await igToken(env), {recipient: {id: to}, message});
}

/* ---------- Instagram erişim anahtarı ---------- */
// IG_TOKEN 60 gün geçerli; bot haftada bir yeniler ve yenisini veritabanında tutar.
// Cloudflare'de IG_TOKEN değiştirilirse eski kayıt yok sayılır.
async function igToken(env){
  if(!env.IG_TOKEN) return '';
  const cur = await getSetting(env, 'ig_token');
  return cur && cur.base === env.IG_TOKEN.slice(-16) ? cur.token : env.IG_TOKEN;
}
async function refreshIgToken(env){
  if(!env.IG_TOKEN) return;
  const cur = await getSetting(env, 'ig_token'), base = env.IG_TOKEN.slice(-16);
  const valid = cur && cur.base === base;
  if(valid && Date.now() - cur.at < 7 * 864e5) return;
  const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(valid ? cur.token : env.IG_TOKEN));
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.access_token) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  await setSetting(env, 'ig_token', {token: j.access_token, base, at: Date.now()});
}
async function igUsername(env, id){
  try{
    const r = await fetch('https://graph.instagram.com/' + graphVer(env) + '/' + encodeURIComponent(id) + '?fields=username,name', {headers: {'Authorization': 'Bearer ' + await igToken(env)}});
    const j = await r.json();
    return j.username ? '@' + j.username : (j.name || '');
  }catch(e){ return ''; }
}

/* ---------- Yönetim paneli API'si ---------- */
function cors(env, res){
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return new Response(res.body, {status: res.status, headers: h});
}
async function api(req, url, env){
  if(!env.ADMIN_KEY || !safeEqual(req.headers.get('authorization') || '', 'Bearer ' + env.ADMIN_KEY)) return json({error: 'Yönetici anahtarı hatalı.'}, 401);
  const D = await db(env);
  const post = req.method === 'POST', body = post ? await req.json().catch(() => ({})) : null;
  switch(url.pathname){
    case '/api/health':
      return json({ok: true, whatsapp: !!(env.WA_TOKEN && env.WA_PHONE_ID), instagram: !!(await igToken(env)),
        staff: staffNumbers(env).length, outdoor: await outdoorState(env)});
    case '/api/inbox': {
      const r = await D.prepare('SELECT data FROM requests WHERE imported = 0 ORDER BY created LIMIT 50').all();
      return json({requests: r.results.map(x => JSON.parse(x.data)), outdoor: await outdoorState(env)});
    }
    case '/api/ack': {
      if(!post) break;
      const refs = (Array.isArray(body.refs) ? body.refs : []).filter(x => typeof x === 'string').slice(0, 100);
      if(refs.length) await D.batch(refs.map(r => D.prepare('UPDATE requests SET imported = 1 WHERE ref = ?').bind(r)));
      return json({ok: true});
    }
    case '/api/settings': {
      if(post && body.outdoor !== undefined){
        const u = body.outdoor && body.outdoor.closedUntil;
        if(u && u !== 'always' && !validDate(u)) return json({error: 'Geçersiz tarih'}, 400);
        await setSetting(env, 'outdoor', {closedUntil: u || null, note: clean(body.outdoor && body.outdoor.note, 80)});
      }
      return json({outdoor: await outdoorState(env)});
    }
    case '/api/notify':
      if(!post) break;
      return apiNotify(env, body);
  }
  return json({error: 'Bulunamadı'}, 404);
}
// Personel panelde talebi onaylayınca / iptal edince müşteriye mesaj
async function apiNotify(env, b){
  const D = await db(env);
  const row = await D.prepare('SELECT * FROM requests WHERE ref = ?').bind(String(b.ref || '')).first();
  if(!row) return json({error: 'Talep bulunamadı (çok eski olabilir).'}, 404);
  if(b.status !== 'confirmed' && b.status !== 'cancelled') return json({error: 'Geçersiz durum'}, 400);
  if(row.notified === b.status) return json({ok: true, skipped: true, channel: row.channel});
  const site = await siteInfo(env), first = firstName(b.name), guests = +b.guests || 0;
  const when = (validDate(b.date) ? dateLong(b.date) : '') + (parseHM(b.time) != null ? ' · ' + b.time : '');
  const text = b.status === 'confirmed'
    ? '✅ *Rezervasyonunuz onaylandı!*\n\n📅 ' + when + '\n👥 ' + guests + ' kişi' +
      (b.area ? '\n📍 ' + clean(b.area, 40) + (b.tables ? ' · Masa ' + clean(b.tables, 40) : '') : '') +
      '\n\nSizi ağırlamayı dört gözle bekliyoruz' + (first ? ', ' + first : '') + '! Bir değişiklik olursa buradan yazabilirsiniz.\n— ' + (site.name || 'Yirmi')
    : 'Merhaba' + (first ? ' ' + first : '') + ', üzgünüz 🙏 ' + when + ' için ' + guests + ' kişilik uygun masamız kalmadı.\n' +
      'Farklı bir gün veya saat için *menü* yazarak yeni talep oluşturabilirsiniz.\n— ' + (site.name || 'Yirmi');
  const c = await D.prepare('SELECT last_in FROM contacts WHERE k = ?').bind(row.channel + ':' + row.user_id).first();
  const open = c && Date.now() - c.last_in < WINDOW_MS;
  try{
    if(open) await send(env, row.channel, row.user_id, {text});
    else if(row.channel === 'wa' && b.status === 'confirmed' && env.CONFIRM_TEMPLATE)
      await waTemplate(env, row.user_id, env.CONFIRM_TEMPLATE, [first || 'Misafirimiz', when, String(guests)]);
    else return json({error: 'Müşteri 24 saatten uzun süredir yazmadığı için ' + channelName(row.channel) + ' otomatik mesaja izin vermiyor. Lütfen telefonla bilgi verin.'}, 409);
  }catch(e){
    return json({error: 'Mesaj gönderilemedi: ' + e.message}, 502);
  }
  await D.prepare('UPDATE requests SET notified = ? WHERE ref = ?').bind(b.status, row.ref).run();
  return json({ok: true, channel: row.channel});
}

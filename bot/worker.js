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
 *   WA_PHONE_ID       WhatsApp "Phone number ID" (şu an kullanılan numara, ör. test numarası)
 *   WA_BOT_PHONE_ID   (isteğe bağlı) Meta onayı beklenen asıl bot numarasının Phone number ID'si; onaylanınca kendiliğinden devreye girer
 *   WA_WABA_ID        Asıl bot numarasının bağlı olduğu "WhatsApp Business Account ID"
 *   WA_PIN            Asıl bot numarası için 6 haneli iki adımlı doğrulama PIN'i (kayıt sırasında kullanılır)
 *   IG_TOKEN          Instagram erişim anahtarı (60 günlük; bot her hafta kendisi yeniler)
 *   STAFF_NUMBERS     Bildirim alacak personel numaraları, virgülle: 905321112233,905441112233
 *   ADMIN_KEY         Yönetim panelinin bota bağlanırken kullandığı uzun, rastgele anahtar
 *   STAFF_TEMPLATE    (isteğe bağlı) 24 saat penceresi dışında personele gidecek şablonun adı
 *   CONFIRM_TEMPLATE  (isteğe bağlı) 24 saat dışında müşteriye gidecek onay şablonunun adı
 *
 * Sorular, seçenekler, en kalabalık grup sınırı ve personel bildirimi yönetim panelinin "Bot" sekmesinden ayarlanır (menu.json → site.bot).
 *   GRAPH_VERSION     (isteğe bağlı) Meta Graph API sürümü, varsayılan v23.0
 */

const VERSION = '2026-10-28c';          // Cloudflare'deki kodun güncel olup olmadığını anlamak için (ana sayfada görünür)
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

/* ---------- Botun metinleri ve seçenekleri ---------- */
// Yönetim paneli → Bot sekmesinden değiştirilir ve menu.json içinde site.bot olarak yayınlanır.
// Panelde boş bırakılan alan buradaki varsayılana döner. Metinlerde: {ad} {isletme} {tarih} {kod}
const BOT_DEFAULTS = {
  welcome: 'Merhaba {ad}! 👋\n*{isletme} Restoran*\'a hoş geldiniz.\nSize nasıl yardımcı olabiliriz?',
  menu: {
    rez: {on: true, title: '📅 Rezervasyon', desc: 'Masa ayırtın'},
    ozel: {on: true, title: '🎉 Özel gün', desc: 'Doğum günü, yıldönümü, kutlama…'},
    bilgi: {on: true, title: '📖 Menü & bilgi', desc: 'Menü, çalışma saatleri, adres'},
    yetkili: {on: true, title: '💬 Yetkiliyle görüş', desc: 'Ekibimize bağlanın'}
  },
  occasions: ['🎂 Doğum günü', '💍 Yıldönümü', '💐 Evlilik teklifi', '💼 İş yemeği', '🎓 Mezuniyet / kutlama'],
  // Oturma yeri ve sigara tercihi tek soruda sorulur (mesaj sayısını azaltmak için)
  areas: {
    ic: {on: true, title: '🏠 İç alan', desc: 'Kapalı salon · sigara içilmez'},
    dis_s: {on: true, title: '🚬 Dış alan · sigaralı', desc: 'Bahçe, sigara içilebilir'},
    dis_n: {on: true, title: '🌿 Dış alan · sigarasız', desc: 'Bahçe, sigara içilmeyen bölüm'},
    any: {on: true, title: 'Fark etmez', desc: 'Uygun olan yere yerleştirelim'}
  },
  q: {
    occasion: '🎉 Ne kutluyoruz?',
    date: 'Hangi gün gelmek istersiniz? 📅',
    time: '{tarih} saat kaçta gelmek istersiniz? 🕗',
    area: 'Nerede oturmak istersiniz?',
    guests: 'Kaç kişi olacaksınız? 👥',
    request: '🍽 Menüden önceden hazırlanmasını istediğiniz bir şey ya da özel bir isteğiniz var mı?\n(ör. belirli bir yemek, alerji, mama sandalyesi)\n\nVarsa yazın, yoksa *Geç*\'e dokunun.',
    requestOzel: '🍽 Pasta, süsleme, sürpriz ya da menüden özel bir isteğiniz var mı?\n(ör. pasta, süsleme, sürpriz, alerji)\n\nVarsa yazın, yoksa *Geç*\'e dokunun.',
    name: 'Rezervasyon kimin adına olsun? (Ad Soyad)',
    confirm: 'Bilgiler doğru mu?'
  },
  done: '✅ *Rezervasyon talebiniz alınmıştır!*\n\nTalep kodunuz: *{kod}*\nEkibimiz masanızı ayarlayıp onayı kısa süre içinde buradan iletecek. Teşekkür ederiz 🙏',
  handoff: '🙋 Sizi ekibimize aktardım; en kısa sürede buradan dönüş yapacağız.\n(Otomatik asistana dönmek için *menü* yazabilirsiniz.)',
  askRequest: true,      // menü / özel istek sorusu sorulsun mu
  notifyNew: true,       // yeni rezervasyonda personele WhatsApp bildirimi (talebi açan bağlantıyla)
  maxGuests: 30          // bundan kalabalık gruplar yetkiliye aktarılır
};
const MENU_KEYS = ['rez', 'ozel', 'bilgi', 'yetkili'], AREA_KEYS = ['ic', 'dis_s', 'dis_n', 'any'];
function mergeBotCfg(b){
  b = b && typeof b === 'object' ? b : {};
  const D = BOT_DEFAULTS, str = (v, d) => typeof v === 'string' && v.trim() ? v : d;
  const items = (src, def) => Object.fromEntries(Object.entries(def).map(([k, d]) => {
    const s = (src || {})[k] || {};
    return [k, {on: s.on !== false, title: str(s.title, d.title), desc: typeof s.desc === 'string' ? s.desc : d.desc}];
  }));
  const occ = Array.isArray(b.occasions) ? b.occasions.map(x => String(x).trim()).filter(Boolean) : [];
  const out = {
    welcome: str(b.welcome, D.welcome), menu: items(b.menu, D.menu), areas: items(b.areas, D.areas),
    occasions: (occ.length ? occ : D.occasions).slice(0, 9),
    q: Object.fromEntries(Object.keys(D.q).map(k => [k, str((b.q || {})[k], D.q[k])])),
    done: str(b.done, D.done), handoff: str(b.handoff, D.handoff),
    askRequest: b.askRequest !== false, notifyNew: b.notifyNew !== false,
    maxGuests: +b.maxGuests > 0 ? Math.min(200, Math.round(+b.maxGuests)) : D.maxGuests
  };
  if(!MENU_KEYS.some(k => out.menu[k].on)) out.menu.rez.on = true;
  if(!AREA_KEYS.some(k => out.areas[k].on)) out.areas.ic.on = true;
  return out;
}
async function botCfg(env){ return mergeBotCfg((await siteInfo(env)).bot); }
const fill = (tpl, v) => String(tpl).replace(/ ?\{ad\}/g, v.ad ? ' ' + v.ad : '').replace(/\{(isletme|tarih|kod)\}/g, (m, k) => v[k] != null ? v[k] : m).trim();
const mainOptions = cfg => MENU_KEYS.filter(k => cfg.menu[k].on).map(k => ({id: 'm:' + k, title: cfg.menu[k].title, desc: cfg.menu[k].desc || undefined}));
const plainLabel = l => String(l).replace(/^[^\p{L}\p{N}]+/u, '').trim() || String(l);
// "doğum günümüz var" → "🎂 Doğum günü"
function occMatch(cfg, t){
  return cfg.occasions.find(l => { const n = norm(l); return n.length >= 3 && (t.includes(n) || (n.split(' ')[0].length >= 4 && t.includes(n.split(' ')[0]))); });
}
function applyArea(d, k){
  d.areaKey = k;
  d.area = k === 'ic' ? 'ic' : k === 'any' ? 'any' : 'dis';
  d.smoking = k === 'dis_s' ? 'yes' : 'no';
}
const looksLikeName = s => { const n = clean(s, 61); return n.length >= 2 && n.length <= 60 && /[a-zçğıöşü]/i.test(n) && !/\d/.test(n) && n.split(' ').length <= 5; };

export default {
  // Yönetim paneli ve simülatör, varsayılan metinleri buradan okur
  botDefaults(){ return JSON.parse(JSON.stringify(BOT_DEFAULTS)); },
  mergeBotCfg(b){ return mergeBotCfg(b); },
  clearCache(){ siteCache = null; },
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    try{
      if(url.pathname === '/webhook') return await webhook(req, url, env, ctx);
      if(url.pathname === '/wa') return await waRedirect(url, env);
      if(url.pathname.startsWith('/api/')){
        if(req.method === 'OPTIONS') return cors(env, new Response(null, {status: 204}));
        return cors(env, await api(req, url, env));
      }
      return new Response('Yirmi rezervasyon asistanı çalışıyor. (sürüm ' + VERSION + ')', {headers: {'content-type': 'text/plain; charset=utf-8'}});
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
  'CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, t INTEGER NOT NULL)',
  // Personelin müşteriyle bot üzerinden yazışması: her müşteriye kısa bir kod, personele giden her bildirimin hangi müşteriye ait olduğu
  'CREATE TABLE IF NOT EXISTS relay (code TEXT PRIMARY KEY, k TEXT NOT NULL UNIQUE, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS relay_msgs (mid TEXT PRIMARY KEY, k TEXT NOT NULL, t INTEGER NOT NULL)',
  // Her WhatsApp kişisine, en son hangi bot numarasına yazdıysa o numaradan cevap verilir
  'CREATE TABLE IF NOT EXISTS routes (k TEXT PRIMARY KEY, pid TEXT NOT NULL)',
  // Aylık gönderilen WhatsApp mesajı sayısı (maliyet takibi)
  'CREATE TABLE IF NOT EXISTS stats (k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
  // Sohbet geçmişi (yönetim panelindeki "Sohbetler" sekmesi için; 30 gün saklanır)
  'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, dir TEXT NOT NULL, text TEXT NOT NULL, by TEXT, t INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS messages_k ON messages (k, id)',
  'CREATE TABLE IF NOT EXISTS chats (k TEXT PRIMARY KEY, last_t INTEGER NOT NULL, last_text TEXT, last_dir TEXT, unread INTEGER NOT NULL DEFAULT 0)'
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
const monthKey = () => 'wa:' + trNow().date.slice(0, 7);
async function countMsg(env){
  try{ await (await db(env)).prepare('INSERT INTO stats (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(monthKey()).run(); }
  catch(e){ console.error('sayaç', e.message); }
}
async function monthCount(env){
  const r = await (await db(env)).prepare('SELECT n FROM stats WHERE k = ?').bind(monthKey()).first();
  return r ? r.n : 0;
}
// Sohbet kaydı. dir: in (müşteri) · out (bot) · staff (personel) · sys (sistem notu)
async function logMsg(env, k, dir, text, by){
  try{
    const D = await db(env), t = Date.now(), body = String(text || '').slice(0, 2000);
    await D.batch([
      D.prepare('INSERT INTO messages (k, dir, text, by, t) VALUES (?, ?, ?, ?, ?)').bind(k, dir, body, by || null, t),
      D.prepare("INSERT INTO chats (k, last_t, last_text, last_dir, unread) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(k) DO UPDATE SET last_t = ?2, last_text = ?3, last_dir = ?4, " +
        "unread = CASE WHEN ?4 = 'in' THEN chats.unread + 1 WHEN ?4 = 'staff' THEN 0 ELSE chats.unread END")
        .bind(k, t, body.slice(0, 160), dir, dir === 'in' ? 1 : 0)
    ]);
  }catch(e){ console.error('sohbet kaydı', e.message); }
}
const msgLogText = msg => String(msg.text || '') + (msg.options && msg.options.length ? '\n[' + msg.options.map(o => o.title).join(' · ') + ']' : '');
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
    D.prepare('DELETE FROM contacts WHERE last_in < ?').bind(now - 120 * day),
    D.prepare('DELETE FROM relay_msgs WHERE t < ?').bind(now - 3 * day),
    D.prepare('DELETE FROM relay WHERE updated < ?').bind(now - 30 * day),
    D.prepare('DELETE FROM messages WHERE t < ?').bind(now - 30 * day),
    D.prepare('DELETE FROM chats WHERE last_t < ?').bind(now - 30 * day)
  ]);
  await refreshIgToken(env).catch(e => console.error('ig token', e && e.message || e));
  await ensureBotNumber(env).catch(e => console.error('bot numarası', e && e.message || e));
}

/* ---------- Botun asıl WhatsApp numarası (WA_BOT_PHONE_ID) ---------- */
// Meta numarayı onaylayınca bot onu kendisi kaydeder (WA_PIN), WhatsApp hesabını uygulamaya abone eder (WA_WABA_ID)
// ve ana numara yapar. O andan itibaren /wa yönlendirmesi ve personel bildirimleri bu numarayı kullanır.
async function getJSON(url, token){
  const r = await fetch(url, {headers: {'Authorization': 'Bearer ' + token}});
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  return j;
}
async function ensureBotNumber(env){
  const pid = String(env.WA_BOT_PHONE_ID || '').trim();
  if(!pid || !env.WA_TOKEN) return null;
  const st = (await getSetting(env, 'wa_bot')) || {};
  const same = st.pid === pid;
  if(same && st.live) return st;
  const base = 'https://graph.facebook.com/' + graphVer(env) + '/';
  const next = Object.assign({}, same ? st : {}, {pid, at: Date.now(), error: ''});
  try{
    const info = await getJSON(base + pid + '?fields=display_phone_number,verified_name,name_status,new_name_status,status', env.WA_TOKEN);
    Object.assign(next, {number: info.display_phone_number || '', name: info.verified_name || '', nameStatus: info.name_status || '',
      newNameStatus: info.new_name_status || '', status: info.status || ''});
    // Yeni görünen ad onaylandığında Meta numaranın yeniden kaydedilmesini ister; kayıtla birlikte yeni ad devreye girer
    if(next.newNameStatus === 'APPROVED'){
      if(!/^\d{6}$/.test(String(env.WA_PIN || ''))) throw new Error('Yeni görünen ad onaylandı; numarayı yeniden kaydetmek için WA_PIN (6 haneli) gerekli');
      try{ await graph(base + pid + '/register', env.WA_TOKEN, {messaging_product: 'whatsapp', pin: String(env.WA_PIN)}); }
      catch(e){ throw new Error('Yeni ad için yeniden kayıt yapılamadı: ' + e.message + (/pin/i.test(e.message) ? ' — WhatsApp Manager\'daki iki adımlı doğrulama PIN\'i ile Cloudflare\'deki WA_PIN aynı olmalı' : '')); }
      next.registered = true;
      next.nameStatus = 'APPROVED';
    }
    if(!next.registered){
      if(next.status === 'CONNECTED') next.registered = true;
      else{
        if(!/^\d{6}$/.test(String(env.WA_PIN || ''))) throw new Error('WA_PIN (6 haneli) girilmemiş');
        try{ await graph(base + pid + '/register', env.WA_TOKEN, {messaging_product: 'whatsapp', pin: String(env.WA_PIN)}); }
        catch(e){ throw new Error('Numara kaydı (WA_BOT_PHONE_ID ' + pid + ') yapılamadı: ' + e.message); }
        next.registered = true;
      }
    }
    if(!next.subscribed){
      if(!env.WA_WABA_ID) throw new Error('WA_WABA_ID girilmemiş');
      const waba = String(env.WA_WABA_ID).trim();
      try{ await graph(base + waba + '/subscribed_apps', env.WA_TOKEN, {}); }
      catch(e){ throw new Error('WhatsApp hesabı (WA_WABA_ID ' + waba + ') uygulamaya bağlanamadı: ' + e.message + ' — WA_WABA_ID, WhatsApp Manager > Hesap bilgileri bölümündeki "WhatsApp Business hesabı kimliği" olmalı'); }
      next.subscribed = true;
    }
    // Görünen ad onaylanmadan müşteriler bu numaraya yönlendirilmez
    if(!/^(APPROVED|AVAILABLE_WITHOUT_REVIEW)$/.test(next.nameStatus)) throw new Error('Meta görünen adı henüz onaylamadı (' + (next.nameStatus || 'bilinmiyor') + ')');
    next.live = true;
  }catch(e){ next.error = e.message; }
  await setSetting(env, 'wa_bot', next);
  if(next.live && !(same && st.live)){
    await setSetting(env, 'wa_primary', pid);
    await notifyStaff(env, '🎉 *Bot numarası aktif oldu!*\nMüşteriler artık *' + (next.name || 'restoran') + '* hesabıyla konuşacak: https://wa.me/' + next.number.replace(/\D/g, '') +
      '\n\nBildirimlerin gelmeye devam etmesi için bu bağlantıdan yeni numaraya bir kez *durum* yazın.', 'Bot numarası aktif oldu');
  }
  return next;
}
async function primaryPid(env){ return (await getSetting(env, 'wa_primary')) || String(env.WA_PHONE_ID || '').trim(); }
async function waPid(env, to){
  const r = await (await db(env)).prepare('SELECT pid FROM routes WHERE k = ?').bind('wa:' + to).first();
  return (r && r.pid) || primaryPid(env);
}
// Sitedeki "Rezervasyon" düğmesi buraya bağlanır: bot numarası açıksa ona, değilse restoranın kendi numarasına yönlendirir
async function waRedirect(url, env){
  const st = await getSetting(env, 'wa_bot').catch(() => null), site = await siteInfo(env);
  const num = String(st && st.live && st.number ? st.number : ((site.social || {}).whatsapp || site.phone || '')).replace(/\D/g, '').replace(/^0/, '90');
  const text = url.searchParams.get('text') || 'Merhaba, rezervasyon yapmak istiyorum.';
  return Response.redirect('https://wa.me/' + num + '?text=' + encodeURIComponent(text), 302);
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
// WhatsApp kullanıcı adı kullanan müşterilerde numara yerine kimlik gelebilir; o zaman telefon müşteriye sorulur
function localPhone(waId){ return /^90\d{10}$/.test(waId) ? fmtPhone(waId.slice(2)) : /^\d{8,15}$/.test(waId) ? '+' + waId : ''; }
function randomCode(n){ return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join(''); }
const MEDIA_LABEL = {image: 'fotoğraf', audio: 'sesli mesaj', video: 'video', document: 'belge', sticker: 'çıkartma', location: 'konum', contacts: 'kişi kartı'};

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
      (v.contacts || []).forEach(c => { names[c.wa_id || c.user_id] = (c.profile && c.profile.name) || ''; });
      for(const m of v.messages || []){
        if(['reaction', 'system', 'unsupported', 'ephemeral'].includes(m.type)) continue;
        if(!await firstSeen(env, 'wa:' + m.id)) continue;
        const uid = m.from || m.from_user_id;
        if(!uid) continue;
        const inp = {channel: 'wa', uid, name: names[uid] || '', text: '', choice: null, media: false,
          id: m.id, replyTo: (m.context && m.context.id) || null, mediaType: m.type, pid: v.metadata && v.metadata.phone_number_id};
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
      const inp = {channel: 'ig', uid: ev.sender.id, name: '', text: '', choice: null, media: false, id: mid};
      if(pb){ inp.text = pb.title || ''; inp.choice = pb.payload || null; }
      else{
        inp.text = msg.text || ''; inp.choice = (msg.quick_reply && msg.quick_reply.payload) || null;
        inp.media = !msg.text && !!msg.attachments;
        if(inp.media) inp.mediaType = (msg.attachments[0] || {}).type;
      }
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
  if(m.pid) await D.prepare('INSERT INTO routes (k, pid) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET pid = ?2').bind(key, m.pid).run();
  // Instagram ismi gelmez; panelde görünsün diye kullanıcı adı bir kez alınır
  if(m.channel === 'ig'){
    const c = await D.prepare('SELECT name FROM contacts WHERE k = ?').bind(key).first();
    if(!(c && c.name)){ const u = await igUsername(env, m.uid); if(u) await D.prepare('UPDATE contacts SET name = ? WHERE k = ?').bind(u, key).run(); }
  }
  const row = await D.prepare('SELECT data, updated FROM sessions WHERE k = ?').bind(key).first();
  let s = row ? JSON.parse(row.data) : null;
  if(s && !s.human && now - row.updated > SESSION_MS) s = null;     // yarım kalmış eski sohbet
  const ctx = {env, m, key, t: norm(m.text), out: [], notes: [], after: []};

  const staff = m.channel === 'wa' && staffNumbers(env).includes(m.uid);
  const logIt = !staff || !!(s && s.test);   // personelin bota yazdığı komutlar sohbet listesine girmez
  if(logIt) await logMsg(env, key, 'in', m.media ? '[' + (MEDIA_LABEL[m.mediaType] || 'dosya') + ']' : (m.text || ''));
  if(staff && !(s && s.test)) s = await staffCommand(ctx);
  else{
    if(s && s.human){
      // Personel ilgileniyor: bot susar, müşterinin mesajı personele iletilir
      if(s.human > now && !/^(menu|bot|asistan|personel)$/.test(ctx.t)){ await forwardToStaff(ctx, '💬'); return; }
      s = {test: s.test};
    }
    s = await converse(ctx, s);
    if(!staff && s && !s.human && (await getSetting(env, 'mirror'))) ctx.after.push(() => forwardToStaff(ctx, '👁'));
  }

  if(s) await D.prepare('INSERT INTO sessions (k, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET data = ?2, updated = ?3').bind(key, JSON.stringify(s), now).run();
  else await D.prepare('DELETE FROM sessions WHERE k = ?').bind(key).run();

  for(const msg of ctx.out){
    try{
      await send(env, m.channel, m.uid, msg);
      if(logIt) await logMsg(env, key, 'out', msgLogText(msg));
    }catch(e){
      console.error('gönderilemedi', m.channel, e.message);
      await setSetting(env, 'err:' + m.channel, {t: Date.now(), msg: e.message}).catch(() => {});
      if(logIt) await logMsg(env, key, 'sys', 'Bot cevabı gönderilemedi: ' + e.message);
      break;
    }
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
  const site = await siteInfo(ctx.env), cfg = mergeBotCfg(site.bot);
  say(ctx, fill(cfg.welcome, {ad: firstName(ctx.m.name), isletme: site.name || 'Yirmi'}), mainOptions(cfg), 'Seçenekler');
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
  say(ctx, (reason ? reason + '\n\n' : '') + fill((await botCfg(ctx.env)).handoff, {ad: firstName(ctx.m.name)}));
  const who = await contactLabel(ctx), d = (s && s.d) || {}, code = await relayCode(ctx.env, ctx.key);
  const lines = ['💬 *Yetkili isteniyor* — ' + channelName(ctx.m.channel) + ' · #' + code, '👤 ' + who];
  if(reason) lines.push('Sebep: ' + oneLine(reason));
  if(d.date) lines.push('Yarım kalan talep: ' + [dateLong(d.date), d.time, d.guests && d.guests + ' kişi', d.area && AREA[d.area]].filter(Boolean).join(' · '));
  if(ctx.m.text) lines.push('Son mesaj: “' + clean(ctx.m.text, 200) + '”');
  lines.push('', REPLY_HINT(code));
  ctx.after.push(() => notifyStaff(ctx.env, lines.join('\n'), who + ' yetkiliyle görüşmek istiyor (#' + code + ')', ctx.key));
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
    const cfg = await botCfg(ctx.env);
    return {text: cfg.q.occasion, button: 'Seçin',
      options: cfg.occasions.map((l, i) => ({id: 'o:' + i, title: l})).concat({id: 'o:diger', title: '✨ Diğer'})};
  },
  async date(ctx, s){
    const site = await siteInfo(ctx.env), today = trNow().date, options = [];
    for(let i = 0; options.length < 8 && i < 10; i++){
      const d = addDays(today, i);
      if(!slotsFor(d, site).length) continue;
      options.push({id: 'd:' + d, title: i === 0 ? 'Bugün' : i === 1 ? 'Yarın' : dateShort(d), desc: dateLong(d)});
    }
    options.push({id: 'd:other', title: '📝 Başka bir tarih', desc: 'Tarihi yazarak belirtin'});
    return {text: (await botCfg(ctx.env)).q.date, options, button: 'Tarih seç'};
  },
  async time(ctx, s){
    const all = slotsFor(s.d.date, await siteInfo(ctx.env));
    let step = SLOT, list = all;
    while(list.length > 10){ step += SLOT; list = all.filter(m => (m - all[0]) % step === 0); }
    return {text: fill((await botCfg(ctx.env)).q.time, {tarih: dateLong(s.d.date)}) + (list.length < all.length ? '\n(Listede olmayan bir saat için yazabilirsiniz, ör. *20:30*)' : ''),
      options: list.map(m => ({id: 't:' + m, title: hm(m)})), button: 'Saat seç'};
  },
  // Oturma yeri + sigara tercihi tek soru. Dış alan kapalıysa yalnızca iç alan kalır ve soru sorulmaz.
  async area(ctx, s){
    const cfg = await botCfg(ctx.env), o = await outdoorState(ctx.env), closed = outdoorClosedOn(o, s.d.date);
    const keys = AREA_KEYS.filter(k => cfg.areas[k].on && !(closed && k !== 'ic'));
    if(keys.length <= 1){
      applyArea(s.d, keys[0] || 'ic');
      if(closed) ctx.notes.push('🌧 ' + dateLong(s.d.date) + ' için dış alanımız ' + (o.note || 'hava koşulları nedeniyle') + ' kapalı; rezervasyonunuzu iç alanımıza alıyoruz.');
      return null;
    }
    return {text: cfg.q.area, button: 'Alan seç', options: keys.map(k => ({id: 'a:' + k, title: cfg.areas[k].title, desc: cfg.areas[k].desc || undefined}))};
  },
  async guests(ctx, s){
    if(s.d.guestsAsk) return {text: 'Kaç kişi olacaksınız? Lütfen rakamla yazın (ör. 12).'};
    const options = [];
    for(let n = 1; n <= 9; n++) options.push({id: 'g:' + n, title: n + ' kişi'});
    options.push({id: 'g:more', title: '10 kişi ve üzeri'});
    return {text: (await botCfg(ctx.env)).q.guests, options, button: 'Kişi sayısı'};
  },
  async request(ctx, s){
    const cfg = await botCfg(ctx.env);
    return {text: s.d.kind === 'ozel' ? cfg.q.requestOzel : cfg.q.request, options: [{id: 'r:skip', title: 'Geç'}, {id: 'r:menu', title: '📖 Menüyü gör'}]};
  },
  async name(ctx, s){
    const p = clean(s.d.profile, 40);
    return {text: (await botCfg(ctx.env)).q.name, options: p && p.length <= 20 ? [{id: 'n:p', title: p}] : undefined};
  },
  async phone(ctx, s){
    return {text: '📞 Size ulaşabilmemiz için telefon numaranızı yazar mısınız? (ör. 0532 123 45 67)'};
  },
  async confirm(ctx, s){
    return {text: summary(s.d) + '\n\n' + (await botCfg(ctx.env)).q.confirm + (s.d.nameAuto ? '\n_(İsim farklıysa doğru ismi yazmanız yeterli.)_' : ''),
      options: [{id: 'c:ok', title: '✅ Onayla'}, {id: 'c:edit', title: '✏️ Baştan al'}, {id: 'c:no', title: '❌ Vazgeç'}]};
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
// WhatsApp'ta isim profilden alınır (ayrı soru = ayrı ücretli mesaj); özet ekranında müşteri isterse düzeltir
function freshData(ctx, kind, cfg){
  const d = {kind, profile: ctx.m.name || ''};
  if(ctx.m.channel === 'wa') d.phone = localPhone(ctx.m.uid);
  if(looksLikeName(ctx.m.name)){ d.name = clean(ctx.m.name, 60); d.nameAuto = true; }
  if(!cfg.askRequest) d.request = '';
  return d;
}

const ANSWERS = {
  async menu(ctx, s){
    const cfg = await botCfg(ctx.env);
    const c = pick(ctx, 'm', [['ozel', /dogum|yil ?donum|ozel gun|kutlama|teklif|surpriz|mezun/], ['rez', /rezerv|rezarv|masa|yer ayir|yer ayirt/],
      ['bilgi', /menu|fiyat|adres|konum|saat|nerede|bilgi|yol tarifi|acik mi/], ['yetkili', /gorus/]].filter(([k]) => cfg.menu[k].on));
    if(c === 'rez' || (c === 'ozel' && !cfg.menu.ozel.on)){ s.d = freshData(ctx, 'rez', cfg); return ask(ctx, s); }
    if(c === 'ozel'){
      s.d = freshData(ctx, 'ozel', cfg);
      // "doğum günü için yer ayırtmak istiyorum" gibi yazdıysa kutlama türü yeniden sorulmaz
      const o = !ctx.m.choice && occMatch(cfg, ctx.t);
      if(o) s.d.occasion = plainLabel(o);
      return ask(ctx, s);
    }
    if(c === 'bilgi'){ say(ctx, await infoText(ctx.env)); say(ctx, 'Başka nasıl yardımcı olabiliriz?', mainOptions(cfg), 'Seçenekler'); return s; }
    if(c === 'yetkili') return handoff(ctx, s);
    say(ctx, 'Lütfen aşağıdaki seçeneklerden birini seçin 👇', mainOptions(cfg), 'Seçenekler');
    return s;
  },
  async occasion(ctx, s){
    if(s.d.occasionAsk && !ctx.m.choice && ctx.t.length >= 2){ s.d.occasion = clean(ctx.m.text, 80); return ask(ctx, s); }
    const cfg = await botCfg(ctx.env), c = ctx.m.choice;
    if(c === 'o:diger' || (!c && ctx.t === 'diger')){ s.d.occasionAsk = true; return ask(ctx, s); }
    const label = c ? (/^o:\d+$/.test(c) ? cfg.occasions[+c.slice(2)] : null) : occMatch(cfg, ctx.t);
    if(label){ s.d.occasion = plainLabel(label); return ask(ctx, s); }
    if(!c && ctx.t.length >= 3){ s.d.occasion = clean(ctx.m.text, 80); return ask(ctx, s); }
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
    let c = pick(ctx, 'a', [['any', /fark ?etmez|farketmez|hangisi olursa|ikisi de/], ['dis_s', /sigarali|sigara icilen|sigara icen|sigara icebil/],
      ['dis_n', /\b(dis|disari|disarda|disarisi|bahce|teras|acik hava)/], ['ic', /\b(ic|iceri|icerde|icerisi|salon|kapali alan)/]]);
    if(c === 'dis') c = 'dis_n';   // eski sürümün düğmesi
    const cfg = await botCfg(ctx.env), closed = outdoorClosedOn(await outdoorState(ctx.env), s.d.date);
    if(!c || !cfg.areas[c] || !cfg.areas[c].on) return reask(ctx, s, 'Lütfen bir seçenek seçin 👇');
    if(c !== 'ic' && closed) return ask(ctx, s);   // bu arada kapatıldıysa soru iç alana döner
    applyArea(s.d, c);
    return ask(ctx, s);
  },
  async guests(ctx, s){
    if(ctx.m.choice === 'g:more'){ s.d.guestsAsk = true; return ask(ctx, s); }
    const c = ctx.m.choice;
    const n = c ? (/^g:\d+$/.test(c) ? +c.slice(2) : null) : parseCount(ctx.t);
    if(!n || n < 1) return reask(ctx, s, 'Kişi sayısını rakamla yazar mısınız? (ör. 4)');
    const max = (await botCfg(ctx.env)).maxGuests;
    if(n > max){ s.d.guests = n; return handoff(ctx, s, n + ' kişilik gruplar için ekibimiz sizinle özel olarak ilgilenecek.'); }
    s.d.guests = n;
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
    const c = pick(ctx, 'c', [['no', /^(hayir|vazgec|iptal|istemiyorum)( |$)/], ['edit', /duzelt|degistir|bastan|yanlis/], ['ok', /^(evet|onay|onayla|onayliyorum|tamam|dogru|ok|okey|olur|e)( |$)/]]);
    if(c === 'ok'){ await createRequest(ctx, s.d, s.test); return {step: 'done', test: s.test}; }
    if(c === 'edit'){ s.d = freshData(ctx, s.d.kind, await botCfg(ctx.env)); ctx.notes.push('Tamam, baştan alalım 👍'); return ask(ctx, s); }
    if(c === 'no'){ say(ctx, 'Tamam, talebi iptal ettim. Yeniden başlamak için *menü* yazmanız yeterli.'); return {step: 'done', test: s.test}; }
    // Özet ekranında isim yazdıysa: profilden gelen ismi düzeltir
    if(!ctx.m.choice && looksLikeName(ctx.m.text)){ s.d.name = clean(ctx.m.text, 60); s.d.nameAuto = false; ctx.notes.push('👍 İsmi güncelledim.'); return ask(ctx, s); }
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
  do{ ref = randomCode(5); }
  while(await D.prepare('SELECT 1 FROM requests WHERE ref = ?').bind(ref).first());
  const rec = {ref, channel: ctx.m.channel === 'wa' ? 'whatsapp' : 'instagram', kind: d.kind, occasion: d.occasion || '',
    date: d.date, time: d.time, area: d.area, guests: d.guests, smoking: d.smoking, request: d.request || '',
    name: d.name, phone: d.phone, test: !!test, createdAt: new Date().toISOString()};
  if(ctx.m.channel === 'ig') rec.igUser = await igUsername(ctx.env, ctx.m.uid);
  await D.prepare('INSERT INTO requests (ref, channel, user_id, data, created) VALUES (?, ?, ?, ?, ?)')
    .bind(ref, ctx.m.channel, ctx.m.uid, JSON.stringify(rec), Date.now()).run();
  const cfg = await botCfg(ctx.env);
  say(ctx, fill(cfg.done, {kod: ref, ad: firstName(rec.name)}));
  if(!cfg.notifyNew) return;   // panel yeni talebi sesli uyarıyla gösterir; WhatsApp bildirimi isteğe bağlı
  const lines = ['🆕 *Yeni rezervasyon talebi*' + (rec.test ? ' (TEST)' : '') + ' — ' + channelName(rec.channel),
    'Kod: *' + ref + '*',
    '📅 ' + dateLong(rec.date) + ' · ' + rec.time,
    '👥 ' + rec.guests + ' kişi · ' + AREA[rec.area] + ' · ' + (rec.smoking === 'yes' ? '🚬 Sigaralı' : '🚭 Sigarasız')];
  if(rec.occasion) lines.push('🎉 Özel gün: ' + rec.occasion);
  if(rec.request) lines.push('🍽 İstek: ' + rec.request);
  const code = await relayCode(ctx.env, ctx.key);
  lines.push('👤 ' + rec.name + ' · ' + rec.phone + (rec.igUser ? ' · ' + rec.igUser : ''), '',
    '👉 Görmek ve onaylamak için: ' + siteUrl(ctx.env) + '/admin.html#talep=' + ref, REPLY_HINT(code));
  const short = rec.name + ', ' + dateLong(rec.date) + ' ' + rec.time + ', ' + rec.guests + ' kişi, ' + AREA[rec.area] + ' (kod ' + ref + ')';
  ctx.after.push(() => notifyStaff(ctx.env, lines.join('\n'), short, ctx.key));
}

/* ---------- Personel ---------- */
const STAFF_HELP = '👋 *Personel komutları*\n' +
  '• *dış kapat* – bugün dış alanı kapat (yağmur vb.)\n' +
  '• *dış kapat yarın* – bugün ve yarın kapalı\n' +
  '• *dış kapat süresiz* – siz açana kadar kapalı\n' +
  '• *dış aç* – dış alanı aç\n' +
  '• *durum* – bot durumu\n' +
  '• *izle aç* / *izle kapat* – müşterilerin bota yazdığı her mesajın kopyası size gelsin\n' +
  '• *test* – botu müşteri gibi deneyin\n\n' +
  '*Müşteriye yazmak:* bildirimi sola kaydırıp yanıtlayın ya da *#KOD mesajınız* yazın. Siz yazınca bot o müşteriye 12 saat karışmaz; *#KOD bitir* yazarsanız sohbet bota döner.\n\n' +
  'İpucu: Her gün bu numaraya bir kez yazmanız (ör. *durum*), o gün gelen bildirimlerin ayrıntılı ve ücretsiz gelmesini sağlar.';
const REPLY_HINT = code => '↩ Müşteriye yazmak için bu mesajı yanıtlayın ya da *#' + code + ' mesajınız* yazın.';
async function staffCommand(ctx){
  const t = ctx.t, env = ctx.env, today = trNow().date;
  const target = await relayTarget(ctx);
  if(target){ if(target.key) await relayToCustomer(ctx, target.key, target.text); return null; }
  if(/^izle (ac|acik)$/.test(t)){
    await setSetting(env, 'mirror', true);
    say(ctx, '👁 İzleme açıldı: müşterilerin bota yazdığı her mesajın kopyası personele gelecek. Araya girmek için o mesajı yanıtlayın. Kapatmak için *izle kapat*.');
    return null;
  }
  if(/^izle (kapat|kapa|kapali)$/.test(t)){
    await setSetting(env, 'mirror', false);
    say(ctx, 'İzleme kapandı. Yeni rezervasyon ve yetkili bildirimleri gelmeye devam eder.');
    return null;
  }
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
    const bn = await ensureBotNumber(env);
    say(ctx, '📊 *Bot durumu*\n' +
      (bn ? '• Bot numarası: ' + (bn.live ? 'aktif ✅ https://wa.me/' + String(bn.number).replace(/\D/g, '') :
        'henüz açılmadı' + (bn.nameStatus ? ' (ad incelemesi: ' + bn.nameStatus + ')' : '') + (bn.error ? ' — ' + bn.error : '')) + '\n' : '') +
      '• Dış alan: ' + (outdoorClosedOn(o, today) ? 'kapalı (' + (o.closedUntil === 'always' ? 'siz açana kadar' : dateLong(o.closedUntil) + ' dahil') + ')' : 'açık') + '\n' +
      '• Son 24 saatte gelen talep: ' + day.n + '\n' +
      '• Bu ay gönderilen WhatsApp mesajı: ' + (await monthCount(env)) + ' (her numara için ayda ilk 1.000 ücretsiz)\n' +
      '• Panele henüz aktarılmamış talep: ' + waiting.n + (waiting.n ? ' (yönetim panelini açınca aktarılır)' : ''));
    return null;
  }
  say(ctx, STAFF_HELP);
  return null;
}
// Personel numaralarına bildirim. Personel son 24 saatte bu numaraya yazdıysa düz metin (ücretsiz),
// yazmadıysa onaylı şablon (STAFF_TEMPLATE) kullanılır; WhatsApp pencere dışında düz metni teslim etmez.
// custKey verilirse personelin bu bildirime verdiği yanıt o müşteriye iletilir.
async function notifyStaff(env, text, short, custKey, exceptNum){
  const D = await db(env);
  const res = await Promise.allSettled(staffNumbers(env).filter(n => n !== exceptNum).map(async num => {
    const c = await D.prepare('SELECT last_in FROM contacts WHERE k = ?').bind('wa:' + num).first();
    const j = env.STAFF_TEMPLATE && !(c && Date.now() - c.last_in < WINDOW_MS)
      ? await waTemplate(env, num, env.STAFF_TEMPLATE, [short])
      : await waSend(env, num, {text});
    const mid = j && j.messages && j.messages[0] && j.messages[0].id;
    if(custKey && mid) await D.prepare('INSERT OR REPLACE INTO relay_msgs (mid, k, t) VALUES (?, ?, ?)').bind(mid, custKey, Date.now()).run();
  }));
  res.forEach(r => { if(r.status === 'rejected') console.error('personel bildirimi', r.reason && r.reason.message); });
}

/* ---------- Personel ↔ müşteri aktarımı ---------- */
// Her müşteriye 4 harflik sabit bir kod verilir (#K7MP); personel bu kodla ya da bildirimi yanıtlayarak müşteriye yazar
async function relayCode(env, key){
  const D = await db(env), now = Date.now();
  const r = await D.prepare('SELECT code FROM relay WHERE k = ?').bind(key).first();
  if(r){ await D.prepare('UPDATE relay SET updated = ? WHERE code = ?').bind(now, r.code).run(); return r.code; }
  let code;
  do{ code = randomCode(4); } while(await D.prepare('SELECT 1 FROM relay WHERE code = ?').bind(code).first());
  await D.prepare('INSERT INTO relay (code, k, updated) VALUES (?, ?, ?)').bind(code, key, now).run();
  return code;
}
// Personel mesajı bir müşteriye mi? Yanıtlanan bildirimden ya da başındaki #KOD'dan bulunur.
async function relayTarget(ctx){
  const D = await db(ctx.env);
  if(ctx.m.replyTo){
    const r = await D.prepare('SELECT k FROM relay_msgs WHERE mid = ?').bind(ctx.m.replyTo).first();
    if(r) return {key: r.k, text: ctx.m.text};
  }
  const m = /^#([a-z0-9]{4})\b\s*([\s\S]*)$/i.exec(String(ctx.m.text || '').trim());
  if(!m) return null;
  const r = await D.prepare('SELECT k FROM relay WHERE code = ?').bind(m[1].toUpperCase()).first();
  if(r) return {key: r.k, text: m[2].trim()};
  say(ctx, '#' + m[1].toUpperCase() + ' koduyla bir müşteri bulunamadı (kodlar 30 gün sonra silinir).');
  return {};
}
async function relayToCustomer(ctx, key, text){
  const env = ctx.env, D = await db(env), i = key.indexOf(':');
  const channel = key.slice(0, i), uid = key.slice(i + 1), code = await relayCode(env, key);
  if(ctx.m.media || !clean(text, 1)){ say(ctx, 'Şimdilik müşteriye yalnızca yazılı mesaj iletebiliyorum.'); return; }
  if(/^(bitir|bota devret|bota ver|bot|kapat)$/.test(norm(text))){
    await D.prepare('DELETE FROM sessions WHERE k = ?').bind(key).run();
    say(ctx, '🤖 #' + code + ' sohbeti tekrar bota devredildi.');
    return;
  }
  const c = await D.prepare('SELECT last_in, name FROM contacts WHERE k = ?').bind(key).first();
  if(!(c && Date.now() - c.last_in < WINDOW_MS)){
    say(ctx, '⚠️ #' + code + ' müşteri 24 saatten uzun süredir yazmadığı için ' + channelName(channel) + ' mesaj göndermeye izin vermiyor. Müşteriyi telefonla arayabilirsiniz.');
    return;
  }
  try{ await send(env, channel, uid, {text}); }
  catch(e){ say(ctx, '⚠️ Mesaj iletilemedi: ' + e.message); return; }
  await takeOver(env, key);
  await logMsg(env, key, 'staff', text, firstName(ctx.m.name) || 'Personel');
  if(ctx.m.id) await waReact(env, ctx.m.uid, ctx.m.id, '✅').catch(() => {});
  // Diğer personel de konuşmayı görsün
  const who = (c && c.name) || (channel === 'wa' ? localPhone(uid) : 'Instagram müşterisi');
  const by = firstName(ctx.m.name) || localPhone(ctx.m.uid);
  ctx.after.push(() => notifyStaff(env, '↪ #' + code + ' ' + by + ' → ' + who + ':\n' + text, by + ' müşteriye yazdı (#' + code + ')', key, ctx.m.uid));
}
// Müşterinin mesajının bir kopyasını personele gönderir (yetkili modu ya da "izle aç")
async function forwardToStaff(ctx, icon){
  const code = await relayCode(ctx.env, ctx.key), who = await contactLabel(ctx);
  const body = ctx.m.media ? '[' + (MEDIA_LABEL[ctx.m.mediaType] || 'dosya') + ' gönderdi — telefondan görüntülenemiyor]' : (ctx.m.text || '');
  await notifyStaff(ctx.env, icon + ' #' + code + ' ' + who + ':\n' + body, who + ': ' + oneLine(body), ctx.key);
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
const waUrl = async (env, to) => 'https://graph.facebook.com/' + graphVer(env) + '/' + (await waPid(env, to)) + '/messages';
async function waSend(env, to, msg){
  const opts = msg.options || [], text = cut(msg.text, opts.length ? 1024 : 4096);
  let payload;
  if(!opts.length) payload = {type: 'text', text: {body: text, preview_url: /https?:\/\//.test(text)}};
  else if(opts.length <= 3 && opts.every(o => o.title.length <= 20 && !o.desc))
    payload = {type: 'interactive', interactive: {type: 'button', body: {text},
      action: {buttons: opts.map(o => ({type: 'reply', reply: {id: o.id, title: o.title}}))}}};
  else payload = {type: 'interactive', interactive: {type: 'list', body: {text},
    action: {button: cut(msg.button || 'Seçenekler', 20), sections: [{title: 'Seçenekler',
      rows: opts.slice(0, 10).map(o => Object.assign({id: o.id, title: cut(o.title, 24)}, o.desc ? {description: cut(o.desc, 72)} : {}))}]}}};
  return waPost(env, to, Object.assign({messaging_product: 'whatsapp', recipient_type: 'individual', to}, payload));
}
// Her başarılı gönderim aylık sayaca eklenir (personel "durum" yazınca görür)
async function waPost(env, to, body){
  const j = await graph(await waUrl(env, to), env.WA_TOKEN, body);
  await countMsg(env);
  return j;
}
async function waReact(env, to, messageId, emoji){
  return waPost(env, to, {messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'reaction', reaction: {message_id: messageId, emoji}});
}
async function waTemplate(env, to, name, params){
  return waPost(env, to, {
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
        staff: staffNumbers(env).length, outdoor: await outdoorState(env), botNumber: await ensureBotNumber(env), msgs: await monthCount(env)});
    case '/api/inbox': {
      const r = await D.prepare('SELECT data FROM requests WHERE imported = 0 ORDER BY created LIMIT 50').all();
      return json({requests: r.results.map(x => JSON.parse(x.data)), outdoor: await outdoorState(env), msgs: await monthCount(env), waiting: await waitingChats(env)});
    }
    case '/api/status':
      return json(await botStatus(env));
    case '/api/chats': {
      const since = +url.searchParams.get('since') || 0;
      const r = await D.prepare(CHAT_SELECT + ' WHERE ch.last_t > ?1 ORDER BY ch.last_t DESC LIMIT 80').bind(since).all();
      return json({now: Date.now(), chats: r.results.map(chatRow), waiting: await waitingChats(env)});
    }
    case '/api/chat': {
      const k = url.searchParams.get('k') || '', after = +url.searchParams.get('after') || 0;
      if(!/^(wa|ig):/.test(k)) return json({error: 'Geçersiz sohbet'}, 400);
      if(url.searchParams.get('read')) await D.prepare('UPDATE chats SET unread = 0 WHERE k = ?').bind(k).run();
      const m = await D.prepare('SELECT id, dir, text, by, t FROM messages WHERE k = ?1 AND id > ?2 ORDER BY id DESC LIMIT 300').bind(k, after).all();
      const row = await D.prepare(CHAT_SELECT + ' WHERE ch.k = ?').bind(k).first();
      return json({messages: m.results.reverse(), chat: row ? chatRow(row) : null});
    }
    case '/api/chat/send':
      if(!post) break;
      return panelSend(env, body);
    case '/api/chat/mode': {
      if(!post) break;
      const k = String(body.k || ''), by = clean(body.by, 40) || 'Panel';
      if(!/^(wa|ig):/.test(k)) return json({error: 'Geçersiz sohbet'}, 400);
      if(body.mode === 'bot'){
        await D.prepare('DELETE FROM sessions WHERE k = ?').bind(k).run();
        await logMsg(env, k, 'sys', '🤖 Sohbet bota devredildi', by);
      }else{
        await takeOver(env, k);
        await logMsg(env, k, 'sys', '🙋 Personel devraldı — bot 12 saat bu müşteriye cevap vermeyecek', by);
      }
      return json({ok: true});
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
/* ---------- Panel: sohbetler ve durum ---------- */
const CHAT_SELECT = 'SELECT ch.k, ch.last_t, ch.last_text, ch.last_dir, ch.unread, c.name, c.last_in, s.data AS sess, s.updated AS sess_t, r.code ' +
  'FROM chats ch LEFT JOIN contacts c ON c.k = ch.k LEFT JOIN sessions s ON s.k = ch.k LEFT JOIN relay r ON r.k = ch.k';
function chatRow(r){
  const i = r.k.indexOf(':'), channel = r.k.slice(0, i), uid = r.k.slice(i + 1), now = Date.now();
  let state = 'bot', step = '';
  try{
    const s = r.sess ? JSON.parse(r.sess) : null;
    if(s && s.human && s.human > now) state = 'human';
    else if(s && s.step === 'done') state = 'done';
    else if(s && s.step && now - r.sess_t < SESSION_MS) step = s.step;
  }catch(e){}
  return {k: r.k, channel, name: r.name || '', phone: channel === 'wa' ? localPhone(uid) : '', last: r.last_text || '', lastDir: r.last_dir || '',
    lastT: r.last_t, unread: r.unread || 0, state, step, code: r.code || '', windowOpen: !!(r.last_in && now - r.last_in < WINDOW_MS)};
}
// Personelin cevap vermesi beklenen (devralınmış ve okunmamış mesajı olan) sohbet sayısı
async function waitingChats(env){
  const r = await (await db(env)).prepare("SELECT s.data FROM chats ch JOIN sessions s ON s.k = ch.k WHERE ch.unread > 0 AND s.data LIKE '%\"human\":%'").all();
  const now = Date.now();
  return r.results.filter(x => { try{ return JSON.parse(x.data).human > now; }catch(e){ return false; } }).length;
}
// Panelden müşteriye mesaj: bot o müşteriye 12 saat karışmaz
async function panelSend(env, b){
  const k = String(b.k || ''), text = String(b.text || '').trim().slice(0, 4000), by = clean(b.by, 40) || 'Panel';
  if(!/^(wa|ig):/.test(k) || !text) return json({error: 'Mesaj boş.'}, 400);
  const D = await db(env), i = k.indexOf(':'), channel = k.slice(0, i), uid = k.slice(i + 1);
  const c = await D.prepare('SELECT last_in FROM contacts WHERE k = ?').bind(k).first();
  if(!(c && Date.now() - c.last_in < WINDOW_MS))
    return json({error: 'Müşteri 24 saatten uzun süredir yazmadığı için ' + channelName(channel) + ' mesaj göndermeye izin vermiyor. Müşteriyi telefonla arayabilirsiniz.'}, 409);
  try{ await send(env, channel, uid, {text}); }
  catch(e){ return json({error: 'Gönderilemedi: ' + e.message}, 502); }
  await takeOver(env, k);
  await logMsg(env, k, 'staff', text, by);
  return json({ok: true});
}
async function botStatus(env){
  // Önce asıl numara kontrol edilir: o anda devreye girdiyse kart doğrudan yeni numarayı gösterir
  const bn = await ensureBotNumber(env).catch(() => null);
  const D = await db(env), base = 'https://graph.facebook.com/' + graphVer(env) + '/', pid = await primaryPid(env);
  const lastIn = async p => (await D.prepare("SELECT MAX(t) AS t FROM messages WHERE dir = 'in' AND k >= ? AND k < ?").bind(p + ':', p + ';').first()).t || null;
  let lastErr = await getSetting(env, 'err:wa');
  if(lastErr && bn && bn.live && lastErr.t < bn.at) lastErr = null;   // asıl numaraya geçmeden önceki (test numarası) hatası
  const wa = {configured: !!(env.WA_TOKEN && pid), botNumber: bn, lastErr, lastIn: await lastIn('wa')};
  if(wa.configured){
    try{
      const p = await getJSON(base + pid + '?fields=display_phone_number,verified_name,quality_rating,status,name_status', env.WA_TOKEN);
      wa.phone = {number: p.display_phone_number, name: p.verified_name, quality: p.quality_rating, status: p.status, nameStatus: p.name_status};
    }catch(e){ wa.error = e.message; }
  }
  const tok = await igToken(env);
  const ig = {configured: !!tok, lastErr: await getSetting(env, 'err:ig'), lastIn: await lastIn('ig')};
  if(tok){
    try{ ig.username = (await getJSON('https://graph.instagram.com/' + graphVer(env) + '/me?fields=username', tok)).username || ''; }
    catch(e){ ig.error = e.message; }
  }
  const today = await D.prepare('SELECT COUNT(*) AS n FROM chats WHERE last_t > ?').bind(Date.now() - 864e5).first();
  return {whatsapp: wa, instagram: ig, today: today.n, waiting: await waitingChats(env), msgs: await monthCount(env),
    staff: staffNumbers(env).length, mirror: !!(await getSetting(env, 'mirror')), outdoor: await outdoorState(env)};
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
  const ck = row.channel + ':' + row.user_id;
  try{
    if(open){ await send(env, row.channel, row.user_id, {text}); await logMsg(env, ck, 'out', text); }
    else if(row.channel === 'wa' && b.status === 'confirmed' && env.CONFIRM_TEMPLATE){
      await waTemplate(env, row.user_id, env.CONFIRM_TEMPLATE, [first || 'Misafirimiz', when, String(guests)]);
      await logMsg(env, ck, 'out', '[Onay şablonu] ' + when + ' · ' + guests + ' kişi');
    }
    else return json({error: 'Müşteri 24 saatten uzun süredir yazmadığı için ' + channelName(row.channel) + ' otomatik mesaja izin vermiyor. Lütfen telefonla bilgi verin.'}, 409);
  }catch(e){
    return json({error: 'Mesaj gönderilemedi: ' + e.message}, 502);
  }
  await D.prepare('UPDATE requests SET notified = ? WHERE ref = ?').bind(b.status, row.ref).run();
  return json({ok: true, channel: row.channel});
}

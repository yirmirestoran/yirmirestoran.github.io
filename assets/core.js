/* Yirmi QR Menü – ortak çekirdek.
   Menü sayfası (index.html) ve yönetim paneli (admin.html) birlikte kullanır:
   ürün kimlikleri, varsayılan fotoğraflar, kampanya / happy hour zamanlaması ve indirimli fiyat hesabı. */
(function(global){
  'use strict';

  const TZ = 'Europe/Istanbul';
  const DAY_MS = 86400000;

  const ALLERGENS = [
    {key:'gluten', label:'Gluten içeren tahıllar'}, {key:'crustaceans', label:'Kabuklular'},
    {key:'egg', label:'Yumurta'}, {key:'fish', label:'Balık'}, {key:'peanut', label:'Yerfıstığı'},
    {key:'soy', label:'Soya'}, {key:'milk', label:'Süt (laktoz dahil)'}, {key:'nuts', label:'Sert kabuklu meyveler'},
    {key:'celery', label:'Kereviz'}, {key:'mustard', label:'Hardal'}, {key:'sesame', label:'Susam'},
    {key:'sulfites', label:'Kükürt dioksit ve sülfitler'}, {key:'lupin', label:'Acı bakla'}, {key:'molluscs', label:'Yumuşakçalar'}
  ];
  const ALLERGEN_LABELS = Object.fromEntries(ALLERGENS.map(a => [a.key, a.label]));
  const DAYS = [{d:1,s:'Pzt'},{d:2,s:'Sal'},{d:3,s:'Çar'},{d:4,s:'Per'},{d:5,s:'Cum'},{d:6,s:'Cmt'},{d:0,s:'Paz'}];

  function slugify(s){
    const map = {'ç':'c','ğ':'g','ı':'i','ö':'o','ş':'s','ü':'u','Ç':'c','Ğ':'g','İ':'i','I':'i','Ö':'o','Ş':'s','Ü':'u'};
    return String(s || '').replace(/[çğıöşüÇĞİIÖŞÜ]/g, c => map[c]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* ---------- Fotoğraflar ---------- */
  // Kendi fotoğraflarınız yüklenene kadar kullanılan örnek görseller (Unsplash). Ürün adına göre eşleşir.
  const unsplash = (id, w) => 'https://images.unsplash.com/photo-' + id + '?auto=format&fit=crop&w=' + (w || 800) + '&q=70';
  const ITEM_PHOTOS = {
    'dana-bonfile':'1546964124-0cce460f38ef', 'levrek':'1611599537845-1c7aca0091c0', 'karides-tava':'1559847844-5315695dadae',
    'portakalli-karides':'1559847844-5315695dadae', 'yaprak-bonfile':'1588168333986-5078d3ae3976', 'limonlu-sac-kavurma':'1588168333986-5078d3ae3976',
    'kuzu-pirzola':'1529692236671-f1f6cf9683ba', 'avokado-salata':'1512621776951-a57141f2eefd', 'yesil-salata':'1540189549336-e6e99c3679fe',
    'domates-salatasi':'1518779578993-ec3579fee39f', 'mevsim-meyveleri':'1565958011703-44f9829ba187'
  };
  const COVER_PHOTOS = {
    'sefin-seckisi':'1414235077428-338989a2e8c0', 'mezeler':'1625944525533-473f1a3d54e7', 'salatalar':'1512621776951-a57141f2eefd',
    'ara-sicaklar':'1559847844-5315695dadae', 'ana-yemekler':'1588168333986-5078d3ae3976', 'tatlilar':'1624353365286-3f8d62daad51',
    'saraplar':'1474722883778-792e7990302f'
  };
  const HERO_PHOTOS = ['1414235077428-338989a2e8c0', '1588168333986-5078d3ae3976', '1517248135467-4c7edcad34c4', '1572715376701-98568319fd0b'];
  // Şef bölümü için örnek görseller (panelden kendi fotoğraflarınızı yükleyene kadar)
  const CHEF_PHOTO = '1583394293214-28ded15ee548';
  const CHEF_KITCHEN = '1572715376701-98568319fd0b';

  // Kendi yüklenen fotoğraf varsa onu, yoksa örnek fotoğrafı döner. Unsplash görsellerinde genişlik ayarlanabilir.
  function sized(url, w){
    if(!url) return '';
    return /images\.unsplash\.com/.test(url) ? url.replace(/([?&])w=\d+/, '$1w=' + w) : url;
  }
  function itemPhoto(item, w){
    if(item.image) return sized(item.image, w || 800);
    const id = ITEM_PHOTOS[slugify(item.name)];
    return id ? unsplash(id, w) : '';
  }
  function isDefaultPhoto(item){ return !item.image && !!ITEM_PHOTOS[slugify(item.name)]; }
  function coverPhoto(cat, w){
    if(cat.cover) return sized(cat.cover, w || 1400);
    const id = COVER_PHOTOS[cat.id];
    if(id) return unsplash(id, w || 1400);
    const c = (cat.collage || []).find(Boolean);
    return c ? sized(c, w || 1400) : '';
  }
  function heroPhotos(site, w){
    const list = (site.heroImages || []).filter(Boolean);
    return list.length ? list.map(u => sized(u, w || 1800)) : HERO_PHOTOS.map(id => unsplash(id, w || 1800));
  }

  /* ---------- Şef ---------- */
  // site.chef: {show, name, title, quote, story, photo, kitchenPhoto, timeline[{year, text}], signatureImage, signatureText}
  function chefInfo(site){
    const c = site.chef || {};
    const story = String(c.story || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    return {
      show: c.show !== false && !!(c.name || story.length),
      name: c.name || '', title: c.title || '', quote: c.quote || '', story,
      photo: c.photo ? sized(c.photo, 1100) : unsplash(CHEF_PHOTO, 1100),
      kitchenPhoto: c.kitchenPhoto ? sized(c.kitchenPhoto, 1100) : unsplash(CHEF_KITCHEN, 1100),
      timeline: (c.timeline || []).filter(t => t && (t.year || t.text)),
      signatureImage: c.signatureImage || '',
      signatureText: c.signatureText || c.name || ''
    };
  }
  function isDefaultChefPhoto(site){ return !(site.chef && site.chef.photo); }
  // Kategori görünümü: "cards" (fotoğraflı) veya "list" (şık liste). auto: ürünlerin yarısından fazlasının fotoğrafı varsa kart.
  function layoutFor(cat){
    if(cat.layout === 'cards' || cat.layout === 'list') return cat.layout;
    const items = (cat.items || []).filter(i => !i.hidden);
    if(!items.length) return 'list';
    return items.filter(i => itemPhoto(i)).length * 2 > items.length ? 'cards' : 'list';
  }

  /* ---------- Veri hazırlama ---------- */
  // Her ürüne kalıcı bir kimlik verir (kampanyalar ve ileride sipariş sistemi bu kimliği kullanır).
  function prepare(data){
    data.site = data.site || {};
    data.categories = data.categories || [];
    data.campaigns = data.campaigns || [];
    data.events = data.events || [];
    data.announcements = data.announcements || [];
    const used = new Set();
    data.categories.forEach(cat => (cat.items || []).forEach(it => { if(it.id) used.add(it.id); }));
    data.categories.forEach(cat => {
      cat.items = cat.items || [];
      cat.items.forEach(it => {
        if(it.id) return;
        const base = cat.id + '--' + (slugify(it.name) || 'urun');
        let id = base, n = 2;
        while(used.has(id)) id = base + '-' + (n++);
        used.add(id);
        it.id = id;
      });
    });
    return data;
  }
  function findItem(data, id){
    for(const cat of data.categories) for(const it of cat.items) if(it.id === id) return {item: it, cat};
    return null;
  }

  /* ---------- Zaman (her zaman Türkiye saati) ---------- */
  // "Duvar saati" ms: Türkiye'deki tarih/saat, sanki UTC imiş gibi sayıya çevrilir. Karşılaştırmalar bununla yapılır.
  let nowOffset = 0;
  function setNowOverride(str){
    const w = parseWall(str);
    if(w != null) nowOffset = w - realWall();
  }
  function realWall(){
    try{
      const p = {};
      new Intl.DateTimeFormat('en-GB', {timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'})
        .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    }catch(e){
      const d = new Date();
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    }
  }
  function now(){
    const wall = realWall() + nowOffset;
    const d = new Date(wall);
    return {wall, dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dayStart: wall - (wall % DAY_MS)};
  }
  function parseWall(s){
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }
  function parseHM(s){
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? (+m[1] % 24) * 60 + +m[2] : null;
  }
  function hm(min){ return String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

  /* ---------- Kampanyalar ---------- */
  // Kampanya: {id, enabled, title, badge, text, from, to, days[], start, end,
  //            discount:{type:'percent'|'amount'|'none', value, round}, all, categories[], items[{id, price}],
  //            popup:{enabled, image, button}}
  function campaignState(c, n){
    n = n || now();
    const res = {active:false, endsAt:null, startsAt:null, expired:false, upcoming:false};
    if(!c || !c.enabled) return res;
    const from = parseWall(c.from), to = parseWall(c.to);
    if(to != null && n.wall >= to){ res.expired = true; return res; }
    const days = Array.isArray(c.days) ? c.days : [];
    const dayOk = dow => !days.length || days.includes(dow);
    const s = parseHM(c.start), e = parseHM(c.end);
    let winStart = null, winEnd = null;

    if(s == null || e == null){
      if(dayOk(n.dow)){ winStart = n.dayStart; winEnd = days.length ? n.dayStart + DAY_MS : null; }
    }else if(s < e){
      if(dayOk(n.dow) && n.min >= s && n.min < e){ winStart = n.dayStart + s * 60000; winEnd = n.dayStart + e * 60000; }
      else if(dayOk(n.dow) && n.min < s) res.startsAt = n.dayStart + s * 60000;
    }else{ // gece yarısını geçen saat aralığı (ör. 22:00–02:00)
      const prevDow = (n.dow + 6) % 7;
      if(dayOk(n.dow) && n.min >= s){ winStart = n.dayStart + s * 60000; winEnd = n.dayStart + DAY_MS + e * 60000; }
      else if(dayOk(prevDow) && n.min < e){ winStart = n.dayStart - DAY_MS + s * 60000; winEnd = n.dayStart + e * 60000; }
      else if(dayOk(n.dow) && n.min < s) res.startsAt = n.dayStart + s * 60000;
    }

    if(from != null && n.wall < from){
      res.upcoming = true;
      if(res.startsAt == null || res.startsAt < from) res.startsAt = (from - n.wall < DAY_MS) ? from : null;
      return res;
    }
    if(winStart != null){
      res.active = true;
      const ends = [winEnd, to].filter(x => x != null);
      res.endsAt = ends.length ? Math.min.apply(null, ends) : null;
      res.startsAt = null;
    }
    if(res.startsAt != null && to != null && res.startsAt >= to) res.startsAt = null;
    return res;
  }
  function describeSchedule(c){
    const parts = [];
    const days = Array.isArray(c.days) ? c.days : [];
    if(days.length && days.length < 7) parts.push(DAYS.filter(x => days.includes(x.d)).map(x => x.s).join(', '));
    else parts.push('Her gün');
    if(parseHM(c.start) != null && parseHM(c.end) != null) parts.push(c.start + '–' + c.end);
    const f = parseWall(c.from), t = parseWall(c.to);
    const fmt = w => new Date(w).toLocaleDateString('tr-TR', {day:'numeric', month:'long', timeZone:'UTC'});
    if(f != null && t != null) parts.push(fmt(f) + ' – ' + fmt(t));
    else if(t != null) parts.push(fmt(t) + ' tarihine kadar');
    else if(f != null) parts.push(fmt(f) + ' tarihinden itibaren');
    return parts.join(' · ');
  }
  function campaignTargets(c, item, cat){
    if(c.all) return {hit:true};
    const own = (c.items || []).find(x => x.id === item.id);
    if(own) return {hit:true, price: (own.price || '').trim()};
    if((c.categories || []).includes(cat.id)) return {hit:true};
    return {hit:false};
  }
  // Fiyat metnindeki sayıları indirimle değiştirir. "50cl / 175 TL" gibi metinlerde cl/gr gibi miktarlara dokunmaz.
  function applyDiscount(price, d){
    if(!d || !d.type || d.type === 'none' || !(+d.value > 0)) return null;
    const round = +d.round > 0 ? +d.round : 5;
    let changed = false;
    const out = String(price).replace(/\d+(?:[.,]\d+)?(?![\d.,])(?!\s*(?:cl|ml|gr|g|kg|lt|l|cm|adet)\b)/gi, m => {
      const n = parseFloat(m.replace(',', '.'));
      if(!(n > 0)) return m;
      let v = d.type === 'percent' ? n * (1 - (+d.value) / 100) : n - (+d.value);
      v = Math.max(0, Math.round(v / round) * round);
      changed = true;
      return String(v);
    });
    return changed && out !== String(price) ? out : null;
  }
  function discountLabel(c){
    const d = c.discount || {};
    if(c.badge) return c.badge;
    if(d.type === 'percent' && +d.value > 0) return '%' + (+d.value) + ' İNDİRİM';
    if(d.type === 'amount' && +d.value > 0) return (+d.value) + ' TL İNDİRİM';
    return c.title || 'KAMPANYA';
  }
  // Menüde gösterilecek fiyat bilgisi (fiyat gizleme ayarları ve aktif kampanyalar dahil)
  function priceInfo(data, cat, item, n){
    const show = data.site.showPrices !== false && !cat.hidePrices && !item.hidePrice && !!item.price;
    const res = {show, price: item.price || '', newPrice: null, campaign: null, state: null};
    if(!show) return res;
    n = n || now();
    for(const c of data.campaigns || []){
      const st = campaignState(c, n);
      if(!st.active) continue;
      const t = campaignTargets(c, item, cat);
      if(!t.hit) continue;
      const np = t.price || applyDiscount(item.price, c.discount);
      if(np && np !== item.price){ res.newPrice = np; res.campaign = c; res.state = st; break; }
    }
    return res;
  }
  function formatCountdown(ms){
    if(ms == null) return '';
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if(d > 0) return d + ' gün ' + h + ' sa';
    if(h > 0) return h + ' sa ' + String(m).padStart(2, '0') + ' dk';
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  function newCampaign(){
    return {id: 'k' + Date.now().toString(36), enabled: false, title: 'Öğle Menüsü', badge: 'ÖĞLE MENÜSÜ',
      text: 'Hafta içi öğle saatlerinde seçili tabaklarda özel fiyatlar.', from: '', to: '', days: [], start: '12:00', end: '15:00',
      discount: {type:'percent', value: 20, round: 5}, all: false, categories: [], items: [],
      popup: {enabled: true, image: '', button: 'Seçili Tabakları Gör'}};
  }

  // Takvim için: kampanya o gün (herhangi bir saatte) geçerli mi?
  function campaignOnDay(c, dayStart){
    if(!c || !c.enabled) return null;
    const from = parseWall(c.from), to = parseWall(c.to);
    if(from != null && from >= dayStart + DAY_MS) return null;
    if(to != null && to <= dayStart) return null;
    const days = Array.isArray(c.days) ? c.days : [];
    if(days.length && !days.includes(new Date(dayStart).getUTCDay())) return null;
    const s = parseHM(c.start), e = parseHM(c.end);
    return {time: s != null && e != null ? c.start + '–' + c.end : 'Tüm gün'};
  }

  /* ---------- Etkinlikler / duyurular ---------- */
  // Etkinlik: {id, type, title, text, date:'YYYY-MM-DD', start, end, repeat:'none'|'weekly', until, image, popup, published}
  const EVENT_TYPES = [
    {key:'chef', label:'Şefin Masası', icon:'✦'}, {key:'tasting', label:'Tadım Menüsü', icon:'❖'},
    {key:'wine', label:'Şarap Tadımı', icon:'◈'}, {key:'music', label:'Canlı Müzik', icon:'♪'},
    {key:'special', label:'Özel Gün', icon:'★'}, {key:'announce', label:'Duyuru', icon:'!'},
    {key:'closed', label:'Kapalıyız / Özel saat', icon:'—'}
  ];
  const EVENT_TYPE = Object.fromEntries(EVENT_TYPES.map(t => [t.key, t]));
  function eventType(ev){ return EVENT_TYPE[ev.type] || EVENT_TYPE.announce; }
  // Etkinliğin [fromDay, toDay] aralığındaki günleri (gün başlangıcı, duvar saati ms)
  function eventDays(ev, fromDay, toDay){
    const base = parseWall(ev.date);
    if(base == null) return [];
    if(ev.repeat !== 'weekly') return base >= fromDay && base <= toDay ? [base] : [];
    const until = parseWall(ev.until);
    const W = 7 * DAY_MS, out = [];
    let d = base;
    if(fromDay > base) d = base + Math.ceil((fromDay - base) / W) * W;
    for(; d <= toDay && (until == null || d <= until); d += W) out.push(d);
    return out;
  }
  function eventWindow(ev, day){
    const s = parseHM(ev.start), e = parseHM(ev.end);
    const start = day + (s != null ? s * 60000 : 0);
    let end = day + DAY_MS;
    if(e != null) end = day + e * 60000 + (s != null && e <= s ? DAY_MS : 0);
    else if(s != null) end = Math.max(day + DAY_MS, start + 4 * 3600000);   // bitiş yoksa gece boyunca
    return {start, end};
  }
  // Menüde gösterilecek yaklaşan etkinlikler (bitmemiş olanlar), tarih sırasıyla
  function upcomingEvents(data, n, days){
    n = n || now();
    const out = [];
    (data.events || []).forEach(ev => {
      if(ev.published === false) return;
      eventDays(ev, n.dayStart - DAY_MS, n.dayStart + (days || 14) * DAY_MS).forEach(day => {
        const w = eventWindow(ev, day);
        if(w.end <= n.wall) return;
        out.push({ev, day, start: w.start, end: w.end, live: w.start <= n.wall, today: day === n.dayStart || w.start <= n.wall});
      });
    });
    return out.sort((a, b) => a.start - b.start);
  }
  function newEvent(date){
    return {id: 'e' + Date.now().toString(36), type: 'chef', title: 'Şefin Masası', text: '', date: date || '',
      start: '20:00', end: '', repeat: 'none', until: '', image: '', popup: false, published: true};
  }

  /* ---------- Duyurular (afişler) ---------- */
  // Duyuru: {id, title, text, image, link, button, from, to, published, popup}
  function announcementState(a, n){
    n = n || now();
    if(a.published === false) return 'off';
    const f = parseWall(a.from), t = parseWall(a.to);
    if(t != null && n.wall >= t) return 'expired';
    if(f != null && n.wall < f) return 'scheduled';
    return 'live';
  }
  function newAnnouncement(){
    return {id: 'd' + Date.now().toString(36), title: 'Yeni duyuru', text: '', image: '', link: '', button: '',
      from: '', to: '', published: true, popup: true};
  }
  // Duyuru ve etkinliklerin isteğe bağlı detayları: ücret, tarih/saat metni, rezervasyon telefonu, WhatsApp, konum, yol tarifi
  function posterInfo(o, site){
    const phone = String(o.phone || '').trim(), own = String(o.place || '').trim();
    const place = own || (site && site.address) || '';
    return {price: String(o.price || '').trim(), when: String(o.when || '').trim(), phone, whatsapp: !!(o.whatsapp && phone),
      place: own, directions: !!(o.directions && place),
      mapUrl: own ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(own) : mapsUrl(site)};
  }
  // Yol tarifi: panelde Google Haritalar bağlantısı girildiyse o; yoksa işletme adı + adres (yalnız adres aranınca harita yanlış noktaya gidebiliyor)
  function mapsUrl(site){
    site = site || {};
    const own = String(site.mapUrl || '').trim();
    if(/^https?:\/\//i.test(own)) return own;
    const addr = String(site.address || '').trim();
    if(!addr) return '';
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((site.name ? site.name + ' Restoran, ' : '') + addr);
  }
  // Açılış popup'ında gösterilecek afişler, sırasıyla: duyurular (panel sırası) → aktif kampanyalar → yaklaşan etkinlikler
  function posterSlides(data, n){
    n = n || now();
    const out = [];
    (data.announcements || []).forEach(a => {
      if(a.popup === false || announcementState(a, n) !== 'live') return;
      out.push({kind:'ann', key:'a:' + a.id, title: a.title, badge: 'DUYURU', text: a.text, image: a.image, link: a.link,
        button: a.button, endsAt: parseWall(a.to), info: posterInfo(a, data.site), src: a});
    });
    (data.campaigns || []).forEach(c => {
      const st = campaignState(c, n);
      if(!st.active || !c.popup || c.popup.enabled === false) return;
      out.push({kind:'camp', key:'c:' + c.id, title: c.title, badge: discountLabel(c), text: c.text, image: c.popup.image,
        button: c.popup.button, endsAt: st.endsAt, when: describeSchedule(c), src: c});
    });
    upcomingEvents(data, n, 7).forEach(o => {
      if(!o.ev.popup) return;
      out.push({kind:'event', key:'e:' + o.ev.id + ':' + o.day, title: o.ev.title, badge: eventType(o.ev).label, text: o.ev.text,
        image: o.ev.image, day: o.day, start: o.start, live: o.live, info: posterInfo(o.ev, data.site), src: o.ev});
    });
    return out;
  }

  /* ---------- Sosyal medya ---------- */
  // Kullanıcı adı veya tam adres yazılabilir; adres üretilir
  const SOCIALS = [
    {key:'instagram', label:'Instagram', url: h => 'https://instagram.com/' + h.replace(/^@/, '')},
    {key:'facebook', label:'Facebook', url: h => 'https://facebook.com/' + h.replace(/^@/, '')},
    {key:'tiktok', label:'TikTok', url: h => 'https://www.tiktok.com/@' + h.replace(/^@/, '')},
    {key:'x', label:'X (Twitter)', url: h => 'https://x.com/' + h.replace(/^@/, '')},
    {key:'youtube', label:'YouTube', url: h => 'https://youtube.com/@' + h.replace(/^@/, '')},
    {key:'whatsapp', label:'WhatsApp', url: h => 'https://wa.me/' + h.replace(/\D/g, '').replace(/^0/, '90')},
    {key:'google', label:'Google yorum / işletme', url: h => h}
  ];
  function socialLinks(site){
    const s = site.social || {}, out = [];
    SOCIALS.forEach(x => {
      const v = String(s[x.key] || '').trim();
      if(!v) return;
      out.push({key: x.key, label: x.label, href: /^https?:\/\//i.test(v) ? v : x.url(v)});
    });
    if(site.phone && s.showPhone !== false) out.push({key:'phone', label:'Ara: ' + site.phone, href:'tel:' + String(site.phone).replace(/\s/g, '')});
    if(site.address && s.showMap !== false) out.push({key:'map', label:'Yol tarifi', href: mapsUrl(site)});
    return out;
  }

  /* ---------- Açık / kapalı ---------- */
  function openState(site, n){
    n = n || now();
    const o = parseHM(site.opening), c = parseHM(site.closing);
    if(o == null || c == null) return null;
    const open = o < c ? (n.min >= o && n.min < c) : (n.min >= o || n.min < c);
    return {open, opening: hm(o), closing: hm(c)};
  }

  /* ---------- Oturma planı (rezervasyon) ---------- */
  // Krokilerden çizildi. Koordinatlar plan birimi (≈ px); masa: {id, label, seats, x, y, w, h}
  // walls: [x1,y1,x2,y2] duvar çizgileri; doors: kapı/geçit (kesikli çizgi + yazı); zones: mutfak gibi alanlar; obstacles: zeytin ağacı vb.
  const FLOORS = [
    {id:'ic', name:'İç Mekân', w:1216, h:384,
      walls:[[0,0,640,0],[768,0,1216,0],[1216,0,1216,384],[1216,384,768,384],[768,384,768,322],[768,322,128,322],[128,322,128,384],[0,0,0,384],[128,0,128,60],[768,0,768,40]],
      doors:[{x1:0, y1:384, x2:128, y2:384, label:'Giriş', side:'bottom'}, {x1:640, y1:0, x2:768, y2:0, label:'Diğer alanlar', side:'top'}],
      zones:[{x:0, y:0, w:128, h:60, label:'Mutfak'}],
      obstacles:[],
      tables:[
        {id:'i1', label:'İ1', seats:2, x:192, y:22, w:64, h:40},
        {id:'i2', label:'İ2', seats:4, x:320, y:8, w:128, h:74},
        {id:'i3', label:'İ3', seats:6, x:512, y:8, w:128, h:94},
        {id:'i4', label:'İ4', seats:4, x:832, y:22, w:128, h:80},
        {id:'i5', label:'İ5', seats:4, x:1024, y:22, w:128, h:80},
        {id:'i6', label:'İ6', seats:4, x:1024, y:162, w:128, h:80},
        {id:'i7', label:'İ7', seats:4, x:192, y:202, w:128, h:100},
        {id:'i8', label:'İ8', seats:8, x:384, y:182, w:128, h:120},
        {id:'i9', label:'İ9', seats:4, x:640, y:222, w:128, h:80},
        {id:'i10', label:'İ10', seats:4, x:832, y:282, w:128, h:80},
        {id:'i11', label:'İ11', seats:4, x:1024, y:282, w:128, h:80}
      ]},
    {id:'dis', name:'Dış Mekân', w:1216, h:400,
      walls:[[0,0,64,0],[192,0,1216,0],[1216,0,1216,400],[1216,400,704,400],[576,400,0,400],[0,400,0,0]],
      doors:[{x1:64, y1:0, x2:192, y2:0, label:'İç alan girişi', side:'top'}, {x1:576, y1:400, x2:704, y2:400, label:'Dış alan girişi', side:'bottom'}],
      zones:[],
      obstacles:[{x:576, y:142, w:128, h:80, label:'Zeytin ağacı', shape:'tree'}],
      tables:[
        {id:'d1', label:'D1', seats:4, x:8, y:102, w:120, h:60},
        {id:'d2', label:'D2', seats:4, x:8, y:222, w:120, h:80},
        {id:'d3', label:'D3', seats:4, x:256, y:22, w:128, h:80},
        {id:'d4', label:'D4', seats:4, x:448, y:22, w:128, h:80},
        {id:'d5', label:'D5', seats:4, x:640, y:22, w:128, h:80},
        {id:'d6', label:'D6', seats:4, x:832, y:22, w:128, h:80},
        {id:'d7', label:'D7', seats:2, x:1024, y:42, w:64, h:40},
        {id:'d8', label:'D8', seats:2, x:192, y:162, w:64, h:40},
        {id:'d9', label:'D9', seats:2, x:320, y:162, w:64, h:40},
        {id:'d10', label:'D10', seats:2, x:448, y:162, w:64, h:40},
        {id:'d11', label:'D11', seats:2, x:768, y:162, w:64, h:40},
        {id:'d12', label:'D12', seats:6, x:896, y:142, w:192, h:80},
        {id:'d13', label:'D13', seats:4, x:192, y:282, w:128, h:80},
        {id:'d14', label:'D14', seats:4, x:384, y:282, w:128, h:80},
        {id:'d15', label:'D15', seats:4, x:704, y:282, w:128, h:80},
        {id:'d16', label:'D16', seats:4, x:896, y:282, w:128, h:80},
        {id:'d17', label:'D17', seats:4, x:1080, y:282, w:128, h:80}
      ]}
  ];
  const DEFAULT_FLOORS = JSON.parse(JSON.stringify(FLOORS));
  let TABLES = {};
  function indexTables(){ TABLES = Object.fromEntries(FLOORS.flatMap(f => f.tables.map(t => [t.id, Object.assign({area: f.id, areaName: f.name}, t)]))); }
  indexTables();
  // Panelden düzenlenen masa düzeni (floors.json) varsayılan krokinin yerine geçer; duvarlar ve kapılar krokiden gelir
  function setFloorTables(saved){
    FLOORS.forEach(f => {
      const s = saved && saved[f.id];
      f.tables = Array.isArray(s) ? JSON.parse(JSON.stringify(s)) : JSON.parse(JSON.stringify(DEFAULT_FLOORS.find(d => d.id === f.id).tables));
    });
    indexTables();
  }
  function defaultFloorTables(id){ return JSON.parse(JSON.stringify(DEFAULT_FLOORS.find(d => d.id === id).tables)); }
  function floorById(id){ return FLOORS.find(f => f.id === id) || FLOORS[0]; }
  function tableById(id){ return TABLES[id] || null; }
  // "320 TL", "1.400 TL", "50cl / 175 TL" → 320, 1400, 175 (cl/gr gibi miktarlar atlanır, son sayı fiyat kabul edilir)
  function parsePrice(p){
    const m = String(p || '').match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?(?![\d.,])(?!\s*(?:cl|ml|gr|g|kg|lt|l|cm|adet)\b)/gi);
    if(!m) return 0;
    return parseFloat(m[m.length - 1].replace(/\./g, '').replace(',', '.')) || 0;
  }
  function formatTL(n){ return (Math.round(n * 100) / 100).toLocaleString('tr-TR') + ' TL'; }

  /* ---------- Özel günler ---------- */
  // Menü o gün açılınca kutlama / anma penceresi gösterir, köşede rozet kalır. Tarihler her yıl kendiliğinden tekrar eder.
  // kind: flag (bayraklı milli bayram) · mourn (anma, siyah) · warm (kutlama, altın). ata: Atatürk fotoğrafı.
  // Metinlerde {y} yıl, {n} kaçıncı yıl (since'ten bu yana). reserve: pencerede "Rezervasyon yap" düğmesi.
  // Dini bayramlar ay takvimine göre her yıl kaydığı için Diyanet takvimiyle yıl yıl yazılır: [ilk gün, gün sayısı]
  const RELIGIOUS_DAYS = {
    2026: {ramazan: ['2026-03-20', 3], kurban: ['2026-05-27', 4]},
    2027: {ramazan: ['2027-03-09', 3], kurban: ['2027-05-16', 4]}
  };
  const nthSunday = (y, mon, n) => { const first = new Date(Date.UTC(y, mon - 1, 1)).getUTCDay(); return 1 + (7 - first) % 7 + (n - 1) * 7; };
  const SPECIAL_DAYS = [
    {key: 'yilbasi', md: '01-01', name: 'Yılbaşı', kind: 'warm', icon: '✨', badge: ['1 Ocak', 'Mutlu yıllar'], eyebrow: '1 Ocak {y}',
      title: 'Yeni yılınız <em>kutlu olsun</em>', text: '{y} yılının size ve sevdiklerinize sağlık, huzur ve güzel sofralar getirmesini dileriz.'},
    {key: 'sevgililer', md: '02-14', name: 'Sevgililer Günü', kind: 'warm', icon: '❤', badge: ['14 Şubat', 'Sevgililer Günü'], eyebrow: '14 Şubat', reserve: true,
      title: 'Sevgililer Gününüz <em>kutlu olsun</em>', text: 'Bu akşam sevdiğinizle güzel bir sofrada buluşmaya ne dersiniz? Masanızı şimdiden ayırtabilirsiniz.'},
    {key: 'kadinlar', md: '03-08', name: 'Dünya Kadınlar Günü', kind: 'warm', icon: '💐', badge: ['8 Mart', 'Kadınlar Günü'], eyebrow: '8 Mart',
      title: 'Dünya Kadınlar Günü <em>kutlu olsun</em>', text: 'Hayatımıza emek, güç ve zarafet katan tüm kadınların Dünya Kadınlar Günü’nü kutlarız.'},
    {key: 'canakkale', md: '03-18', name: '18 Mart Çanakkale Zaferi', kind: 'flag', ata: true, since: 1915, badge: ['18 Mart', 'Çanakkale Zaferi'], eyebrow: '18 Mart 1915 – 18 Mart {y}',
      title: 'Çanakkale Zaferi’nin <em>{n}. yılı</em>', text: 'Çanakkale Zaferi’nin {n}. yıl dönümünde başta Gazi Mustafa Kemal Atatürk olmak üzere tüm şehitlerimizi rahmet, minnet ve saygıyla anıyoruz.',
      quote: 'Ben size taarruzu emretmiyorum, ölmeyi emrediyorum.'},
    {key: '23nisan', md: '04-23', name: '23 Nisan Ulusal Egemenlik ve Çocuk Bayramı', kind: 'flag', ata: true, since: 1920, badge: ['23 Nisan', 'Çocuk Bayramı'], eyebrow: '23 Nisan 1920 – 23 Nisan {y}',
      title: 'Ulusal Egemenlik ve Çocuk Bayramımız <em>kutlu olsun</em>', text: 'Türkiye Büyük Millet Meclisi’nin açılışının {n}. yılında, bu bayramı çocuklarımıza armağan eden Gazi Mustafa Kemal Atatürk’ü saygı ve minnetle anıyoruz.',
      quote: 'Küçük hanımlar, küçük beyler! Sizler hepiniz geleceğin bir gülü, yıldızı ve ikbal ışığısınız.'},
    {key: '1mayis', md: '05-01', name: '1 Mayıs Emek ve Dayanışma Günü', kind: 'warm', icon: '🌿', badge: ['1 Mayıs', 'Emek ve Dayanışma'], eyebrow: '1 Mayıs',
      title: 'Emek ve Dayanışma Günü <em>kutlu olsun</em>', text: 'Emeğiyle hayatımıza değer katan herkesin 1 Mayıs Emek ve Dayanışma Günü’nü kutlarız.'},
    {key: 'anneler', on: y => '05-' + String(nthSunday(y, 5, 2)).padStart(2, '0'), name: 'Anneler Günü (Mayıs’ın 2. pazarı)', kind: 'warm', icon: '🌷', badge: ['Anneler Günü', 'Kutlu olsun'], eyebrow: 'Anneler Günü', reserve: true,
      title: 'Anneler Gününüz <em>kutlu olsun</em>', text: 'Bugün annelerinizi güzel bir sofrada ağırlamak için masanızı ayırtabilirsiniz. Tüm annelerin gününü kutlarız.'},
    {key: '19mayis', md: '05-19', name: '19 Mayıs Gençlik ve Spor Bayramı', kind: 'flag', ata: true, since: 1919, badge: ['19 Mayıs', 'Gençlik ve Spor Bayramı'], eyebrow: '19 Mayıs 1919 – 19 Mayıs {y}',
      title: 'Gençlik ve Spor Bayramımız <em>kutlu olsun</em>', text: 'Atatürk’ün Samsun’a çıkışının {n}. yılında Atatürk’ü Anma, Gençlik ve Spor Bayramımızı kutluyor, Gazi Mustafa Kemal Atatürk’ü saygı ve minnetle anıyoruz.',
      quote: 'Ey Türk gençliği! Birinci vazifen, Türk istiklalini, Türk Cumhuriyetini ilelebet muhafaza ve müdafaa etmektir.'},
    {key: 'babalar', on: y => '06-' + String(nthSunday(y, 6, 3)).padStart(2, '0'), name: 'Babalar Günü (Haziran’ın 3. pazarı)', kind: 'warm', icon: '☕', badge: ['Babalar Günü', 'Kutlu olsun'], eyebrow: 'Babalar Günü', reserve: true,
      title: 'Babalar Gününüz <em>kutlu olsun</em>', text: 'Bugün babalarınızla güzel bir sofrada buluşmak için masanızı ayırtabilirsiniz. Tüm babaların gününü kutlarız.'},
    {key: '15temmuz', md: '07-15', name: '15 Temmuz Demokrasi ve Milli Birlik Günü', kind: 'flag', since: 2016, badge: ['15 Temmuz', 'Milli Birlik Günü'], eyebrow: '15 Temmuz 2016',
      title: 'Demokrasi ve Milli Birlik <em>Günü</em>', text: '15 Temmuz şehitlerimizi rahmetle, gazilerimizi minnetle anıyoruz.'},
    {key: '30agustos', md: '08-30', name: '30 Ağustos Zafer Bayramı', kind: 'flag', ata: true, since: 1922, badge: ['30 Ağustos', 'Zafer Bayramı'], eyebrow: '30 Ağustos 1922 – 30 Ağustos {y}',
      title: 'Zafer Bayramımız <em>kutlu olsun</em>', text: 'Büyük Zafer’in {n}. yılında başta Başkomutan Gazi Mustafa Kemal Atatürk olmak üzere tüm şehit ve gazilerimizi saygı ve minnetle anıyoruz.',
      quote: 'Ordular! İlk hedefiniz Akdeniz’dir. İleri!'},
    {key: '29ekim', md: '10-29', name: '29 Ekim Cumhuriyet Bayramı', kind: 'flag', ata: true, since: 1923, badge: ['29 Ekim', 'Cumhuriyet Bayramı'], eyebrow: '29 Ekim 1923 – 29 Ekim {y}',
      title: 'Cumhuriyet Bayramımız <em>kutlu olsun</em>', text: 'Cumhuriyetimizin {n}. yılını gururla kutluyor; başta Gazi Mustafa Kemal Atatürk olmak üzere tüm kahramanlarımızı saygı ve minnetle anıyoruz.',
      quote: 'Ne mutlu Türküm diyene!'},
    {key: '10kasim', md: '11-10', name: '10 Kasım Atatürk’ü Anma Günü', kind: 'mourn', ata: true, since: 1938, badge: ['10 Kasım', 'Saygıyla anıyoruz'], eyebrow: '10 Kasım 1938 · 09.05',
      title: 'Seni <em>özlemle</em> anıyoruz', text: 'Cumhuriyetimizin kurucusu Gazi Mustafa Kemal Atatürk’ü, aramızdan ayrılışının {n}. yılında saygı, sevgi ve özlemle anıyoruz.',
      quote: 'Benim naçiz vücudum elbet bir gün toprak olacaktır, fakat Türkiye Cumhuriyeti ilelebet payidar kalacaktır.', button: 'Saygıyla'},
    {key: 'ogretmenler', md: '11-24', name: '24 Kasım Öğretmenler Günü', kind: 'warm', icon: '📚', badge: ['24 Kasım', 'Öğretmenler Günü'], eyebrow: '24 Kasım',
      title: 'Öğretmenler Günü <em>kutlu olsun</em>', text: 'Başöğretmenimiz Gazi Mustafa Kemal Atatürk başta olmak üzere tüm öğretmenlerimizin gününü saygıyla kutlarız.'},
    {key: 'yilsonu', md: '12-31', name: 'Yılbaşı gecesi', kind: 'warm', icon: '🥂', badge: ['31 Aralık', 'Yılbaşı gecesi'], eyebrow: '31 Aralık', reserve: true,
      title: 'Yeni yıla <em>birlikte</em> girelim', text: 'Yılın son akşamını güzel bir sofrada kutlamak için masanızı şimdiden ayırtabilirsiniz.'},
    {key: 'ramazan', religious: 'ramazan', name: 'Ramazan Bayramı', kind: 'warm', icon: '🌙', badge: ['Ramazan Bayramı', 'Mübarek olsun'], eyebrow: 'Ramazan Bayramı · {g}. gün',
      title: 'Ramazan Bayramınız <em>mübarek olsun</em>', text: 'Bayramın size ve sevdiklerinize sağlık, huzur ve bereket getirmesini dileriz.'},
    {key: 'kurban', religious: 'kurban', name: 'Kurban Bayramı', kind: 'warm', icon: '🌙', badge: ['Kurban Bayramı', 'Mübarek olsun'], eyebrow: 'Kurban Bayramı · {g}. gün',
      title: 'Kurban Bayramınız <em>mübarek olsun</em>', text: 'Bayramın size ve sevdiklerinize sağlık, huzur ve bereket getirmesini dileriz.'}
  ];
  // Verilen günün (YYYY-MM-DD) özel gününün tarihi; dini bayramda kaçıncı gün olduğu (g) da döner
  function specialDayDates(sd, y){
    if(sd.religious){
      const r = (RELIGIOUS_DAYS[y] || {})[sd.religious];
      if(!r) return [];
      const t0 = parseWall(r[0]);
      return Array.from({length: r[1]}, (_, i) => new Date(t0 + i * DAY_MS).toISOString().slice(0, 10));
    }
    return [y + '-' + (sd.on ? sd.on(y) : sd.md)];
  }
  // site.specialDays === false ise hiçbiri, site.specialDaysOff içindeki anahtarlar gösterilmez
  function specialDay(site, date){
    site = site || {};
    if(site.specialDays === false) return null;
    const y = +date.slice(0, 4), off = site.specialDaysOff || [];
    for(const sd of SPECIAL_DAYS){
      if(off.includes(sd.key)) continue;
      const g = specialDayDates(sd, y).indexOf(date);
      if(g < 0) continue;
      const fill = s => String(s || '').replace(/\{y\}/g, y).replace(/\{n\}/g, sd.since ? y - sd.since : '').replace(/\{g\}/g, g + 1);
      return Object.assign({}, sd, {date, eyebrow: fill(sd.eyebrow), title: fill(sd.title), text: fill(sd.text), badge: sd.badge.map(fill)});
    }
    return null;
  }
  // Bugünden itibaren gelecek özel günler (yönetim paneli listesi için)
  function upcomingSpecialDays(fromDate, count){
    const y = +fromDate.slice(0, 4), out = [];
    [y, y + 1].forEach(yy => SPECIAL_DAYS.forEach(sd => { const d = specialDayDates(sd, yy); if(d.length && d[d.length - 1] >= fromDate) out.push({sd, date: d[0], days: d.length}); }));
    return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, count || 40);
  }
  const todayStr = () => new Date(now().wall).toISOString().slice(0, 10);

  global.YirmiCore = {
    FLOORS, floorById, tableById, setFloorTables, defaultFloorTables, parsePrice, formatTL,
    ALLERGENS, ALLERGEN_LABELS, DAYS, slugify, prepare, findItem,
    itemPhoto, isDefaultPhoto, coverPhoto, heroPhotos, layoutFor, sized,
    now, setNowOverride, parseWall, parseHM, hm,
    campaignState, describeSchedule, campaignTargets, applyDiscount, discountLabel, priceInfo, formatCountdown, newCampaign,
    campaignOnDay, EVENT_TYPES, eventType, eventDays, eventWindow, upcomingEvents, newEvent,
    announcementState, newAnnouncement, posterSlides, posterInfo, mapsUrl, SOCIALS, socialLinks,
    openState, chefInfo, isDefaultChefPhoto,
    SPECIAL_DAYS, RELIGIOUS_DAYS, specialDay, upcomingSpecialDays, todayStr
  };
})(window);

# WhatsApp & Instagram Rezervasyon Botu — Kurulum

Bot, Cloudflare'de ücretsiz çalışan küçük bir sunucudur (`bot/worker.js`). Müşteri WhatsApp'tan veya Instagram DM'den yazınca:

1. Otomatik karşılar → **Rezervasyon / Özel gün / Menü & bilgi / Yetkiliyle görüş**
2. (Özel günse) ne kutlandığını sorar
3. Tarih → saat (sitedeki açılış–kapanış saatlerine göre)
4. İç alan / dış alan / fark etmez. **Dış alan kapalıysa bu soru atlanır**, müşteriye "dış alan kapalı, iç alana alıyoruz" denir.
5. Kişi sayısı
6. Sigaralı / sigarasız (iç alanda sigara yasak olduğu için iç alanda sorulmaz, bilgi verilir)
7. Menüden istek / özel istek (pasta, alerji…) — yoksa **Geç**
8. Ad soyad (WhatsApp'ta telefon otomatik alınır; Instagram'da telefon da sorulur)
9. Özet → **Onayla**
10. "Rezervasyon talebiniz alınmıştır" mesajı + personel numaralarına bildirim
11. Yönetim paneli açıkken talep kendiliğinden **uygun boş masaya "Beklemede"** olarak düşer (sesli uyarı ile)
12. Panelde **Onayla** deyince müşteriye "Rezervasyonunuz onaylandı" mesajı gider. İptal edilirse kibar bir iptal mesajı gider.

> **Kurmadan önce denemek için:** `bot/simulator.html` sayfasını açın. Gerçek bot kodu tarayıcıda çalışır, hiçbir yere mesaj gitmez. Siteden açarsanız adres `https://yirmirestoran.github.io/bot/simulator.html` olur. Bilgisayardan çift tıklayarak açarsanız sayfa bir kez `bot/worker.js` dosyasını seçmenizi ister.

Müşteri istediği an **yetkili** yazarsa bot susar (12 saat) ve personele haber verir. **menü** yazarsa baştan başlar, **iptal** yazarsa talep iptal olur.

---

## 1) Cloudflare (bot sunucusu) — ~10 dk

1. https://dash.cloudflare.com adresinden ücretsiz hesap açın.
2. **Storage & Databases → D1 → Create database**, adı: `yirmi-bot`.
3. **Workers & Pages → Create → Create Worker**, adı: `yirmi-bot` → **Deploy**.
4. **Edit code**: içindeki her şeyi silin, `bot/worker.js` dosyasının tamamını yapıştırın → **Deploy**.
5. Worker → **Settings → Bindings → Add → D1 database**: Variable name `DB`, veritabanı `yirmi-bot`.
6. Worker → **Settings → Triggers → Cron Triggers → Add**: `*/15 * * * *` (15 dakikada bir: bekleyen bot numarasını kontrol, temizlik, Instagram anahtarını yenileme).
7. Worker → **Settings → Variables and Secrets** — aşağıdakileri ekleyin (gizli olanları **Secret** türünde):

| Ad | Tür | Değer |
|---|---|---|
| `SITE_URL` | Text | `https://yirmirestoran.github.io` |
| `ALLOWED_ORIGIN` | Text | `https://yirmirestoran.github.io` |
| `VERIFY_TOKEN` | Secret | Kendiniz uydurun, ör. `yirmi-dogrulama-2026` |
| `ADMIN_KEY` | Secret | Uzun rastgele bir anahtar (aşağıya bakın) |
| `STAFF_NUMBERS` | Secret | Bildirim alacak personel: `905321112233,905441112233` (başında 90, boşluksuz) |
| `META_APP_SECRET` | Secret | Meta adımında alınacak |
| `WA_TOKEN` | Secret | Meta adımında alınacak |
| `WA_PHONE_ID` | Text | Meta adımında alınacak |
| `IG_TOKEN` | Secret | Instagram adımında alınacak |
| `IG_APP_SECRET` | Secret | Instagram adımında alınacak |

`ADMIN_KEY` üretmek için PowerShell'de:
```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

Worker adresiniz `https://yirmi-bot.<hesap-adınız>.workers.dev` olacak. Tarayıcıda açınca "Yirmi rezervasyon asistanı çalışıyor." yazmalı.

---

## 2) WhatsApp (Meta) — ~30 dk + Meta onay süreleri

> **Önemli — numaranız "düz" WhatsApp'ta:** Otomatik mesaj için numaranın **WhatsApp Business Platform**'a bağlanması gerekir. İki yol var:
>
> **A) Aynı numarayı kullanmak (tavsiye):** Önce telefonda **WhatsApp Business** uygulamasını kurup mevcut numaranızla giriş yapın; sohbetler taşınır. Sonra aşağıdaki kurulumda numara eklerken **"mevcut WhatsApp Business uygulamasını bağla"** seçeneğini seçin. Buna "coexistence" denir. Böylece telefonda uygulamayı kullanmaya devam edersiniz, bot da aynı numaradan cevap verir. Personel telefondan bir müşteriye yazarsa bot o müşteriye 12 saat karışmaz.
>
> **B) Bot için ikinci bir hat:** Seçenek A hesabınızda çıkmazsa yeni bir hat alıp sadece bot için kullanın. Bu numara API'ye bağlanınca telefondaki WhatsApp'ta **kullanılamaz**. Instagram profilindeki ve sitedeki WhatsApp numarasını bu yeni hat ile değiştirin (Panel → İşletme Bilgileri).

1. https://business.facebook.com adresinde bir **İşletme portföyü** oluşturun (varsa onu kullanın).
2. https://developers.facebook.com → **My Apps → Create App** → kullanım alanı **"Connect with customers through WhatsApp"** (tür: Business) → işletme portföyünüzü seçin.
3. Uygulamada **WhatsApp → API Setup / Quickstart** → **Add phone number** → numaranızı ekleyip SMS ile doğrulayın (yukarıdaki A/B seçimine göre).
4. **Phone number ID** değerini kopyalayın → Cloudflare'de `WA_PHONE_ID`.
5. **Kalıcı token:** business.facebook.com → **Ayarlar → Kullanıcılar → Sistem kullanıcıları → Ekle** (Yönetici) → **Varlık ata**: uygulamanız + WhatsApp hesabınız (tam yetki) → **Token oluştur**: süresi "Hiçbir zaman", izinler `whatsapp_business_messaging` ve `whatsapp_business_management` → Cloudflare'de `WA_TOKEN`.
6. Uygulama → **App settings → Basic → App secret** → Cloudflare'de `META_APP_SECRET`. Aynı sayfada **Privacy Policy URL** olarak `https://yirmirestoran.github.io` yazın.
7. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://yirmi-bot.<hesap-adınız>.workers.dev/webhook`
   - Verify token: `VERIFY_TOKEN` olarak yazdığınız kelime
   - **Webhook fields**: `messages` → Subscribe. Seçenek A'yı kullandıysanız `smb_message_echoes` alanına da abone olun.
8. Uygulamayı **Live (Yayında)** moduna alın. Uygulama panelinin üstündeki anahtardan yapılır.
9. WhatsApp Manager → **Ödeme yöntemi** ekleyin. Sadece şablon mesajlar ücretlidir; müşterinin başlattığı sohbetlere verilen cevaplar ücretsizdir.

### "Sadece görünen ad" bot numarası (onay beklerken hazırlık)
Meta'nın verdiği asıl bot numarası onaylanınca bot kendiliğinden devreye girer. Bunun için önceden şunları ekleyin:

| Ad | Tür | Değer |
|---|---|---|
| `WA_BOT_PHONE_ID` | Text | Yeni numaranın **Phone Number ID**'si (ör. `1342646595604844`) |
| `WA_WABA_ID` | Text | Yeni numaranın bağlı olduğu **WhatsApp Business Account ID** |
| `WA_PIN` | Secret | Kendi belirlediğiniz 6 haneli sayı (numaranın iki adımlı doğrulama PIN'i) |

- `WA_PHONE_ID` şimdiki (test) numarada kalır; değiştirmeyin.
- Sistem kullanıcısına (**yirmi-bot**) yeni WhatsApp hesabını da **Varlık ata → Tam kontrol** ile ekleyin.
- Numarayı panelden elle **Register** etmeyin. Ederseniz aynı `WA_PIN` değerini kullanın.
- Panel → **İşletme Bilgileri → Rezervasyon bağlantısı**: `https://yirmi-bot.<hesabınız>.workers.dev/wa`. Bu adres, bot numarası açılana kadar müşteriyi restoran numarasına, açılınca bota yönlendirir.

Bot 15 dakikada bir kontrol eder. Meta görünen adı onaylayınca numarayı kaydeder, uygulamaya abone eder ve personele "Bot numarası aktif oldu" mesajı atar. Personel o mesajdaki bağlantıdan yeni numaraya bir kez **durum** yazmalı. Personel numarasından **durum** yazarak bekleyen numaranın durumunu görebilirsiniz.

### Personel bildirimleri hakkında
Resmi API **normal bir WhatsApp grubuna mesaj atamaz**. Bunun yerine bildirim, `STAFF_NUMBERS`'daki her personele restoranın numarasından ayrı ayrı gider. Hepsi aynı mesajı aldığı için grup gibi çalışır.

WhatsApp kuralı gereği personel son 24 saat içinde bot numarasına yazmadıysa düz mesaj **teslim edilmez**. İki çözüm var (ikisini birlikte de kullanabilirsiniz):
- **Kolay:** Her personel günde bir kez restoran numarasına **durum** yazsın. O gün tüm bildirimler ücretsiz ve ayrıntılı gelir.
- **Garantili:** WhatsApp Manager → **Mesaj şablonları → Oluştur**: kategori **Utility**, ad `yeni_rezervasyon`, dil **Türkçe**, gövde:
  `Yeni rezervasyon talebi: {{1}}. Onaylamak için yönetim panelini açın.`
  Onaylanınca Cloudflare'e `STAFF_TEMPLATE` = `yeni_rezervasyon` ekleyin. Bot, 24 saat dışında kalan personele bu şablonu gönderir (mesaj başına küçük bir ücret).

### (İsteğe bağlı) Geç onaylanan rezervasyonlar
Panelden onay, müşterinin son mesajından 24 saat sonra verilirse düz mesaj gönderilemez; panel bunu uyarır, müşteriyi arayabilirsiniz. Bunun yerine otomatik gitsin isterseniz şu şablonu açın: Utility, ad `rezervasyon_onay`, Türkçe, gövde:
`Merhaba {{1}}, {{2}} tarihindeki {{3}} kişilik rezervasyonunuz onaylandı. Sizi ağırlamayı dört gözle bekliyoruz!`
Sonra Cloudflare'e `CONFIRM_TEMPLATE` = `rezervasyon_onay` ekleyin.

---

## 3) Instagram — ~15 dk

1. Instagram hesabı **Profesyonel (İşletme)** hesap olmalı. Instagram uygulamasında: **Ayarlar → Mesajlar ve hikaye yanıtları → Mesaj kontrolleri → Bağlı araçlar → "Mesajlara erişime izin ver"** açık olsun.
2. developers.facebook.com'daki aynı uygulamaya **Add product → Instagram** → **API setup with Instagram login**.
3. **Generate access tokens → Add account** → restoranın Instagram hesabıyla giriş yapın → çıkan token'ı kopyalayın → Cloudflare'de `IG_TOKEN`. Bot bu anahtarı her hafta kendisi yeniler.
4. Aynı sayfadaki **Instagram app secret** → Cloudflare'de `IG_APP_SECRET`.
5. **Configure webhooks**: Callback URL ve Verify token WhatsApp'takiyle aynı → **Verify and save** → `messages` ve `messaging_postbacks` alanlarına abone olun.
6. Meta "App Review / Advanced Access" isterse `instagram_business_manage_messages` için başvurun. Botun çalıştığını gösteren kısa bir ekran kaydı yeterli.

---

## 4) Yönetim paneli

1. Panel → **Güvenlik → WhatsApp / Instagram Botu**: Bot adresi (`https://yirmi-bot.….workers.dev`) + `ADMIN_KEY` + mevcut şifre → **Kaydet ve test et**.
2. **Rezervasyon** sekmesinin üstünde **Mesaj botu** şeridi çıkar:
   - Yeşil nokta: bağlı.
   - **Dış alan**: *Açık / Bugün kapalı / Bugün + yarın kapalı / Ben açana kadar kapalı*. Yağmurlu günlerde buradan kapatın.
3. Bottan gelen talepler listede **"WhatsApp botu · KOD"** etiketi ve **Onayla** düğmesiyle görünür. Durumu *Onaylandı* veya *İptal* yapınca müşteriye otomatik mesaj gider.
4. Talepler, panel bir cihazda açıkken her dakika içeri alınır. Kimse paneli açmasa da talepler kaybolmaz; panel açılınca hepsi düşer.

### Sohbetler sekmesi (canlı takip)
Panel → **Sohbetler**:
- **Durum kartları:** WhatsApp ve Instagram botunun bağlı olup olmadığı, son gelen mesaj, son hata ve bu ayki mesaj sayısı.
- **Sohbet listesi:** Tüm WhatsApp / Instagram yazışmaları 4 saniyede bir kendiliğinden yenilenir. **Personelde** ve **Okunmamış** filtreleri, ayrıca isim ve numara araması var.
- **Sohbete müdahale:** Bir sohbeti açınca müşteri, bot ve personel mesajları ayrı renklerle görünür.
  - Alttaki kutudan müşteriye yazabilirsiniz; mesaj restoran hesabından gider ve bot o müşteriye 12 saat karışmaz.
  - **Devral** botu hemen susturur; **Bota devret** sohbeti bota geri verir.
- **Rozet ve sesli uyarı:** Sekmedeki kırmızı rozet, personelden cevap bekleyen sohbet sayısıdır. Yeni bir bekleyen sohbet gelince panel sesli uyarı verir.

Sohbetler bot sunucusunda 30 gün saklanır.

### Botun sorularını değiştirmek
Panel → **WhatsApp Botu** sekmesinde şunları değiştirebilirsiniz:
- karşılama mesajı ve ana menü seçenekleri (açıp kapatabilirsiniz),
- oturma yeri / sigara seçenekleri,
- özel gün türleri, tüm soru metinleri ve "talep alındı" mesajı,
- en kalabalık grup sınırı ve yeni rezervasyonda personele WhatsApp bildirimi gidip gitmeyeceği.

**Simülatörde dene** düğmesi kaydetmeden önizleme açar; paneldeki her değişiklik oraya anında yansır. **Kaydet ve Yayınla**'dan birkaç dakika sonra gerçek bota geçer. Personel numarasından **durum** yazınca bu ay gönderilen WhatsApp mesajı sayısı da görünür.

## 5) Personel komutları (personel numarasından restoran numarasına yazılır)

| Komut | İşlev |
|---|---|
| `dış kapat` | Bugün dış alanı kapatır |
| `dış kapat yarın` | Bugün ve yarın kapalı |
| `dış kapat süresiz` | Siz açana kadar kapalı |
| `dış aç` | Dış alanı açar |
| `durum` | Dış alan durumu, bekleyen talepler (ve 24 saatlik bildirim penceresini açar) |
| `izle aç` / `izle kapat` | Müşterilerin bota yazdığı her mesajın kopyası personele gelsin / gelmesin |
| `test` | Botu müşteri gibi denersiniz; çıkmak için `personel` |

### Müşteriyle personel numarasından yazışmak
Her müşteriye 4 harflik bir kod verilir (ör. `#MKS2`). Personel:
- Bildirimi **sola kaydırıp yanıtlarsa** ya da **`#MKS2 mesajınız`** yazarsa, mesaj müşteriye restoranın WhatsApp hesabından gider. Personelin numarası müşteriye görünmez. İletilen mesajın altına ✅ tepkisi düşer.
- Personel yazınca bot o müşteriye 12 saat karışmaz; müşterinin cevapları `💬 #MKS2 …` diye personele gelir.
- **`#MKS2 bitir`** yazınca sohbet tekrar bota geçer.
- Birden fazla personel varsa, birinin yazdığı mesajın kopyası diğerlerine de gider.

Örneğin restoranın kendi numarası (+90 530 338 31 20) da `STAFF_NUMBERS` listesine `905303383120` olarak eklenirse, bütün bunlar o telefondaki WhatsApp Business uygulamasından yapılabilir.

## Sorun giderme
- **Webhook doğrulanmıyor:** Worker adresinin sonunda `/webhook` olmalı, `VERIFY_TOKEN` birebir aynı yazılmalı.
- **Bot cevap vermiyor:** Cloudflare → Worker → **Logs (Real-time)** bölümünden hatayı görün. Token'ları, `WA_PHONE_ID`'yi ve uygulamanın *Live* modda olduğunu kontrol edin.
- **Panel "Bota ulaşılamadı" diyor:** `ALLOWED_ORIGIN` değeri panelin açıldığı adresle aynı olmalı (`https://yirmirestoran.github.io`, sonda `/` olmadan).

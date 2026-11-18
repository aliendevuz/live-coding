# Duet

Ikki kishi uchun birgalikda kod yozish va dars o'tish ilovasi (Windows, Tauri 2).
O'qituvchi (host) loyihani ochadi, o'quvchi (guest) xona kodi bilan ulanadi. Ulanish
bir marta AWS Lambda orqali o'rnatiladi, keyin hamma narsa WebRTC orqali to'g'ridan-to'g'ri
ketadi.

## Nimalar bor

| Imkoniyat | Qanday ishlaydi |
|---|---|
| Kod sinxronlash | Ochilgan fayllar Yjs (CRDT) orqali real vaqtda. Sherigingizning kursori va belgilagan joyi rangli ko'rinadi. Faqat host diskka yozadi (300 ms debounce, CRLF/BOM saqlanadi). Diskdagi tashqi o'zgarishlar ham sherigingizga yetadi. |
| Explorer (v3) | VS Code'dagidek ishlaydi: drag bilan boshqa papkaga ko'chirish (Ctrl bosilsa nusxalash, yopiq papka ustida ushlab turilsa ochiladi), Ctrl/Shift bilan bir nechta tanlash, Cut/Copy/Paste (Ctrl+X/C/V), Duplicate, joyida rename (F2) va yangi fayl (`a/b/c.py` ham bo'ladi), klaviatura bilan yurish (strelkalar, Enter), Delete (fayl Recycle Bin'ga tushadi, ya'ni tiklash mumkin), ochiq faylni daraxtda avtomatik ko'rsatish, Collapse all. Hostda qo'shimcha: "Open in Terminal" va "Reveal in File Explorer". |
| Drag & drop (v3) | Lobby oynasiga loyiha papkasini tashlasangiz, darhol dars boshlanadi va dialog ochilmaydi. Shu papkani yana tashlasangiz, eski xona kodi saqlanadi. Dars paytida Windows Explorer'dan fayl yoki papkani Explorer'dagi kerakli papka ustiga tashlasangiz: hostda u loyihaga nusxalanadi, guestda hostga yuklanadi (progress Transfers'da ko'rinadi). |
| Fayllar | Guestga faqat nomlar ko'rinadi, papkalar ochilganda yuklanadi. Fayl faqat so'ralganda yuboriladi. 2 MB dan katta matn fayllari jonli sinxronlanmaydi (read-only ochish mumkin). Rasmlar ko'rsatiladi. Binary fayllarni yuklab olish mumkin. Guest tomonda hash bo'yicha cache bor. |
| Clone | Guest Explorer'dagi ⤓ tugmasi bilan joyni o'zi tanlab, loyihani o'ziga ko'chiradi. `.env*` (`.env.example` dan tashqari), `node_modules`, `.venv`/`venv`/`env`, `.git`, `__pycache__`, `target`, `dist`, `build`, `.next` va `.gitignore`'dagi narsalar ko'chirilmaydi. |
| Terminal | Haqiqiy PowerShell hostda ishlaydi (ConPTY). Bir nechta tab ochish mumkin, hammasi guestga ko'rinadi. Guest faqat host ruxsat berganda yozadi (🔒/🔓 tugmasi). Bu ruxsatni host tomoni ham tekshiradi. |
| Run (F5) | `.py` `.js` `.ts` `.ps1` `.go` `.rb` `.php` `.java` `.c` `.cpp` fayllari alohida terminalda ishga tushadi. `.html` bo'lsa :5500 portda statik server ko'tariladi va port avtomatik ulashiladi. |
| Port tunnel | Host Ports panelidan portni ulashadi (masalan Vite 5173). Shu port guestning `localhost`'ida ham ochiladi, agar band bo'lsa boshqa portda ochiladi. |
| Audio | Mikrofonda echo cancellation va noise suppression yoqilgan. Mute tugmasi bor, gapirayotgan odamning avatari yonadi. |
| Pointer va chizish | Sherigingizning sichqonchasi nomi bilan ko'rinadi. Laser (`Ctrl+Alt+L`), Pen (`Ctrl+Alt+P`), Highlighter (`Ctrl+Alt+H`), tozalash `Ctrl+Alt+C`, chiqish `Esc`. Kod ustidagi chiziq qator va ustunga bog'lanadi, shuning uchun ekran o'lchami boshqa bo'lsa ham to'g'ri joyda turadi va kod bilan birga scroll bo'ladi. |
| Follow | Sherigingiz ochgan faylni ochadi va u bilan birga scroll qiladi. Guestda bu rejim boshidan yoqilgan bo'ladi. |
| IntelliSense (v2) | Python (Pyright) va JS/TS (typescript-language-server). Imkoniyatlari: autocompletion (auto-import bilan), hover'da hujjatlar, signature help, go to definition (F12 / Ctrl+Click, boshqa fayllarga ham), references (Shift+F12), highlight, xatolar va ogohlantirishlar. Serverlar **faqat hostda** ishlaydi va loyihani, `node_modules` hamda `.venv`'ni ko'radi. O'quvchining so'rovlari WebRTC orqali hostga boradi, shuning uchun unda hech narsa o'rnatish shart emas. HTML, CSS va JSON uchun Monaco'ning ichki xizmatlari ishlaydi. |
| Jupyter notebook (v4) | `.ipynb` fayllar notebook ko'rinishida ochiladi. Hujayralar, ularning kodi va natijalari ikkala odamda real vaqtda ko'rinadi, kursorlar ham. Kernel hostda ishlaydi (haqiqiy `ipykernel`, shuning uchun magic'lar, `!pip`, `display()` ishlaydi). Imkoniyatlar: Run all, Interrupt, Restart, Clear outputs; Shift+Enter (ishga tushirib keyingisiga o'tish), Ctrl+Enter, Alt+Enter (pastga yangi hujayra qo'shish). Natijalar: matn, rangli traceback, matplotlib rasmlari, pandas jadvallari, HTML, markdown va LaTeX. Completion jonli kernel'dan olinadi. Natijalar `.ipynb` faylga standart nbformat 4 bilan saqlanadi. O'quvchi hujayrani faqat terminal ruxsati bo'lsa ishga tushiradi. |
| Chat | O'ng panelda. |
| Qayta ulanish | Aloqa uzilsa, host Lambda'ga yangi offer qo'yadi va guest unga avtomatik qayta ulanadi. Fayllar, terminallar va portlar tiklanadi. Host appni yopib, "Reopen" bilan qayta ochsa ham xona kodi o'zgarmaydi. |
| Trafik ustuvorligi | Fayllar va tunnel trafigi alohida "bulk" yo'lakdan o'tadi. Kechikish oshsa, ya'ni audio, kursor va chatga xalaqit bera boshlasa, bulk tezligi ulanish sig'imining ko'pi bilan yarmiga tushiriladi. Xalaqit bo'lmasa, bulk butun kanaldan foydalanadi. |

## IntelliSense (v2)

- Hostda **Node.js** o'rnatilgan bo'lishi kerak. Birinchi darsda Duet `pyright`, `typescript-language-server` va `typescript@6` paketlarini npm orqali `%LOCALAPPDATA%\app.duet.desktop\lsp` papkasiga o'rnatadi (taxminan 60 MB, bir marta). O'rnatish holati status bar'da ko'rinadi.
- Loyihada `.venv`, `venv` yoki `env` bo'lsa, Python uchun o'sha interpreter ishlatiladi va o'rnatilgan kutubxonalar ham takliflarda chiqadi. Bo'lmasa, PATH'dagi `python` ishlatiladi.
- Hujjatlar serverga umumiy Yjs hujjatidan uzatiladi: ikki kishi uchun bitta server ishlaydi, takliflar ham ikkalasida bir xil.
- `typescript` 7 (native) versiyasida `tsserver.js` yo'q, shuning uchun 6-versiya qotirilgan.

## Notebook (v4)

- Hostda Python va `ipykernel` kerak. Loyihada `.venv`, `venv` yoki `env` bo'lsa, o'sha muhit ishlatiladi. `ipykernel` bo'lmasa, notebook'da **Install ipykernel** tugmasi chiqadi: u o'rnatishni terminalda ochiq bajaradi. Keyin **Retry** bosiladi.
- Har bir notebook uchun alohida kernel ishlaydi. Kernel Duet bilan birga to'xtaydi.
- Windows'da Interrupt Python kodini darhol to'xtatadi, lekin `time.sleep()` yoki bloklovchi I/O chaqiruvni u tugagandan keyingina to'xtatadi. Bu ipykernel'ning Windows'dagi cheklovi, JupyterLab'da ham shunday. Kutib bo'lmasa, **Restart** bosing.
- Bitta natija 8 MB'dan katta bo'lsa, u jonli ulashilmaydi. O'rniga shu haqda yozuv chiqadi.

## macOS (o'quvchi Mac'da bo'lsa)

O'quvchi tomonida Windows'ga bog'liq hech narsa ishlamaydi: terminal, Python, kernel va language server'larning hammasi hostda. Mac uchun ilovani faqat macOS'da build qilish mumkin, shuning uchun GitHub Actions ishlatiladi:

1. Loyihani GitHub repo'ga yuklang.
2. *Settings → Secrets and variables → Actions → Variables* bo'limida `SIGNALING_URL` = Lambda manzilini kiriting.
3. *Actions → Build Duet → Run workflow* ni bosing. Tugagach, *Artifacts* bo'limidan `duet-macos` (`.dmg`, Intel va Apple Silicon uchun bitta fayl) va `duet-windows` (`.exe`) ni yuklab oling.

Ilova Apple Developer akkauntisiz "ad-hoc" usulda imzolanadi. Bu bepul, lekin birinchi ochishda macOS ogohlantiradi. O'quvchi buni **bir marta** ochib beradi:
- macOS 15 va yangisi: *System Settings → Privacy & Security* → pastda **Open Anyway**.
- Eskiroq macOS: ilovaga o'ng tugma → **Open**.
- Yoki Terminal'da: `xattr -cr /Applications/Duet.app`

Mikrofon so'rovi uchun matn `src-tauri/Info.plist` faylida. Mac'da tezkor tugmalar Ctrl o'rniga Cmd bilan ishlaydi. Ogohlantirishsiz tarqatish uchun Apple Developer akkaunti ($99/yil) va notarization kerak, bitta o'quvchi uchun bu shart emas.

## Mikrofon ruxsati

Tauri Windows'da sahifani Microsoft WebView2 (Edge/Chromium) orqali ko'rsatadi. WebView2 ham brauzer kabi har qanday sahifadan mikrofon uchun ruxsat so'raydi. Duet v3'da `on_permission_request` orqali mikrofon **faqat ilovaning o'z sahifasiga** avtomatik beriladi (`src-tauri/src/lib.rs`), boshqa ruxsatlar odatdagidek so'raladi. Windows'ning o'z sozlamasi (Settings → Privacy → Microphone → "Let desktop apps access your microphone") alohida va yoqilgan bo'lishi kerak.

## Ishga tushirish

Kerakli vositalar: Rust (stable, MSVC), Node.js 20+, WebView2 (Windows 11'da bor).

```powershell
npm install
npm run signaling        # lokal signaling server: http://localhost:8787 (AWS'siz sinash uchun)
npm run tauri dev        # boshqa terminalda
```

Bitta kompyuterda ikkita oyna ochib sinash mumkin. Birida **Host a lesson**, ikkinchisida **Join**.

Installer yasash uchun:

```powershell
npx tauri build          # src-tauri/target/release/bundle/nsis/Duet_0.1.0_x64-setup.exe
```

Ikonkani o'zgartirganda (`npx tauri icon app-icon.svg`), build'dan oldin `cd src-tauri; cargo clean -p live --release` qiling. Aks holda oyna ikonkasi exe ichida eskisicha qoladi, chunki Rust kodi o'zgarmagani uchun u qayta kompilyatsiya qilinmaydi.

## Lambda'ni deploy qilish (bir marta)

1. AWS CLI va SAM CLI'ni o'rnating:
   ```powershell
   winget install Amazon.AWSCLI
   winget install Amazon.SAM-CLI
   aws configure            # Access key, secret, region (masalan eu-central-1)
   ```
2. Deploy qiling (stack nomi deploy-policy.json dagi prefiks bilan bir xil bo'lishi kerak, hozir `live-app`):
   ```powershell
   cd signaling
   sam build
   sam deploy --guided      # stack nomi: live-app
   ```
   *"SignalingFunction has no authentication. Is this okay?"* deb so'rasa **y** deb javob bering, chunki bu ataylab shunday qilingan (pastdagi Xavfsizlik bo'limiga qarang).
3. Oxirida chiqqan `SignalingUrl` manzilini nusxalang (`https://xxxx.lambda-url.<region>.on.aws/`).
4. Uni appga ikki usulda berish mumkin:
   - Lobby'da **Advanced → Signaling URL** maydoniga qo'yish (har bir kompyuterda bir marta), yoki
   - loyiha ildizida `.env.production` fayl yaratib, ichiga `VITE_SIGNALING_URL=https://xxxx.lambda-url...` yozish va keyin `npx tauri build` qilish. Shunda installer'ga URL ichiga yozilgan bo'ladi va o'quvchi hech narsa sozlamaydi.

Narxi: bitta dars uchun bir necha o'nlab so'rov ketadi (kutish paytida har 1–2.5 soniyada bitta so'rov). Bu Free Tier ichida qoladi. DynamoDB yozuvlari TTL bilan 1 soatda o'chadi.

## Testlar

```powershell
npm run test:signaling                                   # Lambda mantig'i
node scripts/check-signaling.mjs <URL>                   # deploy qilingan Lambda'ni tekshirish
cd src-tauri; cargo test                                 # path himoyasi, istisnolar
npx tauri build --debug --no-bundle; node scripts/e2e.mjs # ikki haqiqiy oyna, 71 ta tekshiruv; notebook testlari uchun DUET_E2E_PYTHON_DIR = ipykernel bor Python'ning Scripts papkasi
```

`e2e.mjs` bitta kompyuterda ikkita Duet oynasini ochadi (host va guest) va ularni WebView2 DevTools orqali boshqaradi. U quyidagilarni tekshiradi: ulanish, fayl ro'yxati va ignore qoidalari, path traversal'ning bloklanishi, tahrirning ikki yo'nalishda diskka yetishi, 3 MB faylni uzatish va cache, clone, terminal va ruxsatlar, Run, follow, tunnel (HTTP, 3 MB, 8 ta parallel so'rov), audio oqimi, chat, pointer, uzilib qayta ulanish.

## Tuzilishi

```
signaling/            Lambda + DynamoDB (SAM), lokal dev-server, testlar
src-tauri/src/
  fsops.rs            loyiha fayllari, path himoyasi, .gitignore, watcher, clone ro'yxati
  pty.rs              ConPTY terminallar
  tunnel.rs           TCP <-> WebRTC tunnel, kreditli oqim nazorati
  lsp.rs              language server jarayonlari (stdio, Content-Length), npm orqali o'rnatish
  kernel.rs           notebook kernel ko'prigi (resources/duet_kernel.py, jupyter_client)
src/net/
  signaling.ts        Lambda klienti
  link.ts             RTCPeerConnection, 5 ta kanal, heartbeat, qayta ulanish
  bulk.ts             fayl va tunnel yo'lagi, kechikishga asoslangan tezlik nazorati
src/core/
  session.ts          hamma narsani birlashtiradi (hello, ruxsatlar, chat, pointer)
  yjs-sync.ts         Yjs va awareness sinxronizatsiyasi
  files.ts            fayllarni ochish, saqlash, uzatish, clone
  terminals.ts        terminal oynalari, Run
  tunnels.ts          portlarni ulashish
  audio.ts            mikrofon va ovoz darajasi
  lsp.ts              hostda serverlar, Yjs -> LSP sinxronlash, guest so'rovlari, diagnostika
  notebooks.ts        .ipynb <-> Yjs, kernel navbati, interrupt/restart, completion
src/ui/               React: Lobby, Explorer, EditorArea (Monaco), BottomPanel, Chat, PointerOverlay
```

WebRTC kanallari: `ctrl` (JSON RPC), `yjs`, `cursor` (unreliable), `bulk` va `term`. Bulardan tashqari bitta audio transceiver bor.

## Xavfsizlik

- Xona kodi 10 ta tasodifiy belgidan iborat. Host xonani maxfiy kalit bilan egallaydi, boshqa odam uning offer'ini almashtira olmaydi. Har bir epoch'ga faqat birinchi kelgan javob qabul qilinadi.
- Guestdan kelgan hamma path loyiha papkasi ichida tekshiriladi: `..`, absolute path, symlink orqali chiqib ketish rad etiladi.
- Guest fayllarni tahrir qila oladi, yaratadi va o'chiradi (siz shuni xohlagansiz). Kod ishga tushirish va terminalga yozish faqat host ruxsati bilan bo'ladi.
- Tunnel faqat host ulashgan portlarga ulanadi.
- Lambda URL'i ochiq (auth yo'q). U faqat SDP saqlaydi va kod emas, xona kodini bilgan odamgina ulana oladi.

## Cheklovlar va keyingi versiya uchun

- TURN yo'q. Ikkala tomon simmetrik NAT yoki qattiq korporativ tarmoq ortida bo'lsa ulanish o'rnatilmaydi, status bar'da shu haqda xabar chiqadi. Kerak bo'lsa `src/net/link.ts`'dagi `ICE` ro'yxatiga TURN server qo'shiladi.
- IntelliSense hozircha Python va JS/TS uchun. Go, Rust, C/C++ va Java'da faqat so'z bo'yicha taklif ishlaydi. Rename va formatlash keyingi versiyada.
- Bitta xonaga bitta host va bitta guest ulanadi.
- Ikkala tomonda realtime ishlaydigan `.git`'ga o'xshash tarix keyinga qoldirilgan.

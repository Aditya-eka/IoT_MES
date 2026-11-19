# Mini IoT & MES — Pemantauan Line Produksi (3 mesin)

Prototype: **ESP32 (Wokwi) → Backend Node.js → PostgreSQL → Web Dashboard**, plus `tools/sim-device.js` sebagai pengganti ESP32 saat uji.

```
ESP32 / sim-device ──HTTP POST /api/ingest──▶ Node.js (Express) ◀──▶ PostgreSQL
                                                   │
                                  GET /api/machines (polling 3 dtk)
                                                   ▼
                                           frontend/index.html
```

## Cara menjalankan (5 langkah)

Kebutuhan: Node.js ≥ 18 dan PostgreSQL ≥ 13.

1. `npm install`
2. `cp .env.example .env` lalu isi password database di `DATABASE_URL`.
3. Buat database dan isi: `createdb mini_mes` lalu `psql "<DATABASE_URL>" -f db/schema.sql -f db/seed.sql` (pakai nilai `DATABASE_URL` dari `.env`).
4. `npm start`, lalu buka **http://localhost:3000** (dashboard).
5. Di terminal lain: `npm run sim -- --fast` (simulator 3 mesin, kirim tiap 3 dtk; tanpa `--fast` = tiap 10 dtk; `--flaky` = simulasi jaringan buruk).

Query durasi status (Modul 2 no. 5): `psql "<DATABASE_URL>" -f db/queries.sql` → RUNNING **150** menit, IDLE **45** menit, DOWN **45** menit (total 240).

### Firmware di Wokwi
- Link proyek Wokwi: **https://wokwi.com/projects/481103443588819969** (proyek tersimpan **Public** karena opsi Unlisted berbayar; isinya hanya device key `dev-key-mc01`). Isi proyek = `sketch.ino`, `diagram.json`, `libraries.txt` dari folder `firmware/`.
- Wokwi tidak bisa mengakses `localhost`. Jalankan tunnel `ssh -R 80:localhost:3000 nokey@localhost.run` (yang berhasil saat uji), lalu isi `SERVER_URL` di `sketch.ino` dengan `https://<url-tunnel>/api/ingest`.
  - **Hasil uji:** dari Wokwi, Cloudflare Quick Tunnel (`cloudflared tunnel --url http://localhost:3000`) dan pinggy memberi `[HTTP] -1` (gagal konek) walau dari host keduanya `HTTP 200`. Yang berhasil: **localhost.run** (`[HTTP] 201`).
  - Domain gratis localhost.run berganti sendiri saat sesi berjalan, jadi `SERVER_URL` harus disalin ulang dari output SSH lalu sketch di-build ulang.
- Uji: tekan COUNT → hijau (RUNNING); 15 dtk tanpa tekan → kuning (IDLE); tombol FAULT atau geser suhu DHT22 ≥ 70 °C → merah + buzzer putus-putus (DOWN).
- Catatan DHT22 di Wokwi: hanya bacaan pertama saat boot yang berhasil; bacaan berikutnya `[DHT] gagal baca` (suhu dikirim `null`). Karena itu uji OVERHEAT dilakukan dengan menggeser slider suhu ke 75 °C **sebelum** simulasi dijalankan.

| Komponen | Pin | Komponen | Pin |
|---|---|---|---|
| Tombol COUNT | GPIO 19 | LED hijau | GPIO 25 |
| Tombol REJECT | GPIO 21 | LED kuning | GPIO 26 |
| Tombol FAULT | GPIO 22 | LED merah | GPIO 27 |
| DHT22 | GPIO 4 | Buzzer | GPIO 13 |

Semua pin sesuai soal (tidak diganti). Tombol aktif LOW dengan `INPUT_PULLUP`.

## Struktur repo
```
firmware/   sketch.ino, diagram.json, libraries.txt   (Wokwi)
server/     index.js                                   (Express + pg)
db/         schema.sql, seed.sql, queries.sql
tools/      sim-device.js
frontend/   index.html
SPEC.md     analisa kebutuhan (Modul 4)
```

## Keputusan desain penting
- **Anti-duplikat di database:** `UNIQUE (machine_id, boot_id, seq)` + `ON CONFLICT DO NOTHING`. Kiriman ulang dijawab `200 duplicate` (bukan error) supaya ESP32 berhenti mengulang. `seq` mulai dari 1 lagi setiap `boot_id` baru, jadi restart tidak dianggap duplikat.
- **Tidak ada `delay()`; jaringan di task terpisah.** `loop()` hanya membaca tombol, suhu, status, LED/buzzer. Pengiriman HTTP dan sambung ulang WiFi berjalan di task **core 1**, sehingga tombol tetap terbaca saat server lambat atau WiFi putus. Task ini sengaja tidak di-pin ke core 0: POST HTTPS yang memblokir di core 0 membuat task IDLE0 kelaparan dan memicu *task watchdog reset* (lihat "Hasil pengujian").
- **Pesan yang gagal dikirim ulang apa adanya** (seq dan delta sama) lewat satu slot *outbox*; hitungan baru terus menumpuk di penghitung dan masuk ke pesan berikutnya, jadi tidak ada hitungan hilang selama perangkat tetap menyala. Respons `400` tidak diulang (payload ditolak permanen).
- **Overheat dengan hysteresis:** DOWN di ≥ 70 °C, baru lepas di < 65 °C. Sensor gagal dibaca → `temperature_c: null`, **tidak** dianggap overheat, dan status overheat yang sudah aktif dipertahankan sampai ada bacaan valid < 65 °C. Jika FAULT dan overheat aktif bersamaan, alasan yang dilaporkan `FAULT_BUTTON` (sesuai urutan di soal).
- **Riwayat status** dicatat saat `state` *atau* `reason` berubah (mis. DOWN/FAULT_BUTTON → DOWN/OVERHEAT). Per mesin diserialkan dengan `SELECT ... FOR UPDATE` agar pengecekan "berubah?" tidak tertukar oleh request bersamaan.
- **Waktu memakai waktu server** (`received_at`), karena ESP32 tidak punya jam nyata. Konsekuensinya: saat offline lalu tersambung lagi, perubahan status tercatat pada waktu pesan *diterima*.
- **OFFLINE dihitung di server** (tidak ada data > 30 dtk, atau belum pernah ada data), bukan dilaporkan perangkat — perangkat yang mati tidak bisa melapor.
- **Output = jumlah tekan COUNT** (semua produk yang lewat); **Reject** dihitung terpisah dari tombol REJECT. Batas "hari ini" memakai zona waktu `TIMEZONE` (default Asia/Jakarta).
- **Dashboard:** satu file, polling 3 dtk, mesin DOWN diurutkan paling kiri, berkedip, dan memakai blok putih-merah besar. Jika server tidak terjangkau, data terakhir tetap tampil dan muncul banner peringatan (layar TV tidak kosong).

## Hasil pengujian (19 November 2026)

Lingkungan: CachyOS, Node.js (LTS), PostgreSQL 18 lokal, Chromium. Dua tahap: simulator Node, lalu firmware ESP32 di Wokwi lewat tunnel.

**1. Backend + simulator (`tools/sim-device.js`)**
- `db/schema.sql` + `db/seed.sql` berhasil dibuat; `db/queries.sql` menghasilkan **RUNNING 150 / IDLE 45 / DOWN 45 menit** (total 240) — cocok dengan soal.
- `POST /api/ingest`: **201** pesan baru, **200** `duplicate` saat seq yang sama dikirim ulang, **401** device key salah, **400** payload tidak valid, **201** setelah `boot_id` baru (restart).
- Simulator `--flaky`: pesan gagal dikirim ulang dengan seq/delta yang sama, tidak ada hitungan hilang, dan pasangan `(machine_id, boot_id, seq)` tidak pernah dobel di database.
- Skenario MC-03: FAULT → `DOWN (FAULT_BUTTON)`, suhu ≥ 70 °C → `DOWN (OVERHEAT)`, turun < 65 °C → normal lagi (hysteresis). Semua perubahan tercatat di `telemetry` dan `state_history`.
- Dashboard: tampil benar pada 1920×1080, polling 3 dtk, mesin DOWN di kiri + berkedip; banner peringatan muncul saat server dimatikan.

**2. Firmware ESP32 di Wokwi (end-to-end lewat tunnel)**
- Serial Wokwi: `[MSG]` diikuti `[HTTP] 201`; setiap restart menghasilkan `boot_id` baru dan `seq` mulai dari 1 tanpa dianggap duplikat.
- Tombol COUNT (tekan ±400 ms karena debounce 50 ms) → `[STATE] RUNNING`, `output_delta=1` masuk `telemetry` dan `state_history`.
- Tombol FAULT → `[STATE] DOWN (FAULT_BUTTON)`, tersimpan di database.
- DHT22 digeser ke 75 °C → `[STATE] DOWN (OVERHEAT)` dengan `temperature_c: 75.0`; dashboard MC-01 menampilkan **DOWN** dan teks **"SUHU MOTOR TERLALU PANAS"**.
- **Bug yang ditemukan saat uji Wokwi — sudah diperbaiki:** task `net` di-pin ke **core 0**, sehingga POST HTTPS yang memblokir membuat task IDLE0 kelaparan dan ESP32 kena *task watchdog reset* berulang (`IDLE0 ... CPU 0: net` → reboot). Perbaikannya satu baris, task jaringan dipindah ke core 1; setelah itu simulasi stabil dan semua skenario di atas lulus:
  ```diff
  -  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
  +  // Pin ke core 1: POST HTTPS memblokir task, core 0 harus tetap melayani IDLE (cegah task watchdog reset)
  +  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 1);
  ```
- Keterbatasan saat uji: bacaan DHT22 di Wokwi hanya berhasil sekali saat boot; bacaan berikutnya selalu gagal (periode 2000 ms tepat di batas minimum sensor; percobaan 5000 ms juga tetap gagal di simulator, jadi ini kemungkinan quirk Wokwi — belum diuji di perangkat asli). Jika di lapangan muncul kegagalan serupa, naikkan `TEMP_PERIOD_MS` ke 5000.

## Bagian yang belum selesai / keterbatasan
- Uji Wokwi memakai domain gratis (localhost.run) yang berganti di tengah sesi, jadi `SERVER_URL` harus diperbarui dan di-build ulang setiap sesi. Untuk demo yang stabil: pakai domain tetap berbayar, atau jalankan `tools/sim-device.js`.
- Buffer hanya **1 pesan** di RAM: kalau WiFi putus lama lalu ESP32 restart, hitungan yang belum terkirim hilang. Perbaikan: antrean di NVS/flash, dan kirim **total kumulatif** di samping delta agar kehilangan paket bisa dipulihkan.
- Device key disimpan apa adanya di tabel `machines` (cukup untuk prototype; produksi sebaiknya di-hash). Dashboard belum memakai login, backend belum ada *rate limit*, dan koneksi Wokwi memakai `setInsecure()` (tanpa verifikasi sertifikat).
- Belum ada halaman laporan/grafik (query durasi baru berupa SQL), belum ada notifikasi WA/Telegram, belum ada OTA, dan belum ada tes otomatis (pengujian dilakukan manual + skrip tiruan).

## Jawaban 3 kasus

**1. Hitungan dobel saat motor konveyor baru menyala (proximity 24 V + optocoupler).**
Penyebab: lonjakan noise/arus start motor menimbulkan pulsa palsu di jalur sensor, atau sinyal berkedut (chatter) karena getaran dan tepi sinyal optocoupler yang lambat. Cek: lihat sinyal GPIO dengan osiloskop/logic analyzer, atau catat timestamp tiap pulsa — jika pulsa dobel berjarak beberapa milidetik dan hanya muncul saat motor start, itu noise. Solusi: kabel shielded yang dipisah dari kabel motor, grounding yang benar, filter RC + input Schmitt trigger setelah optocoupler, dan di firmware debounce/lockout yang lebih panjang dari pulsa palsu tetapi lebih pendek dari jarak antar produk (hitung satu tepi saja).

**2. ESP32 restart sendiri setiap relay lampu menyala/mati.**
Penyebab: koil relay menghasilkan lonjakan balik (back-EMF) dan arus start beban menyebabkan drop tegangan (brownout) atau noise pada catu ESP32. Cek: cetak `esp_reset_reason()` di serial (brownout = 15) dan ukur rail 3V3/5V dengan osiloskop saat relay beralih; beri catu terpisah untuk relay — jika reset hilang, itulah penyebabnya. Solusi: dioda flyback di koil (snubber RC/MOV untuk beban AC), modul relay ber-optocoupler dengan catu terpisah, kapasitor 470–1000 µF dekat ESP32, kabel pendek, dan ground yang rapi (star ground).

**3. Output dashboard 8% lebih kecil dari catatan operator, hanya di jam-jam tertentu.**
Penyebab: paling mungkin hitungan hilang saat WiFi putus di jam tertentu (interferensi/jam sibuk) — pesan gagal terkirim lalu ESP32 restart, atau buffer penuh. Penyebab lain: batas "hari ini" salah zona waktu, atau seq/boot_id tertukar sehingga pesan sah dianggap duplikat. Cek: cari lompatan `seq` per `boot_id`, jeda panjang pada `received_at`, `boot_id` yang sering berganti, serta log RSSI dan reset reason; cocokkan jamnya dengan jam selisih. Solusi: perkuat WiFi (AP tambahan, pilih channel), simpan hitungan di NVS dengan antrean beberapa pesan, dan kirim total kumulatif agar kehilangan paket bisa dipulihkan.

## Waktu pengerjaan
- Mulai: **13.55 WIB, 19 November 2026** (file proyek pertama dibuat)
- Selesai: **15.45 WIB, 19 November 2026**
- Total: **± 1 jam 50 menit**, mencakup setup Node.js/PostgreSQL, pembuatan database + seed, uji backend & simulator, uji firmware ESP32 di Wokwi lewat tunnel, serta penulisan hasil uji di README ini.

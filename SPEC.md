# SPEC — Pemantauan Mesin Produksi (12 mesin)

**Masalah (dari Kepala Produksi):** mesin berhenti baru ketahuan saat istirahat; reject sering lupa dicatat; tidak bisa melihat dari kantor mesin mana yang mati dan berapa lama; pernah ada motor terbakar karena panas; 12 mesin, WiFi sering putus, operator kurang paham komputer.

## 1. Kebutuhan sistem
| # | Kebutuhan | Ukuran berhasil |
|---|-----------|-----------------|
| K1 | Status tiap mesin (RUNNING / IDLE / DOWN / OFFLINE) terlihat real-time dari kantor (TV & HP) | Terbarui ≤ 5 dtk; 12 mesin dalam satu layar |
| K2 | Riwayat status: kapan mulai, kapan selesai, alasan; laporan menit per status per mesin/shift | Query per mesin & rentang waktu; durasi DOWN akurat ke menit |
| K3 | Alarm saat DOWN: lampu andon + buzzer di mesin, dan notifikasi ke supervisor (WA/Telegram) bila DOWN > X menit | Supervisor tahu < 1 menit setelah ambang terlewati |
| K4 | Proteksi suhu motor: ≥ 70 °C → DOWN (OVERHEAT) + alarm; selesai setelah < 65 °C; sensor rusak ≠ overheat | Tidak ada motor panas tanpa alarm |
| K5 | Reject tercatat saat kejadian: 1 tombol besar per mesin, tanpa login | Selisih reject vs hitung manual < 2% |
| K6 | Tahan WiFi putus: perangkat menyimpan & mengirim ulang tanpa menggandakan/menghilangkan hitungan; dashboard menandai OFFLINE bila > 30 dtk tanpa data | Output total sama dengan hitungan sensor |
| K7 | Mudah dipakai operator: tanpa layar & login, lampu 3 warna, tombol besar berlabel | Operator baru paham < 10 menit |
| K8 | Aman & mudah ditambah: device key per mesin, HTTPS; mesin baru = 1 baris DB + 1 firmware | Key salah ditolak (401) |

## 2. Pertanyaan untuk Kepala Produksi
1. Berhenti berapa lama baru disebut DOWN? Apakah istirahat, ganti shift, dan setup/ganti produk dikecualikan dari hitungan DOWN?
2. Bagaimana produk dihitung di tiap mesin (sensor di conveyor, PLC, counter bawaan)? Satu pulsa = berapa produk, dan secepat apa lajunya?
3. Siapa yang harus diberi tahu saat mesin DOWN, lewat apa (WA, Telegram, layar), dan setelah berapa menit naik ke atasan?
4. Suhu normal dan batas aman motor sebenarnya berapa? Cukup alarm, atau alat boleh memutus motor otomatis (ada tanggung jawab keselamatan)?
5. Di area mana WiFi putus dan jam berapa? Boleh memasang access point tambahan atau kabel LAN? Berapa lama putus masih bisa ditoleransi?
6. Reject perlu dicatat per jenis/alasan? Siapa yang menekan tombol, dan siapa yang boleh mengoreksi?
7. Laporan apa yang dibutuhkan (per jam/shift/hari, Excel/PDF), dan berapa lama data disimpan? Server di pabrik atau cloud, dan ada tim IT?

## 3. Risiko pemasangan dan penanganannya
| Risiko | Penanganan |
|--------|------------|
| WiFi putus / sinyal terhalang logam | Antrean + kirim ulang dengan `seq` sama; status OFFLINE; AP tambahan atau kabel LAN; log RSSI |
| Noise listrik motor/inverter/relay (hitung dobel, ESP32 reset) | Kabel shielded terpisah dari kabel daya, optocoupler + filter, dioda flyback/snubber, catu terpisah + kapasitor, grounding, debounce |
| Listrik drop / padam | Catu industri 24 V → buck 5 V, UPS kecil untuk ESP32/AP, watchdog, `boot_id` agar restart tidak merusak data |
| Debu, panas, getaran, air | Box IP54+, kabel gland, sensor suhu industri (PT100/DS18B20 waterproof) menggantikan DHT22 |
| Operator salah tekan / lupa | Tombol besar berlabel, debounce, koreksi oleh supervisor, pelatihan singkat |
| Mengganggu rangkaian keselamatan mesin | Hanya membaca sensor; tidak memotong sirkuit safety/E-stop; dipasang teknisi dengan LOTO |
| Akses tidak sah / data bocor | Device key per mesin, HTTPS, jaringan IoT terpisah (VLAN), dashboard dengan login (tahap berikutnya) |

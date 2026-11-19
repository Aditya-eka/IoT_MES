-- Berapa menit MC-01 berada di tiap status pada 24 Nov 2026, 08:00-12:00 WIB.
-- Bagian status di luar jam tersebut tidak dihitung.
--
-- Cara kerja:
--   1. lead() mencari kapan status berikutnya dimulai -> tiap status jadi rentang [mulai, selesai).
--      Status terakhir tidak punya "berikutnya", jadi rentangnya dianggap sampai akhir jendela.
--   2. Rentang dipotong ke jendela: GREATEST(mulai, 08:00) sampai LEAST(selesai, 12:00).
--      Contoh: RUNNING 07:40 dipotong jadi 08:00-08:25 = 25 menit (bukan 45).
--   3. Selisih dijumlah per status. Status yang tidak muncul tetap tampil dengan 0 menit.
--
-- WIB = UTC+7, ditulis eksplisit '+07' supaya hasil tidak tergantung timezone server.

-- ---------------------------------------------------------------------------
-- A) Versi mandiri dengan data contoh dari soal (bisa langsung dijalankan).
--    Hasil yang diharapkan: RUNNING 150, IDLE 45, DOWN 45 (total 240 menit).
-- ---------------------------------------------------------------------------
WITH events (started_at, state, reason) AS (
    VALUES
        ('2026-11-24 07:40:00+07'::timestamptz, 'RUNNING', NULL),
        ('2026-11-24 08:25:00+07'::timestamptz, 'IDLE',    NULL),
        ('2026-11-24 08:40:00+07'::timestamptz, 'RUNNING', NULL),
        ('2026-11-24 10:05:00+07'::timestamptz, 'DOWN',    'OVERHEAT'),
        ('2026-11-24 10:50:00+07'::timestamptz, 'RUNNING', NULL),
        ('2026-11-24 11:30:00+07'::timestamptz, 'IDLE',    NULL),
        ('2026-11-24 12:20:00+07'::timestamptz, 'RUNNING', NULL)
),
win AS (
    SELECT '2026-11-24 08:00:00+07'::timestamptz AS ws,
           '2026-11-24 12:00:00+07'::timestamptz AS we
),
spans AS (
    SELECT state, reason, started_at,
           lead(started_at) OVER (ORDER BY started_at) AS ended_at
    FROM events
),
clipped AS (
    SELECT s.state, s.reason,
           EXTRACT(EPOCH FROM (LEAST(COALESCE(s.ended_at, w.we), w.we)
                             - GREATEST(s.started_at, w.ws))) / 60.0 AS minutes
    FROM spans s CROSS JOIN win w
    WHERE COALESCE(s.ended_at, w.we) > w.ws   -- berakhir setelah jendela mulai
      AND s.started_at < w.we                 -- mulai sebelum jendela berakhir
)
SELECT st.state,
       ROUND(COALESCE(SUM(c.minutes), 0), 1)         AS minutes,
       string_agg(DISTINCT c.reason, ', ')           AS reason
FROM (VALUES ('RUNNING', 1), ('IDLE', 2), ('DOWN', 3)) AS st(state, ord)
LEFT JOIN clipped c ON c.state = st.state
GROUP BY st.state, st.ord
ORDER BY st.ord;

-- ---------------------------------------------------------------------------
-- B) Versi yang membaca tabel state_history sungguhan (data dari ESP32).
--    Logikanya sama; hanya sumber datanya yang berbeda.
--    Catatan: lead() dihitung atas SEMUA riwayat MC-01, baru difilter ke jendela,
--    sehingga status yang mulai sebelum 08:00 tetap ikut terhitung.
-- ---------------------------------------------------------------------------
WITH win AS (
    SELECT '2026-11-24 08:00:00+07'::timestamptz AS ws,
           '2026-11-24 12:00:00+07'::timestamptz AS we
),
spans AS (
    SELECT state, reason, started_at,
           lead(started_at) OVER (ORDER BY started_at, id) AS ended_at
    FROM state_history
    WHERE machine_id = 'MC-01'
),
clipped AS (
    SELECT s.state, s.reason,
           EXTRACT(EPOCH FROM (LEAST(COALESCE(s.ended_at, w.we), w.we)
                             - GREATEST(s.started_at, w.ws))) / 60.0 AS minutes
    FROM spans s CROSS JOIN win w
    WHERE COALESCE(s.ended_at, w.we) > w.ws
      AND s.started_at < w.we
)
SELECT st.state,
       ROUND(COALESCE(SUM(c.minutes), 0), 1)         AS minutes,
       string_agg(DISTINCT c.reason, ', ')           AS reason
FROM (VALUES ('RUNNING', 1), ('IDLE', 2), ('DOWN', 3)) AS st(state, ord)
LEFT JOIN clipped c ON c.state = st.state
GROUP BY st.state, st.ord
ORDER BY st.ord;

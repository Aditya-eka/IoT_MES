'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const OFFLINE_AFTER_SECONDS = Number(process.env.OFFLINE_AFTER_SECONDS) || 30;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL belum diatur. Salin .env.example menjadi .env terlebih dahulu.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STATES = ['RUNNING', 'IDLE', 'DOWN'];
const REASONS = ['FAULT_BUTTON', 'OVERHEAT'];

// ---------------------------------------------------------------------------
// Validasi payload. Mengembalikan daftar pesan error (kosong = valid).
// ---------------------------------------------------------------------------
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validatePayload(b) {
  const errors = [];
  if (typeof b.boot_id !== 'string' || !/^[A-Za-z0-9]{8}$/.test(b.boot_id)) {
    errors.push('boot_id harus 8 karakter huruf/angka');
  }
  if (!isInt(b.seq, 1, 2147483647)) errors.push('seq harus bilangan bulat >= 1');
  if (!STATES.includes(b.state)) errors.push('state harus RUNNING, IDLE, atau DOWN');

  if (b.state === 'DOWN') {
    if (!REASONS.includes(b.reason)) errors.push('reason wajib FAULT_BUTTON atau OVERHEAT saat DOWN');
  } else if (b.reason !== null && b.reason !== undefined) {
    errors.push('reason harus null selain saat DOWN');
  }

  if (!isInt(b.output_delta, 0, 1000000)) errors.push('output_delta harus bilangan bulat >= 0');
  if (!isInt(b.reject_delta, 0, 1000000)) errors.push('reject_delta harus bilangan bulat >= 0');

  if (b.temperature_c === undefined) {
    errors.push('temperature_c wajib ada (angka, atau null jika sensor gagal)');
  } else if (b.temperature_c !== null) {
    if (typeof b.temperature_c !== 'number' || !Number.isFinite(b.temperature_c)
        || b.temperature_c < -50 || b.temperature_c > 150) {
      errors.push('temperature_c harus angka antara -50 dan 150, atau null');
    }
  }
  return errors;
}

// Perbandingan key tanpa bocor lewat waktu (hash dulu agar panjangnya sama).
function keyMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Izinkan dashboard dibuka dari origin lain (mis. file:// atau hosting terpisah). Hanya GET.
app.use('/api/machines', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  next();
});

// POST /api/ingest — terima data dari ESP32
app.post('/api/ingest', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.machine_id !== 'string') {
    return res.status(400).json({ error: 'invalid_payload', details: ['machine_id wajib berupa string'] });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Kunci baris mesin: pesan dari mesin yang sama diproses berurutan, sehingga
    // pengecekan "status berubah?" tidak bisa tertukar oleh dua request bersamaan.
    const m = await client.query('SELECT device_key FROM machines WHERE id = $1 FOR UPDATE', [body.machine_id]);
    if (m.rowCount === 0 || !keyMatches(req.get('X-Device-Key') || '', m.rows[0].device_key)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const errors = validatePayload(body);
    if (errors.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_payload', details: errors });
    }

    const reason = body.state === 'DOWN' ? body.reason : null;

    // Anti-duplikat: ON CONFLICT DO NOTHING pada UNIQUE (machine_id, boot_id, seq).
    const ins = await client.query(
      `INSERT INTO telemetry
         (machine_id, boot_id, seq, state, reason, output_delta, reject_delta, temperature_c)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (machine_id, boot_id, seq) DO NOTHING
       RETURNING id`,
      [body.machine_id, body.boot_id, body.seq, body.state, reason,
       body.output_delta, body.reject_delta, body.temperature_c]
    );

    if (ins.rowCount === 0) {
      // Pesan kirim-ulang yang sudah pernah diterima: balas sukses agar ESP32 berhenti mengulang.
      await client.query('COMMIT');
      return res.status(200).json({ status: 'duplicate' });
    }

    // Catat ke riwayat jika status (atau alasan DOWN) berbeda dari yang terakhir.
    const last = await client.query(
      `SELECT state, reason FROM state_history
       WHERE machine_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [body.machine_id]
    );
    const changed = last.rowCount === 0
      || last.rows[0].state !== body.state
      || (last.rows[0].reason || null) !== reason;
    if (changed) {
      await client.query(
        'INSERT INTO state_history (machine_id, state, reason) VALUES ($1, $2, $3)',
        [body.machine_id, body.state, reason]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ status: 'stored', state_changed: changed });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* abaikan */ }
    console.error('ingest error:', err);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

// GET /api/machines — status terbaru tiap mesin
app.get('/api/machines', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id AS machine_id,
              m.name,
              t.state,
              t.reason,
              t.temperature_c::float8                               AS temperature_c,
              t.received_at                                         AS last_seen,
              (t.received_at IS NOT NULL
                 AND t.received_at > now() - make_interval(secs => $2)) AS online,
              COALESCE(d.output, 0)::int                            AS output_today,
              COALESCE(d.reject, 0)::int                            AS reject_today
       FROM machines m
       LEFT JOIN LATERAL (
         SELECT state, reason, temperature_c, received_at
         FROM telemetry WHERE machine_id = m.id
         ORDER BY id DESC LIMIT 1
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT SUM(output_delta) AS output, SUM(reject_delta) AS reject
         FROM telemetry
         WHERE machine_id = m.id
           AND received_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)
       ) d ON true
       ORDER BY m.id`,
      [TIMEZONE, OFFLINE_AFTER_SECONDS]
    );

    const now = Date.now();
    const machines = rows.map((r) => ({
      machine_id: r.machine_id,
      name: r.name,
      // status yang ditampilkan: OFFLINE jika tidak ada data > 30 detik (atau belum pernah ada data)
      status: r.online ? r.state : 'OFFLINE',
      last_reported_state: r.state,          // status terakhir yang dilaporkan perangkat
      reason: r.online ? r.reason : null,
      online: r.online,
      temperature_c: r.temperature_c,
      last_seen: r.last_seen,
      seconds_since_last_seen: r.last_seen ? Math.round((now - new Date(r.last_seen).getTime()) / 1000) : null,
      output_today: r.output_today,
      reject_today: r.reject_today,
    }));
    res.json({ server_time: new Date(now).toISOString(), machines });
  } catch (err) {
    console.error('machines error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Dashboard (satu origin dengan API, jadi tidak perlu CORS)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// JSON body rusak / terlalu besar -> 400, bukan 500
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: 'invalid_payload', details: ['body bukan JSON yang valid'] });
  }
  console.error(err);
  return res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}  (dashboard: /, API: /api/machines)`);
});

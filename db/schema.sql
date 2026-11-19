-- Mini IoT & MES — skema database (PostgreSQL 13+)
-- Jalankan: psql "$DATABASE_URL" -f db/schema.sql

DROP TABLE IF EXISTS state_history;
DROP TABLE IF EXISTS telemetry;
DROP TABLE IF EXISTS machines;

-- 1) Mesin + device key (key dipakai ESP32 pada header X-Device-Key)
CREATE TABLE machines (
    id          TEXT PRIMARY KEY,                 -- contoh: MC-01
    name        TEXT NOT NULL,
    device_key  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Data dari ESP32 (satu baris per pesan yang diterima)
CREATE TABLE telemetry (
    id             BIGSERIAL PRIMARY KEY,
    machine_id     TEXT        NOT NULL REFERENCES machines(id),
    boot_id        TEXT        NOT NULL,
    seq            INTEGER     NOT NULL CHECK (seq >= 1),
    state          TEXT        NOT NULL CHECK (state IN ('RUNNING', 'IDLE', 'DOWN')),
    reason         TEXT        CHECK (reason IN ('FAULT_BUTTON', 'OVERHEAT')),
    output_delta   INTEGER     NOT NULL CHECK (output_delta >= 0),
    reject_delta   INTEGER     NOT NULL CHECK (reject_delta >= 0),
    temperature_c  NUMERIC(5,1),                  -- NULL = sensor gagal dibaca
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- anti-duplikat: pesan yang sama (kirim ulang) hanya tersimpan sekali
    CONSTRAINT telemetry_dedup UNIQUE (machine_id, boot_id, seq),
    -- reason wajib saat DOWN, dan harus NULL selain DOWN
    CONSTRAINT telemetry_reason_required CHECK ((state = 'DOWN') = (reason IS NOT NULL))
);
CREATE INDEX telemetry_machine_latest_idx ON telemetry (machine_id, id DESC);
CREATE INDEX telemetry_machine_time_idx   ON telemetry (machine_id, received_at);

-- 3) Riwayat status: satu baris setiap status (atau alasan DOWN) berubah.
--    Status berlaku sampai started_at baris berikutnya.
CREATE TABLE state_history (
    id          BIGSERIAL PRIMARY KEY,
    machine_id  TEXT        NOT NULL REFERENCES machines(id),
    state       TEXT        NOT NULL CHECK (state IN ('RUNNING', 'IDLE', 'DOWN')),
    reason      TEXT        CHECK (reason IN ('FAULT_BUTTON', 'OVERHEAT')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT history_reason_required CHECK ((state = 'DOWN') = (reason IS NOT NULL))
);
CREATE INDEX state_history_machine_time_idx ON state_history (machine_id, started_at);

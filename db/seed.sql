-- Data awal 3 mesin. Device key di bawah HANYA untuk development.
-- Ganti dengan key acak untuk pemakaian sebenarnya, dan samakan dengan nilai
-- DEVICE_KEY_MC01..03 di .env (dipakai tools/sim-device.js) serta di firmware.
INSERT INTO machines (id, name, device_key) VALUES
    ('MC-01', 'Mesin 01', 'dev-key-mc01'),
    ('MC-02', 'Mesin 02', 'dev-key-mc02'),
    ('MC-03', 'Mesin 03', 'dev-key-mc03')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, device_key = EXCLUDED.device_key;

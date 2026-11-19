'use strict';

require('dotenv').config();
const crypto = require('crypto');

const BASE_URL = process.env.SIM_BASE_URL || 'http://localhost:3000';
const FAST = process.argv.includes('--fast');
const FLAKY = process.argv.includes('--flaky');
const SEND_PERIOD_MS = FAST ? 3000 : 10000;
const RETRY_MS = 2000;
const RUNNING_WINDOW_MS = 15000;
const TICK_MS = 1000;

const rand = (a, b) => a + Math.random() * (b - a);

class SimMachine {
  /**
   * @param {string} id        MC-01 ...
   * @param {string} key       device key
   * @param {(t:number)=>{count:number, reject:number, temp:number|null}} scenario
   *        dipanggil tiap detik dengan t = detik sejak start
   */
  constructor(id, key, scenario) {
    this.id = id;
    this.key = key;
    this.scenario = scenario;
    this.bootId = crypto.randomBytes(4).toString('hex'); // 8 karakter, baru tiap "menyala"
    this.seq = 0;
    this.pendingOut = 0;
    this.pendingRej = 0;
    this.lastCountAt = null;
    this.overheat = false;
    this.state = 'IDLE';
    this.reason = null;
    this.stateChanged = true;      // kirim pesan pertama segera
    this.lastBuildAt = 0;
    this.outbox = null;            // pesan yang belum terkonfirmasi (dikirim ulang dengan seq SAMA)
    this.nextTryAt = 0;
    this.t = 0;
    this.temp = null;
  }

  tick(now) {
    this.t += TICK_MS / 1000;
    const s = this.scenario(this.t);
    if (s.count > 0) { this.pendingOut += s.count; this.lastCountAt = now; }
    this.pendingRej += s.reject;
    this.temp = s.temp;

    // Overheat latch: aktif di >= 70, baru lepas di < 65. Sensor gagal (null) tidak dianggap overheat.
    if (this.temp !== null) {
      if (this.temp >= 70) this.overheat = true;
      else if (this.temp < 65) this.overheat = false;
    }

    let state, reason = null;
    if (this.overheat) { state = 'DOWN'; reason = 'OVERHEAT'; }
    else if (this.lastCountAt !== null && now - this.lastCountAt <= RUNNING_WINDOW_MS) state = 'RUNNING';
    else state = 'IDLE';

    if (state !== this.state || reason !== this.reason) {
      this.state = state; this.reason = reason; this.stateChanged = true;
    }

    // Susun pesan baru hanya jika tidak ada pesan yang sedang menunggu konfirmasi
    if (!this.outbox && (this.stateChanged || now - this.lastBuildAt >= SEND_PERIOD_MS)) {
      this.seq += 1;
      this.outbox = {
        machine_id: this.id,
        boot_id: this.bootId,
        seq: this.seq,
        state: this.state,
        reason: this.reason,
        output_delta: this.pendingOut,
        reject_delta: this.pendingRej,
        temperature_c: this.temp,
      };
      this.pendingOut = 0;
      this.pendingRej = 0;
      this.stateChanged = false;
      this.lastBuildAt = now;
      this.nextTryAt = 0;
    }
    if (this.outbox && now >= this.nextTryAt) this.send(now);
  }

  async send(now) {
    const msg = this.outbox;
    this.nextTryAt = now + RETRY_MS;         // jangan kirim paralel; coba lagi nanti jika gagal
    const label = `${this.id} seq=${msg.seq} ${msg.state}${msg.reason ? '/' + msg.reason : ''} +${msg.output_delta}/-${msg.reject_delta} T=${msg.temperature_c}`;
    try {
      if (FLAKY && Math.random() < 0.15) throw new Error('simulasi: jaringan putus sebelum terkirim');
      const res = await fetch(`${BASE_URL}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Key': this.key },
        body: JSON.stringify(msg),
      });
      if (FLAKY && Math.random() < 0.15) throw new Error('simulasi: respons hilang (server sudah menyimpan)');
      if (res.ok || res.status === 400) {
        if (this.outbox === msg) this.outbox = null;
        const j = await res.json().catch(() => ({}));
        console.log(`[${new Date().toLocaleTimeString()}] OK  ${res.status} ${j.status || j.error || ''}  ${label}`);
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] ERR ${res.status}  ${label}  (akan dicoba lagi, seq sama)`);
      }
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString()}] ERR ${e.message}  ${label}  (akan dicoba lagi, seq sama)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Skenario tiap mesin
// ---------------------------------------------------------------------------
// MC-01: produksi lancar, sesekali reject
const mc01 = (t) => ({
  count: Math.random() < 0.6 ? 1 : 0,
  reject: Math.random() < 0.03 ? 1 : 0,
  temp: round1(rand(45, 55)),
});

// MC-02: 45 detik jalan, 45 detik berhenti (IDLE); sensor suhu kadang gagal (null)
const mc02 = (t) => {
  const running = Math.floor(t / 45) % 2 === 0;
  return {
    count: running && Math.random() < 0.4 ? 1 : 0,
    reject: running && Math.random() < 0.05 ? 1 : 0,
    temp: Math.random() < 0.05 ? null : round1(rand(40, 50)),
  };
};

// MC-03: siklus 180 detik. Suhu naik hingga ~75 °C lalu turun -> DOWN (OVERHEAT) lalu pulih
const mc03 = (t) => {
  const c = t % 180;
  let temp;
  if (c < 60) temp = 50;
  else if (c < 100) temp = 50 + (c - 60) * 0.6;      // naik ke 74
  else if (c < 130) temp = 74;                       // tahan
  else if (c < 170) temp = 74 - (c - 130) * 0.5;     // turun ke 54
  else temp = 54;
  return {
    count: Math.random() < 0.5 ? 1 : 0,
    reject: Math.random() < 0.04 ? 1 : 0,
    temp: round1(temp + rand(-0.4, 0.4)),
  };
};

function round1(x) { return Math.round(x * 10) / 10; }

const machines = [
  new SimMachine('MC-01', process.env.DEVICE_KEY_MC01 || 'dev-key-mc01', mc01),
  new SimMachine('MC-02', process.env.DEVICE_KEY_MC02 || 'dev-key-mc02', mc02),
  new SimMachine('MC-03', process.env.DEVICE_KEY_MC03 || 'dev-key-mc03', mc03),
];

console.log(`Simulator -> ${BASE_URL}  | kirim tiap ${SEND_PERIOD_MS / 1000}s${FLAKY ? ' | mode flaky' : ''}. Ctrl+C untuk berhenti.`);
setInterval(() => {
  const now = Date.now();
  machines.forEach((m) => m.tick(now));
}, TICK_MS);

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHTesp.h>
#include <atomic>

// ====================== KONFIGURASI ======================
#define MACHINE_ID   "MC-01"
#define DEVICE_KEY   "dev-key-mc01"
#define SERVER_URL   "https://GANTI-DENGAN-URL-TUNNEL-ANDA/api/ingest"
#define WIFI_SSID    "Wokwi-GUEST"
#define WIFI_PASS    ""
#define WIFI_CHANNEL 6

// Pin (boleh diganti, tulis di README)
const uint8_t PIN_COUNT  = 19;
const uint8_t PIN_REJECT = 21;
const uint8_t PIN_FAULT  = 22;
const uint8_t PIN_DHT    = 4;
const uint8_t PIN_LED_G  = 25;
const uint8_t PIN_LED_Y  = 26;
const uint8_t PIN_LED_R  = 27;
const uint8_t PIN_BUZZER = 13;

// Parameter
const uint32_t DEBOUNCE_MS        = 50;
const uint32_t RUNNING_WINDOW_MS  = 15000;  // RUNNING jika ada hitungan dalam 15 detik terakhir
const uint32_t TEMP_PERIOD_MS     = 2000;   // baca suhu tiap 2 detik
const uint32_t SEND_PERIOD_MS     = 10000;  // kirim berkala tiap 10 detik
const uint32_t RETRY_MS           = 3000;   // jeda kirim ulang jika gagal
const uint32_t WIFI_RETRY_MS      = 10000;  // jeda mencoba sambung ulang WiFi
const uint32_t BEEP_HALF_PERIOD   = 250;    // buzzer DOWN: 250 ms bunyi, 250 ms diam
const float    OVERHEAT_ON_C      = 70.0;   // >= 70 -> DOWN (OVERHEAT)
const float    OVERHEAT_OFF_C     = 65.0;   // baru selesai jika < 65 (hysteresis)

// ====================== TIPE & STATE ======================
enum State  { ST_IDLE, ST_RUNNING, ST_DOWN };
enum Reason { RS_NONE, RS_FAULT_BUTTON, RS_OVERHEAT };

struct Button {
  uint8_t  pin;
  bool     stable;      // level stabil terakhir (HIGH = tidak ditekan, pakai INPUT_PULLUP)
  bool     lastRead;
  uint32_t changedAt;
};
Button btnCount  = {PIN_COUNT,  HIGH, HIGH, 0};
Button btnReject = {PIN_REJECT, HIGH, HIGH, 0};
Button btnFault  = {PIN_FAULT,  HIGH, HIGH, 0};

DHTesp dht;

char     bootId[9];                 // 8 karakter hex acak, baru tiap menyala
uint32_t seqCounter = 0;

uint32_t pendingOutput = 0;         // jumlah sejak pesan sebelumnya
uint32_t pendingReject = 0;
uint32_t lastCountMs   = 0;
bool     hasCounted    = false;

bool     faultActive   = false;
bool     overheat      = false;     // latch dengan hysteresis
bool     tempValid     = false;
float    lastTemp      = 0;

State    curState      = ST_IDLE;
Reason   curReason     = RS_NONE;
bool     stateChanged  = true;      // true -> kirim pesan pertama segera setelah menyala
uint32_t lastTempMs    = 0;
uint32_t lastBuildMs   = 0;

// Kotak keluar (outbox) satu slot, dibagi antara loop() (core 1) dan task jaringan (core 0)
char              outJson[220];
std::atomic<bool> outFull{false};

// ====================== UTIL ======================
const char* stateName(State s) {
  return s == ST_RUNNING ? "RUNNING" : (s == ST_DOWN ? "DOWN" : "IDLE");
}
const char* reasonJson(Reason r) {
  return r == RS_FAULT_BUTTON ? "\"FAULT_BUTTON\"" : (r == RS_OVERHEAT ? "\"OVERHEAT\"" : "null");
}

// true tepat sekali saat tombol DITEKAN (HIGH -> LOW) setelah stabil >= DEBOUNCE_MS
bool buttonPressed(Button &b) {
  bool r = digitalRead(b.pin);
  uint32_t now = millis();
  if (r != b.lastRead) { b.lastRead = r; b.changedAt = now; }
  if ((now - b.changedAt) >= DEBOUNCE_MS && r != b.stable) {
    b.stable = r;
    if (r == LOW) return true;
  }
  return false;
}

// ====================== LOGIKA STATUS ======================
void evaluateState() {
  State  s;
  Reason r = RS_NONE;
  if (faultActive)                                            { s = ST_DOWN; r = RS_FAULT_BUTTON; }
  else if (overheat)                                          { s = ST_DOWN; r = RS_OVERHEAT; }
  else if (hasCounted && (millis() - lastCountMs) <= RUNNING_WINDOW_MS) { s = ST_RUNNING; }
  else                                                        { s = ST_IDLE; }

  if (s != curState || r != curReason) {
    curState = s; curReason = r; stateChanged = true;
    Serial.printf("[STATE] %s%s\n", stateName(s), r == RS_FAULT_BUTTON ? " (FAULT_BUTTON)" : r == RS_OVERHEAT ? " (OVERHEAT)" : "");
  }
}

void readTemperature() {
  TempAndHumidity d = dht.getTempAndHumidity();
  if (dht.getStatus() != DHTesp::ERROR_NONE || isnan(d.temperature)) {
    tempValid = false;              // sensor gagal -> temperature_c = null, BUKAN overheat
    Serial.println("[DHT] gagal baca");
    return;                         // latch overheat dibiarkan apa adanya sampai ada bacaan valid
  }
  tempValid = true;
  lastTemp  = d.temperature;
  if (lastTemp >= OVERHEAT_ON_C)       overheat = true;
  else if (lastTemp < OVERHEAT_OFF_C)  overheat = false;   // 65..69.9 -> tetap seperti sebelumnya
}

// ====================== OUTPUT (LED & BUZZER) ======================
void updateOutputs() {
  digitalWrite(PIN_LED_G, curState == ST_RUNNING);
  digitalWrite(PIN_LED_Y, curState == ST_IDLE);
  digitalWrite(PIN_LED_R, curState == ST_DOWN);

  static bool beeping = false;
  if (curState == ST_DOWN) {
    bool on = ((millis() / BEEP_HALF_PERIOD) % 2) == 0;     // putus-putus tanpa delay()
    if (on && !beeping)      { tone(PIN_BUZZER, 2000); beeping = true; }
    else if (!on && beeping) { noTone(PIN_BUZZER);     beeping = false; }
  } else if (beeping) {
    noTone(PIN_BUZZER); beeping = false;
  }
}

// ====================== PESAN ======================
// Dibuat sekali, lalu dikirim ulang apa adanya (seq & delta sama) sampai server menjawab.
void buildMessage() {
  seqCounter++;
  char temp[12];
  if (tempValid) snprintf(temp, sizeof(temp), "%.1f", lastTemp); else strcpy(temp, "null");

  snprintf(outJson, sizeof(outJson),
           "{\"machine_id\":\"%s\",\"boot_id\":\"%s\",\"seq\":%lu,\"state\":\"%s\",\"reason\":%s,"
           "\"output_delta\":%lu,\"reject_delta\":%lu,\"temperature_c\":%s}",
           MACHINE_ID, bootId, (unsigned long)seqCounter, stateName(curState), reasonJson(curReason),
           (unsigned long)pendingOutput, (unsigned long)pendingReject, temp);

  pendingOutput = 0;
  pendingReject = 0;
  stateChanged  = false;
  lastBuildMs   = millis();
  outFull.store(true, std::memory_order_release);   // serahkan ke task jaringan
  Serial.printf("[MSG] %s\n", outJson);
}

// ====================== JARINGAN (task di core 0) ======================
void ensureWifi() {
  static uint32_t lastAttempt = 0;
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastAttempt != 0 && (millis() - lastAttempt) < WIFI_RETRY_MS) return;
  lastAttempt = millis();
  Serial.println("[WiFi] menyambung / menyambung ulang...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
}

int postJson(const char* body) {
  HTTPClient http;
  WiFiClientSecure secure;
  WiFiClient plain;
  bool ok;
  if (strncmp(SERVER_URL, "https", 5) == 0) {
    secure.setInsecure();           // prototype saja; untuk produksi pasang sertifikat CA
    ok = http.begin(secure, SERVER_URL);
  } else {
    ok = http.begin(plain, SERVER_URL);
  }
  if (!ok) return -1;
  http.setConnectTimeout(4000);
  http.setTimeout(4000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.POST((uint8_t*)body, strlen(body));
  http.end();
  return code;
}

void netTask(void*) {
  uint32_t nextTry = 0;
  for (;;) {
    ensureWifi();
    if (outFull.load(std::memory_order_acquire) && WiFi.status() == WL_CONNECTED
        && (int32_t)(millis() - nextTry) >= 0) {
      int code = postJson(outJson);
      Serial.printf("[HTTP] %d\n", code);
      if ((code >= 200 && code < 300) || code == 400) {
        // 2xx: tersimpan (atau duplikat). 400: payload ditolak permanen, jangan diulang selamanya.
        outFull.store(false, std::memory_order_release);
      } else {
        nextTry = millis() + RETRY_MS;     // putus/timeout/401/5xx -> ulangi pesan yang sama
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ====================== SETUP & LOOP ======================
void setup() {
  Serial.begin(115200);
  Serial.printf("\n[BOOT] reset reason = %d\n", (int)esp_reset_reason());   // 1=power-on, 4=panic, 15=brownout

  pinMode(PIN_COUNT,  INPUT_PULLUP);
  pinMode(PIN_REJECT, INPUT_PULLUP);
  pinMode(PIN_FAULT,  INPUT_PULLUP);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_Y, OUTPUT);
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  snprintf(bootId, sizeof(bootId), "%08x", (unsigned)esp_random());
  Serial.printf("[BOOT] machine=%s boot_id=%s\n", MACHINE_ID, bootId);

  dht.setup(PIN_DHT, DHTesp::DHT22);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);

  // setup() tidak menunggu WiFi; sambung & kirim ditangani task jaringan
  // Pin ke core 1: POST HTTPS memblokir task, core 0 harus tetap melayani IDLE (cegah task watchdog reset)
  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 1);

  lastTempMs = millis() - TEMP_PERIOD_MS;   // baca suhu segera
}

void loop() {
  uint32_t now = millis();

  if (buttonPressed(btnCount))  { pendingOutput++; lastCountMs = now; hasCounted = true; }
  if (buttonPressed(btnReject)) { pendingReject++; }
  if (buttonPressed(btnFault))  { faultActive = !faultActive; }   // tekan = aktif, tekan lagi = selesai

  if ((now - lastTempMs) >= TEMP_PERIOD_MS) { lastTempMs = now; readTemperature(); }

  evaluateState();
  updateOutputs();

  // Susun pesan baru hanya jika slot kosong (pesan sebelumnya sudah terkonfirmasi server).
  if (!outFull.load(std::memory_order_acquire)
      && (stateChanged || (now - lastBuildMs) >= SEND_PERIOD_MS)) {
    buildMessage();
  }
}

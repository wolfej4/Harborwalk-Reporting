// Harborwalk Reporting — single-page app
// Storage: REST API backed by a JSON file in a Docker volume.
// Weather: OpenMeteo (no key required).

const DEFAULT_SETTINGS = {
  label: "Destin Harborwalk",
  lat: 30.3935,
  lon: -86.4958,
  tz: "America/Chicago",
};

// "Today" in the configured timezone, formatted YYYY-MM-DD. Treats "auto",
// empty, or invalid IANA names as the browser's local timezone — never UTC,
// since picking UTC would re-introduce the after-close-shows-tomorrow bug.
function todayInTz(tz) {
  const wanted = tz && tz !== "auto" ? tz : undefined;
  const tryFormat = (timeZone) => {
    const opts = { year: "numeric", month: "2-digit", day: "2-digit" };
    if (timeZone) opts.timeZone = timeZone;
    const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  try {
    return tryFormat(wanted);
  } catch {
    // Fall back to the browser's local zone — Intl with no timeZone uses it.
    return tryFormat(undefined);
  }
}

// YYYY-MM-DD → Date at UTC midnight on that day. Used as a label-only Date for
// arithmetic; we never compare across time zones.
function parseDateUTC(s) {
  return new Date(`${s}T00:00:00Z`);
}

// --------------------- storage (API-backed, with in-memory cache) ---------------------

let RECORDS = [];
let SETTINGS = { ...DEFAULT_SETTINGS };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function bootstrap() {
  try {
    [RECORDS, SETTINGS] = await Promise.all([api("/api/records"), api("/api/settings")]);
    // Self-heal a legacy tz of "auto" (which Intl can't honor and would
    // silently fall back to UTC, flipping "today" forward after close).
    if (!SETTINGS.tz || SETTINGS.tz === "auto") {
      SETTINGS = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ ...SETTINGS, tz: DEFAULT_SETTINGS.tz }),
      });
    }
  } catch (e) {
    showBanner(`Could not reach the server: ${e.message}`);
  }
}

function loadRecords() {
  return RECORDS;
}

async function upsertRecord(row) {
  const saved = await api(`/api/records/${row.date}`, {
    method: "PUT",
    body: JSON.stringify(row),
  });
  RECORDS = RECORDS.filter((r) => r.date !== row.date);
  RECORDS.push(saved);
  RECORDS.sort((a, b) => a.date.localeCompare(b.date));
}

async function deleteRecord(date) {
  await api(`/api/records/${date}`, { method: "DELETE" });
  RECORDS = RECORDS.filter((r) => r.date !== date);
}

async function wipeAllRecords() {
  await api("/api/records", { method: "DELETE" });
  RECORDS = [];
}

async function bulkImport(rows) {
  await api("/api/records/bulk", { method: "POST", body: JSON.stringify(rows) });
  RECORDS = await api("/api/records");
}

function loadSettings() {
  return SETTINGS;
}

async function saveSettings(s) {
  SETTINGS = await api("/api/settings", { method: "PUT", body: JSON.stringify(s) });
}

function showBanner(msg) {
  let el = document.getElementById("conn-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "conn-banner";
    el.style.cssText =
      "background:#fef2f2;color:#991b1b;border-bottom:1px solid #fecaca;padding:10px 16px;font-size:13px;text-align:center;";
    document.body.insertBefore(el, document.body.firstChild);
  }
  el.textContent = msg;
}

// --------------------- weather ---------------------

// Score a day 1–10 from full-day averages (the tool is run after close,
// so the report should reflect what the day actually felt like, not just
// the peak high or peak gust).
// 10 = ideal restaurant/retail weather (warm, dry, calm, mostly sunny).
function scoreWeather({ tAvgF, precipIn, windAvgMph, cloudAvgPct }) {
  let score = 10;

  // Distance from a 75°F daily average — 10° off ≈ 1 point.
  if (tAvgF != null) score -= Math.abs(tAvgF - 75) * 0.1;

  // Precipitation is a big revenue killer.
  if (precipIn > 0) score -= Math.min(5, precipIn * 5);

  // Sustained wind above ~12 mph (avg, not gust) chips away at outdoor seating.
  if (windAvgMph != null && windAvgMph > 12) {
    score -= Math.min(3, (windAvgMph - 12) * 0.25);
  }

  // Heavy overcast — small penalty.
  if (cloudAvgPct != null) score -= (cloudAvgPct / 100) * 1.5;

  // Daily-average temperature extremes.
  if (tAvgF != null && tAvgF < 45) score -= 2;
  if (tAvgF != null && tAvgF < 35) score -= 2;
  if (tAvgF != null && tAvgF > 90) score -= 2;

  score = Math.max(1, Math.min(10, score));
  return Math.round(score * 10) / 10;
}

async function fetchWeather(dateStr, settings) {
  const today = todayInTz(settings.tz);
  const isPast = dateStr < today;
  const base = isPast
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";

  // Pull hourly so we can average across the day, plus daily for the
  // high/low we still display alongside the average.
  const params = new URLSearchParams({
    latitude: String(settings.lat),
    longitude: String(settings.lon),
    start_date: dateStr,
    end_date: dateStr,
    hourly: [
      "temperature_2m",
      "precipitation",
      "wind_speed_10m",
      "cloud_cover",
      "weather_code",
    ].join(","),
    daily: ["temperature_2m_max", "temperature_2m_min"].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: settings.tz || "auto",
  });

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
  const data = await res.json();
  const h = data.hourly;
  const d = data.daily;
  if (!h || !h.time || !h.time.length) throw new Error("No weather data for that date");

  const clean = (arr) => (arr || []).filter((v) => v != null);
  const mean = (arr) => {
    const v = clean(arr);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const sum = (arr) => clean(arr).reduce((a, b) => a + b, 0);
  const dominant = (arr) => {
    const counts = new Map();
    for (const c of clean(arr)) counts.set(c, (counts.get(c) || 0) + 1);
    let best = null;
    let n = 0;
    for (const [k, v] of counts) if (v > n) (best = k), (n = v);
    return best;
  };

  const out = {
    tAvgF: mean(h.temperature_2m),
    tMaxF: d?.temperature_2m_max?.[0] ?? null,
    tMinF: d?.temperature_2m_min?.[0] ?? null,
    precipIn: sum(h.precipitation),
    windAvgMph: mean(h.wind_speed_10m),
    cloudAvgPct: mean(h.cloud_cover),
    code: dominant(h.weather_code),
  };
  out.score = scoreWeather(out);
  out.summary = describeWeather(out);
  return out;
}

const WMO = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ hail",
  99: "Severe thunderstorm",
};

function describeWeather(w) {
  const cond = WMO[w.code] || "—";
  const avg = w.tAvgF != null ? `${Math.round(w.tAvgF)}°F avg` : "—";
  const range =
    w.tMaxF != null && w.tMinF != null
      ? ` (${Math.round(w.tMinF)}–${Math.round(w.tMaxF)}°F)`
      : "";
  const wind = w.windAvgMph != null ? `, ${Math.round(w.windAvgMph)} mph wind` : "";
  const p = w.precipIn ? `, ${w.precipIn.toFixed(2)} in rain` : "";
  return `${cond}, ${avg}${range}${wind}${p}`;
}

function weatherColor(score) {
  if (score >= 8) return "#16a34a";
  if (score >= 6) return "#65a30d";
  if (score >= 4) return "#d97706";
  return "#dc2626";
}

// --------------------- formatting ---------------------

const fmtMoney = (n) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtNum = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const fmtPct = (n) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

function totalRev(r) {
  return (r.lunchRevenue || 0) + (r.dinnerRevenue || 0) + (r.retailRevenue || 0);
}

// --------------------- view switching ---------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    const v = document.getElementById(`view-${btn.dataset.view}`);
    v.classList.add("active");
    if (btn.dataset.view === "records") renderRecords();
    if (btn.dataset.view === "metrics") renderMetrics();
    if (btn.dataset.view === "settings") renderSettings();
  });
});

// --------------------- entry form ---------------------

const form = document.getElementById("entry-form");
const dateEl = document.getElementById("f-date");
const weatherEl = document.getElementById("f-weather");
const weatherDetail = document.getElementById("weather-detail");
const entryMsg = document.getElementById("entry-msg");

dateEl.value = todayInTz(SETTINGS.tz);

let lastWeatherFetch = null; // keep raw weather to attach to record
let editingOriginal = null; // when set, the form is editing this record

const editBanner = document.getElementById("edit-banner");
const editDateLabel = document.getElementById("edit-date-label");
const entrySubmit = document.getElementById("entry-submit");
const entryHeading = document.getElementById("entry-heading");

function enterEditMode(rec) {
  editingOriginal = rec;
  document.getElementById("f-date").value = rec.date;
  document.getElementById("f-date").readOnly = true;
  document.getElementById("f-weather").value = rec.weather ?? "";
  document.getElementById("f-lunch-rev").value = rec.lunchRevenue ?? "";
  document.getElementById("f-lunch-cov").value = rec.lunchCovers ?? "";
  document.getElementById("f-dinner-rev").value = rec.dinnerRevenue ?? "";
  document.getElementById("f-dinner-cov").value = rec.dinnerCovers ?? "";
  document.getElementById("f-retail-rev").value = rec.retailRevenue ?? "";
  document.getElementById("f-retail-txn").value = rec.retailTxns ?? "";
  weatherDetail.textContent = rec.weatherDetail?.summary || "";
  lastWeatherFetch = null; // re-fetch only if user clicks the button
  editDateLabel.textContent = rec.date;
  editBanner.hidden = false;
  entrySubmit.textContent = "Save Changes";
  entryHeading.textContent = "Edit Daily Report";
  entryMsg.textContent = "";
  // Switch to the entry view
  document.querySelector('.tab[data-view="entry"]').click();
  document.getElementById("f-weather").focus();
}

function exitEditMode({ keepValues = false } = {}) {
  editingOriginal = null;
  editBanner.hidden = true;
  entrySubmit.textContent = "Save Report";
  entryHeading.textContent = "New Daily Report";
  document.getElementById("f-date").readOnly = false;
  if (!keepValues) {
    form.reset();
    dateEl.value = todayInTz(SETTINGS.tz);
    weatherDetail.textContent = "";
    lastWeatherFetch = null;
  }
}

document.getElementById("cancel-edit").addEventListener("click", () => exitEditMode());

form.addEventListener("reset", () => {
  // Run after the native reset clears fields.
  setTimeout(() => {
    if (editingOriginal) exitEditMode();
    else dateEl.value = todayInTz(SETTINGS.tz);
  }, 0);
});

document.getElementById("fetch-weather").addEventListener("click", async () => {
  const date = dateEl.value;
  if (!date) {
    weatherDetail.textContent = "Pick a date first.";
    return;
  }
  weatherDetail.textContent = "Fetching…";
  try {
    const w = await fetchWeather(date, loadSettings());
    weatherEl.value = w.score;
    weatherDetail.textContent = w.summary;
    lastWeatherFetch = w;
  } catch (e) {
    weatherDetail.textContent = `Error: ${e.message}`;
  }
});

dateEl.addEventListener("change", () => {
  // invalidate cached fetch when date changes
  lastWeatherFetch = null;
  weatherDetail.textContent = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  // readonly inputs aren't disabled, but FormData on a date input still
  // returns its value; in edit mode we lock the field so this matches the
  // original anyway.
  const rec = {
    date: editingOriginal ? editingOriginal.date : fd.get("date"),
    weather: parseFloat(fd.get("weather")),
    lunchRevenue: parseFloat(fd.get("lunchRevenue")) || 0,
    lunchCovers: parseInt(fd.get("lunchCovers")) || 0,
    dinnerRevenue: parseFloat(fd.get("dinnerRevenue")) || 0,
    dinnerCovers: parseInt(fd.get("dinnerCovers")) || 0,
    retailRevenue: parseFloat(fd.get("retailRevenue")) || 0,
    retailTxns: parseInt(fd.get("retailTxns")) || 0,
    weatherDetail: lastWeatherFetch
      ? {
          tAvgF: lastWeatherFetch.tAvgF,
          tMaxF: lastWeatherFetch.tMaxF,
          tMinF: lastWeatherFetch.tMinF,
          precipIn: lastWeatherFetch.precipIn,
          windAvgMph: lastWeatherFetch.windAvgMph,
          cloudAvgPct: lastWeatherFetch.cloudAvgPct,
          code: lastWeatherFetch.code,
          summary: lastWeatherFetch.summary,
        }
      : editingOriginal?.weatherDetail || null,
  };
  const wasEditing = !!editingOriginal;
  try {
    await upsertRecord(rec);
    entryMsg.textContent = wasEditing
      ? `Updated report for ${rec.date}.`
      : `Saved report for ${rec.date}.`;
    entryMsg.className = "msg ok";
    exitEditMode();
  } catch (err) {
    entryMsg.textContent = `Save failed: ${err.message}`;
    entryMsg.className = "msg err";
  }
  setTimeout(() => (entryMsg.textContent = ""), 3000);
});

// --------------------- records view ---------------------

function renderRecords() {
  const tbody = document.querySelector("#records-table tbody");
  const rows = loadRecords().slice().reverse();
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted">No records yet. Add one on the Daily Entry tab.</td></tr>`;
    return;
  }
  for (const r of rows) {
    const tr = document.createElement("tr");
    const wColor = weatherColor(r.weather);
    const summary = r.weatherDetail?.summary || "";
    tr.innerHTML = `
      <td>${r.date}</td>
      <td><span class="weather-pill" style="background:${wColor}" title="${summary}">${r.weather}</span></td>
      <td>${fmtMoney(r.lunchRevenue)}</td>
      <td>${fmtNum(r.lunchCovers)}</td>
      <td>${fmtMoney(r.dinnerRevenue)}</td>
      <td>${fmtNum(r.dinnerCovers)}</td>
      <td>${fmtMoney(r.retailRevenue)}</td>
      <td>${fmtNum(r.retailTxns)}</td>
      <td><strong>${fmtMoney(totalRev(r))}</strong></td>
      <td>
        <div class="row-actions">
          <button class="link" data-edit="${r.date}">Edit</button>
          <button class="link" data-del="${r.date}">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const rec = RECORDS.find((r) => r.date === b.dataset.edit);
      if (rec) enterEditMode(rec);
    })
  );
  tbody.querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm(`Delete record for ${b.dataset.del}?`)) {
        try {
          await deleteRecord(b.dataset.del);
          if (editingOriginal && editingOriginal.date === b.dataset.del) exitEditMode();
          renderRecords();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      }
    })
  );
}

document.getElementById("export-csv").addEventListener("click", () => {
  const rows = loadRecords();
  const header = [
    "date",
    "weather",
    "lunchRevenue",
    "lunchCovers",
    "dinnerRevenue",
    "dinnerCovers",
    "retailRevenue",
    "retailTxns",
    "tAvgF",
    "tMaxF",
    "tMinF",
    "precipIn",
    "windAvgMph",
    "cloudAvgPct",
    "weatherCode",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const w = r.weatherDetail || {};
    lines.push(
      [
        r.date,
        r.weather,
        r.lunchRevenue,
        r.lunchCovers,
        r.dinnerRevenue,
        r.dinnerCovers,
        r.retailRevenue,
        r.retailTxns,
        w.tAvgF ?? "",
        w.tMaxF ?? "",
        w.tMinF ?? "",
        w.precipIn ?? "",
        w.windAvgMph ?? w.windMph ?? "",
        w.cloudAvgPct ?? w.cloudPct ?? "",
        w.code ?? "",
      ].join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "harborwalk-reports.csv";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-csv-btn").addEventListener("click", () => {
  document.getElementById("import-csv").click();
});

// --------------------- CSV import (verify-then-import flow) ---------------------

// Targets the import can map columns onto. `aliases` are matched case-insensitively
// against the header text after stripping non-alphanumerics for fuzzy auto-mapping.
const IMPORT_TARGETS = [
  { key: "date",          label: "Date (YYYY-MM-DD or MM/DD/YYYY)", required: true,
    aliases: ["date", "day", "reportdate", "reportingdate", "businessdate"] },
  { key: "weather",       label: "Weather rank (1-10)",
    aliases: ["weather", "weatherrank", "rank", "weatherscore", "score"] },
  { key: "lunchRevenue",  label: "Lunch revenue",
    aliases: ["lunchrevenue", "lunchrev", "lunchsales", "lunch"] },
  { key: "lunchCovers",   label: "Lunch covers",
    aliases: ["lunchcovers", "lunchcov", "lunchguests"] },
  { key: "dinnerRevenue", label: "Dinner revenue",
    aliases: ["dinnerrevenue", "dinnerrev", "dinnersales", "dinner"] },
  { key: "dinnerCovers",  label: "Dinner covers",
    aliases: ["dinnercovers", "dinnercov", "dinnerguests"] },
  { key: "retailRevenue", label: "Retail revenue",
    aliases: ["retailrevenue", "retailrev", "retailsales", "retail"] },
  { key: "retailTxns",    label: "Retail transactions",
    aliases: ["retailtxns", "retailtransactions", "retailtx", "retailcount"] },
  { key: "weatherDetail.tAvgF",       label: "Weather: avg temp (°F)",
    aliases: ["tavgf", "avgtemp", "avgtemperature", "tempavg", "temperature"] },
  { key: "weatherDetail.tMaxF",       label: "Weather: high temp (°F)",
    aliases: ["tmaxf", "tempmax", "high", "maxtemp", "hightemp"] },
  { key: "weatherDetail.tMinF",       label: "Weather: low temp (°F)",
    aliases: ["tminf", "tempmin", "low", "mintemp", "lowtemp"] },
  { key: "weatherDetail.precipIn",    label: "Weather: precipitation (in)",
    aliases: ["precipin", "precip", "precipitation", "rain", "rainfall"] },
  { key: "weatherDetail.windAvgMph",  label: "Weather: avg wind (mph)",
    aliases: ["windavgmph", "avgwind", "wind", "windmph", "windspeed"] },
  { key: "weatherDetail.cloudAvgPct", label: "Weather: cloud cover (%)",
    aliases: ["cloudavgpct", "cloud", "cloudpct", "cloudcover"] },
  { key: "weatherDetail.code",        label: "Weather: WMO code",
    aliases: ["weathercode", "wmocode", "wmo", "code"] },
];

const TARGET_BY_KEY = Object.fromEntries(IMPORT_TARGETS.map((f) => [f.key, f]));

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ALIAS_INDEX = (() => {
  const m = new Map();
  for (const f of IMPORT_TARGETS) {
    m.set(normHeader(f.key), f.key);
    for (const a of f.aliases) m.set(normHeader(a), f.key);
  }
  return m;
})();

function autoMap(header) {
  return ALIAS_INDEX.get(normHeader(header)) || null;
}

// Auto-detect comma vs tab vs semicolon by counting separators in the first
// non-quoted line. Excel exports often use \t or ; depending on the locale.
function detectDelimiter(text) {
  const sample = text.slice(0, 4096).split(/\r?\n/).filter(Boolean)[0] || "";
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let inQuotes = false;
  for (const c of sample) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
}

// RFC4180-ish CSV parser: handles quoted fields, escaped quotes, CRLF, BOM.
// Delimiter is auto-detected (comma, tab, or semicolon).
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      field += c;
    } else {
      if (c === '"' && field === "") { inQuotes = true; continue; }
      if (c === delim) { row.push(field); field = ""; continue; }
      if (c === "\r") continue;
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Drop rows that are entirely empty.
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

function pad2(n) { return String(n).padStart(2, "0"); }

function parseImportNumber(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/[$,\s]/g, "").replace(/%$/, "");
  if (t === "" || t === "-") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function parseImportInt(s) {
  const n = parseImportNumber(s);
  return n == null ? null : Math.round(n);
}

function parseImportDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yyyy = m[3].length === 2 ? (parseInt(m[3], 10) >= 70 ? "19" : "20") + m[3] : m[3];
    return `${yyyy}-${pad2(m[1])}-${pad2(m[2])}`;
  }
  return null;
}

function buildImportRecord(rowObj, mapping) {
  const rec = {};
  let detail = null;
  for (const [csvCol, target] of Object.entries(mapping)) {
    if (!target) continue;
    const raw = rowObj[csvCol];
    if (target === "date") {
      const d = parseImportDate(raw);
      if (d) rec.date = d;
    } else if (target === "weather") {
      const n = parseImportNumber(raw);
      if (n != null) rec.weather = n;
    } else if (target.startsWith("weatherDetail.")) {
      const sub = target.split(".")[1];
      const v = sub === "code" ? parseImportInt(raw) : parseImportNumber(raw);
      if (v != null) (detail ??= {})[sub] = v;
    } else if (target === "lunchCovers" || target === "dinnerCovers" || target === "retailTxns") {
      rec[target] = parseImportInt(raw) ?? 0;
    } else {
      rec[target] = parseImportNumber(raw) ?? 0;
    }
  }
  if (detail) rec.weatherDetail = detail;
  return rec;
}

function validateImportRecord(rec) {
  const errs = [];
  if (!rec.date) errs.push("missing or invalid date");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) errs.push("date not YYYY-MM-DD");
  return errs;
}

let importState = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const importModal = document.getElementById("import-modal");
const importColumnsBody = document.querySelector("#import-columns tbody");
const importPreviewHead = document.querySelector("#import-preview thead");
const importPreviewBody = document.querySelector("#import-preview tbody");
const importPreviewNote = document.getElementById("import-preview-note");
const importMeta = document.getElementById("import-meta");
const importErrorsEl = document.getElementById("import-errors");
const importSummaryEl = document.getElementById("import-summary");
const importConfirmBtn = document.getElementById("import-confirm");
const importOverwriteEl = document.getElementById("import-overwrite");

function openImportModal() { importModal.hidden = false; renderImportModal(); }
function closeImportModal() { importModal.hidden = true; importState = null; }

importModal.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", closeImportModal)
);

document.getElementById("import-csv").addEventListener("change", async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCSV(text);
    if (rows.length < 2) {
      alert("CSV looks empty or has only a header row.");
      return;
    }
    const headers = rows[0].map((h) => String(h).trim());
    const dataRows = rows.slice(1);
    const mapping = {};
    const include = {};
    for (const h of headers) {
      const auto = autoMap(h);
      mapping[h] = auto;
      include[h] = !!auto;
    }
    importState = { filename: file.name, headers, dataRows, mapping, include };
    openImportModal();
  } catch (err) {
    console.error(err);
    alert(`Could not read CSV: ${err.message}`);
  } finally {
    // Clear AFTER reading so re-picking the same file still triggers change.
    input.value = "";
  }
});

// Catch anything that escapes the handlers and show it to the user instead of
// failing silently in the console — makes "doesn't work" reports diagnosable.
window.addEventListener("error", (ev) => {
  showBanner(`Script error: ${ev.message || ev.error?.message || "unknown"}`);
});
window.addEventListener("unhandledrejection", (ev) => {
  showBanner(`Unhandled error: ${ev.reason?.message || ev.reason || "unknown"}`);
});

function effectiveMapping() {
  const m = {};
  for (const h of importState.headers) {
    if (importState.include[h] && importState.mapping[h]) m[h] = importState.mapping[h];
  }
  return m;
}

function renderImportModal() {
  const s = importState;
  importMeta.textContent = `${s.filename} — ${s.dataRows.length} data rows, ${s.headers.length} columns`;

  importColumnsBody.innerHTML = "";
  s.headers.forEach((h, idx) => {
    const sample = (s.dataRows.find((r) => String(r[idx] ?? "").trim() !== "") || [])[idx] ?? "";
    const opts = [
      `<option value="">(skip)</option>`,
      ...IMPORT_TARGETS.map(
        (f) =>
          `<option value="${f.key}"${s.mapping[h] === f.key ? " selected" : ""}>${escapeHtml(
            f.label
          )}${f.required ? " *" : ""}</option>`
      ),
    ].join("");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="narrow"><input type="checkbox" data-idx="${idx}"${s.include[h] ? " checked" : ""} aria-label="Include ${escapeHtml(h)}"></td>
      <td><code>${escapeHtml(h)}</code></td>
      <td><select data-idx="${idx}">${opts}</select></td>
      <td class="muted">${escapeHtml(String(sample).slice(0, 60))}</td>
    `;
    importColumnsBody.appendChild(tr);
  });

  importColumnsBody.querySelectorAll('input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener("change", () => {
      const h = s.headers[parseInt(cb.dataset.idx, 10)];
      s.include[h] = cb.checked;
      renderImportPreview();
    })
  );
  importColumnsBody.querySelectorAll("select").forEach((sel) =>
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const h = s.headers[idx];
      s.mapping[h] = sel.value || null;
      // Auto-toggle the include checkbox when a mapping is chosen or cleared.
      const cb = importColumnsBody.querySelector(`input[type="checkbox"][data-idx="${idx}"]`);
      cb.checked = !!sel.value;
      s.include[h] = !!sel.value;
      renderImportPreview();
    })
  );

  renderImportPreview();
}

function renderImportPreview() {
  const s = importState;
  const m = effectiveMapping();
  const targetKeys = [...new Set(Object.values(m))];

  if (!targetKeys.length || !targetKeys.includes("date")) {
    importPreviewHead.innerHTML = "";
    importPreviewBody.innerHTML = `<tr><td class="muted">${
      targetKeys.length ? "Map a column to <strong>Date</strong> to preview." : "No columns selected."
    }</td></tr>`;
    importPreviewNote.textContent = "";
    importErrorsEl.textContent = "";
    importSummaryEl.textContent = "";
    importConfirmBtn.disabled = true;
    s.records = [];
    s.validRecords = [];
    return;
  }

  importPreviewHead.innerHTML =
    "<tr>" +
    targetKeys.map((k) => `<th>${escapeHtml(TARGET_BY_KEY[k]?.label || k)}</th>`).join("") +
    "</tr>";

  const records = [];
  const errors = [];
  for (let i = 0; i < s.dataRows.length; i++) {
    const arr = s.dataRows[i];
    const obj = {};
    s.headers.forEach((h, j) => (obj[h] = arr[j]));
    const rec = buildImportRecord(obj, m);
    const errs = validateImportRecord(rec);
    records.push({ rec, errs, lineNo: i + 2 });
    if (errs.length) errors.push(`Line ${i + 2}: ${errs.join(", ")}`);
  }

  const validRecords = records.filter((r) => !r.errs.length).map((r) => r.rec);
  // Dedupe by date so a single import can't overwrite itself row-by-row.
  const dedup = new Map();
  for (const r of validRecords) dedup.set(r.date, r);
  s.validRecords = [...dedup.values()];
  s.records = records;

  const previewRows = records.slice(0, 10);
  importPreviewNote.textContent = `(showing first ${previewRows.length} of ${records.length})`;
  importPreviewBody.innerHTML = previewRows
    .map(({ rec, errs }) => {
      const cells = targetKeys
        .map((k) => {
          let v;
          if (k.startsWith("weatherDetail.")) v = rec.weatherDetail?.[k.split(".")[1]];
          else v = rec[k];
          return `<td>${v == null || v === "" ? '<span class="muted">—</span>' : escapeHtml(String(v))}</td>`;
        })
        .join("");
      return `<tr style="${errs.length ? "background:#fef2f2" : ""}">${cells}</tr>`;
    })
    .join("");

  const errCount = records.length - s.validRecords.length;
  importSummaryEl.innerHTML = `<strong>${s.validRecords.length}</strong> ready to import${
    errCount ? ` &middot; <span style="color:var(--bad)">${errCount} skipped</span>` : ""
  }`;
  importErrorsEl.textContent = errors.slice(0, 6).join("\n") + (errors.length > 6 ? `\n…and ${errors.length - 6} more` : "");
  importConfirmBtn.disabled = !s.validRecords.length;
}

importConfirmBtn.addEventListener("click", async () => {
  const s = importState;
  let toImport = s.validRecords;
  if (!importOverwriteEl.checked) {
    const existing = new Set(RECORDS.map((r) => r.date));
    toImport = toImport.filter((r) => !existing.has(r.date));
  }
  if (!toImport.length) {
    alert("Nothing to import — all rows would be skipped.");
    return;
  }
  importConfirmBtn.disabled = true;
  try {
    await bulkImport(toImport);
    closeImportModal();
    renderRecords();
    renderMetrics();
    alert(`Imported ${toImport.length} records.`);
  } catch (err) {
    importConfirmBtn.disabled = false;
    alert(`Import failed: ${err.message}`);
  }
});

// --------------------- metrics view ---------------------

const aFrom = document.getElementById("a-from");
const aTo = document.getElementById("a-to");
const bFrom = document.getElementById("b-from");
const bTo = document.getElementById("b-to");

[aFrom, aTo, bFrom, bTo].forEach((el) => el.addEventListener("change", renderMetrics));

document.querySelectorAll(".presets [data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function applyPreset(p) {
  // "Today" is the calendar date in the configured timezone (e.g. Chicago),
  // anchored to UTC midnight so the rest of the math is plain integer days.
  const today = parseDateUTC(todayInTz(SETTINGS.tz));
  const yesterday = addDays(today, -1);

  if (p === "last7") {
    aFrom.value = isoDate(addDays(yesterday, -6));
    aTo.value = isoDate(yesterday);
    bFrom.value = isoDate(addDays(yesterday, -13));
    bTo.value = isoDate(addDays(yesterday, -7));
  } else if (p === "last30") {
    aFrom.value = isoDate(addDays(yesterday, -29));
    aTo.value = isoDate(yesterday);
    bFrom.value = isoDate(addDays(yesterday, -59));
    bTo.value = isoDate(addDays(yesterday, -30));
  } else if (p === "mtd") {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const day = today.getUTCDate();
    aFrom.value = isoDate(first);
    aTo.value = isoDate(yesterday);
    const prevFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const prevSame = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, day - 1));
    bFrom.value = isoDate(prevFirst);
    bTo.value = isoDate(prevSame);
  } else if (p === "ytd") {
    const first = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    aFrom.value = isoDate(first);
    aTo.value = isoDate(yesterday);
    const prevFirst = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
    const prevSame = new Date(
      Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() - 1)
    );
    bFrom.value = isoDate(prevFirst);
    bTo.value = isoDate(prevSame);
  }
  renderMetrics();
}

function inRange(rec, from, to) {
  if (!from || !to) return false;
  return rec.date >= from && rec.date <= to;
}

function aggregate(rows) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const days = rows.length;
  const lunchRevenue = sum("lunchRevenue");
  const lunchCovers = sum("lunchCovers");
  const dinnerRevenue = sum("dinnerRevenue");
  const dinnerCovers = sum("dinnerCovers");
  const retailRevenue = sum("retailRevenue");
  const retailTxns = sum("retailTxns");
  const totalRevenue = lunchRevenue + dinnerRevenue + retailRevenue;
  const totalCovers = lunchCovers + dinnerCovers;
  const weatherAvg = days ? sum("weather") / days : 0;
  return {
    days,
    lunchRevenue,
    lunchCovers,
    dinnerRevenue,
    dinnerCovers,
    retailRevenue,
    retailTxns,
    totalRevenue,
    totalCovers,
    weatherAvg,
    avgCheckLunch: lunchCovers ? lunchRevenue / lunchCovers : 0,
    avgCheckDinner: dinnerCovers ? dinnerRevenue / dinnerCovers : 0,
    avgRetailTxn: retailTxns ? retailRevenue / retailTxns : 0,
  };
}

function renderSummary(A, B) {
  const tbody = document.querySelector("#summary-table tbody");
  const fields = [
    ["Days reported", "days", fmtNum],
    ["Avg weather rank", "weatherAvg", (n) => n.toFixed(1)],
    ["Lunch revenue", "lunchRevenue", fmtMoney],
    ["Lunch covers", "lunchCovers", fmtNum],
    ["Avg lunch check", "avgCheckLunch", fmtMoney],
    ["Dinner revenue", "dinnerRevenue", fmtMoney],
    ["Dinner covers", "dinnerCovers", fmtNum],
    ["Avg dinner check", "avgCheckDinner", fmtMoney],
    ["Retail revenue", "retailRevenue", fmtMoney],
    ["Retail transactions", "retailTxns", fmtNum],
    ["Avg retail ticket", "avgRetailTxn", fmtMoney],
    ["Total revenue", "totalRevenue", fmtMoney],
    ["Total covers", "totalCovers", fmtNum],
  ];
  tbody.innerHTML = "";
  for (const [label, key, fmt] of fields) {
    const a = A[key];
    const b = B[key];
    const delta = a - b;
    const pct = b ? (delta / b) * 100 : null;
    const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${label}</td>
      <td>${fmt(a)}</td>
      <td>${fmt(b)}</td>
      <td class="${cls}">${fmt(delta)}</td>
      <td class="${cls}">${fmtPct(pct)}</td>
    `;
    tbody.appendChild(tr);
  }
}

const charts = {};
function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function dailyTotals(rows) {
  return rows
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      revenue: totalRev(r),
      covers: (r.lunchCovers || 0) + (r.dinnerCovers || 0),
      weather: r.weather,
    }));
}

function renderCharts(rowsA, rowsB) {
  const a = dailyTotals(rowsA);
  const b = dailyTotals(rowsB);
  const len = Math.max(a.length, b.length);
  const labels = Array.from({ length: len }, (_, i) => `Day ${i + 1}`);

  destroyChart("rev");
  charts.rev = new Chart(document.getElementById("chart-revenue"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "A revenue",
          data: a.map((d) => d.revenue),
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14,165,233,0.1)",
          tension: 0.25,
          fill: true,
        },
        {
          label: "B revenue",
          data: b.map((d) => d.revenue),
          borderColor: "#94a3b8",
          backgroundColor: "rgba(148,163,184,0.1)",
          borderDash: [4, 4],
          tension: 0.25,
        },
      ],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });

  destroyChart("cov");
  charts.cov = new Chart(document.getElementById("chart-covers"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "A covers", data: a.map((d) => d.covers), backgroundColor: "#0ea5e9" },
        { label: "B covers", data: b.map((d) => d.covers), backgroundColor: "#94a3b8" },
      ],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });

  const all = [...rowsA, ...rowsB];
  destroyChart("wx");
  charts.wx = new Chart(document.getElementById("chart-weather"), {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "A",
          data: rowsA.map((r) => ({ x: r.weather, y: totalRev(r) })),
          backgroundColor: "#0ea5e9",
        },
        {
          label: "B",
          data: rowsB.map((r) => ({ x: r.weather, y: totalRev(r) })),
          backgroundColor: "#94a3b8",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: { min: 1, max: 10, title: { display: true, text: "Weather rank" } },
        y: { title: { display: true, text: "Total revenue" } },
      },
    },
  });
}

function renderMetrics() {
  const all = loadRecords();
  if (!aFrom.value && !aTo.value && all.length) {
    applyPreset("last7");
    return;
  }
  const rowsA = all.filter((r) => inRange(r, aFrom.value, aTo.value));
  const rowsB = all.filter((r) => inRange(r, bFrom.value, bTo.value));
  renderSummary(aggregate(rowsA), aggregate(rowsB));
  renderCharts(rowsA, rowsB);
}

// --------------------- settings view ---------------------

const settingsForm = document.getElementById("settings-form");

function renderSettings() {
  const s = loadSettings();
  document.getElementById("s-label").value = s.label;
  document.getElementById("s-lat").value = s.lat;
  document.getElementById("s-lon").value = s.lon;
  document.getElementById("s-tz").value = s.tz;
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("settings-msg");
  try {
    await saveSettings({
      label: document.getElementById("s-label").value || DEFAULT_SETTINGS.label,
      lat: parseFloat(document.getElementById("s-lat").value) || DEFAULT_SETTINGS.lat,
      lon: parseFloat(document.getElementById("s-lon").value) || DEFAULT_SETTINGS.lon,
      tz: document.getElementById("s-tz").value.trim() || DEFAULT_SETTINGS.tz,
    });
    msg.textContent = "Saved.";
    msg.className = "msg ok";
  } catch (err) {
    msg.textContent = `Save failed: ${err.message}`;
    msg.className = "msg err";
  }
  setTimeout(() => (msg.textContent = ""), 2000);
});

document.getElementById("wipe-data").addEventListener("click", async () => {
  if (!confirm("Delete ALL records? This cannot be undone.")) return;
  try {
    await wipeAllRecords();
    renderRecords();
    renderMetrics();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
});

document.getElementById("seed-demo").addEventListener("click", async () => {
  if (!confirm("Seed 60 days of demo data? Existing dates will be overwritten.")) return;
  const today = parseDateUTC(todayInTz(SETTINGS.tz));
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    const d = addDays(today, -i);
    const date = isoDate(d);
    const dow = d.getUTCDay();
    const isWeekend = dow === 5 || dow === 6 || dow === 0;
    const weather = Math.round((4 + Math.random() * 6) * 10) / 10;
    const wMul = 0.6 + (weather / 10) * 0.7;
    const dMul = isWeekend ? 1.4 : 1;
    rows.push({
      date,
      weather,
      lunchRevenue: Math.round(2200 * wMul * dMul + Math.random() * 400),
      lunchCovers: Math.round(70 * wMul * dMul + Math.random() * 15),
      dinnerRevenue: Math.round(4200 * wMul * dMul + Math.random() * 700),
      dinnerCovers: Math.round(110 * wMul * dMul + Math.random() * 25),
      retailRevenue: Math.round(900 * wMul * dMul + Math.random() * 200),
      retailTxns: Math.round(40 * wMul * dMul + Math.random() * 10),
      weatherDetail: null,
    });
  }
  try {
    await bulkImport(rows);
    renderRecords();
    renderMetrics();
    alert("Demo data seeded.");
  } catch (err) {
    alert(`Seed failed: ${err.message}`);
  }
});

// initial bootstrap — fetch from server, then render
(async () => {
  await bootstrap();
  // Reset the date input now that we've loaded the user's saved timezone.
  dateEl.value = todayInTz(SETTINGS.tz);
  renderRecords();
})();

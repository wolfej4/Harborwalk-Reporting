// Harborwalk Reporting — single-page app
// Storage: REST API backed by a JSON file in a Docker volume.
// Weather: OpenMeteo (no key required).

const DEFAULT_SETTINGS = {
  label: "Destin Harborwalk",
  lat: 30.3935,
  lon: -86.4958,
  tz: "America/Chicago",
};

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

// Score a day 1–10 using OpenMeteo daily fields.
// 10 = ideal restaurant/retail weather (warm, dry, calm, mostly sunny).
function scoreWeather({ tMaxF, tMinF, precipIn, windMph, cloudPct }) {
  let score = 10;
  const avg = (tMaxF + tMinF) / 2;

  // Distance from a 75°F ideal — 10° off ≈ 1 point.
  score -= Math.abs(avg - 75) * 0.1;

  // Precipitation is a big revenue killer.
  if (precipIn > 0) score -= Math.min(5, precipIn * 5);

  // Wind above 15 mph chips away at outdoor seating.
  if (windMph > 15) score -= Math.min(3, (windMph - 15) * 0.2);

  // Heavy overcast — small penalty.
  if (cloudPct != null) score -= (cloudPct / 100) * 1.5;

  // Temperature extremes.
  if (tMaxF < 50) score -= 2;
  if (tMaxF < 40) score -= 2;
  if (tMaxF > 95) score -= 2;

  score = Math.max(1, Math.min(10, score));
  return Math.round(score * 10) / 10;
}

async function fetchWeather(dateStr, settings) {
  const today = new Date().toISOString().slice(0, 10);
  const isPast = dateStr < today;
  const base = isPast
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";

  const params = new URLSearchParams({
    latitude: String(settings.lat),
    longitude: String(settings.lon),
    start_date: dateStr,
    end_date: dateStr,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_speed_10m_max",
      "cloud_cover_mean",
      "weather_code",
    ].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: settings.tz || "auto",
  });

  const url = `${base}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
  const data = await res.json();
  const d = data.daily;
  if (!d || !d.time || !d.time.length) throw new Error("No weather data for that date");

  const out = {
    tMaxF: d.temperature_2m_max?.[0],
    tMinF: d.temperature_2m_min?.[0],
    precipIn: d.precipitation_sum?.[0] ?? 0,
    windMph: d.wind_speed_10m_max?.[0] ?? 0,
    cloudPct: d.cloud_cover_mean?.[0] ?? null,
    code: d.weather_code?.[0],
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
  const hi = w.tMaxF != null ? `${Math.round(w.tMaxF)}°F` : "—";
  const lo = w.tMinF != null ? `${Math.round(w.tMinF)}°F` : "—";
  const p = w.precipIn ? `, ${w.precipIn.toFixed(2)} in rain` : "";
  return `${cond}, ${hi} / ${lo}${p}`;
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

dateEl.value = new Date().toISOString().slice(0, 10);

let lastWeatherFetch = null; // keep raw weather to attach to record

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
  const rec = {
    date: fd.get("date"),
    weather: parseFloat(fd.get("weather")),
    lunchRevenue: parseFloat(fd.get("lunchRevenue")) || 0,
    lunchCovers: parseInt(fd.get("lunchCovers")) || 0,
    dinnerRevenue: parseFloat(fd.get("dinnerRevenue")) || 0,
    dinnerCovers: parseInt(fd.get("dinnerCovers")) || 0,
    retailRevenue: parseFloat(fd.get("retailRevenue")) || 0,
    retailTxns: parseInt(fd.get("retailTxns")) || 0,
    weatherDetail: lastWeatherFetch
      ? {
          tMaxF: lastWeatherFetch.tMaxF,
          tMinF: lastWeatherFetch.tMinF,
          precipIn: lastWeatherFetch.precipIn,
          windMph: lastWeatherFetch.windMph,
          cloudPct: lastWeatherFetch.cloudPct,
          code: lastWeatherFetch.code,
          summary: lastWeatherFetch.summary,
        }
      : null,
  };
  try {
    await upsertRecord(rec);
    entryMsg.textContent = `Saved report for ${rec.date}.`;
    entryMsg.className = "msg ok";
    form.reset();
    dateEl.value = new Date().toISOString().slice(0, 10);
    weatherDetail.textContent = "";
    lastWeatherFetch = null;
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
      <td><button class="link" data-del="${r.date}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (confirm(`Delete record for ${b.dataset.del}?`)) {
        try {
          await deleteRecord(b.dataset.del);
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
    "tMaxF",
    "tMinF",
    "precipIn",
    "windMph",
    "cloudPct",
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
        w.tMaxF ?? "",
        w.tMinF ?? "",
        w.precipIn ?? "",
        w.windMph ?? "",
        w.cloudPct ?? "",
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

document.getElementById("import-csv").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const cols = headerLine.split(",");
  const rows = lines
    .filter(Boolean)
    .map((line) => {
      const v = line.split(",");
      const obj = {};
      cols.forEach((c, i) => (obj[c] = v[i]));
      return {
        date: obj.date,
        weather: parseFloat(obj.weather),
        lunchRevenue: parseFloat(obj.lunchRevenue) || 0,
        lunchCovers: parseInt(obj.lunchCovers) || 0,
        dinnerRevenue: parseFloat(obj.dinnerRevenue) || 0,
        dinnerCovers: parseInt(obj.dinnerCovers) || 0,
        retailRevenue: parseFloat(obj.retailRevenue) || 0,
        retailTxns: parseInt(obj.retailTxns) || 0,
        weatherDetail: {
          tMaxF: parseFloat(obj.tMaxF) || null,
          tMinF: parseFloat(obj.tMinF) || null,
          precipIn: parseFloat(obj.precipIn) || 0,
          windMph: parseFloat(obj.windMph) || 0,
          cloudPct: parseFloat(obj.cloudPct) || null,
          code: parseInt(obj.weatherCode) || null,
        },
      };
    });
  try {
    await bulkImport(rows);
    renderRecords();
    alert(`Imported ${rows.length} records.`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
  e.target.value = "";
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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
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
      tz: document.getElementById("s-tz").value || "auto",
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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
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
  renderRecords();
})();

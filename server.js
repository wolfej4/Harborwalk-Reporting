import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "harborwalk.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const DEFAULT_SETTINGS = {
  label: "Destin Harborwalk",
  lat: 30.3935,
  lon: -86.4958,
  tz: "America/Chicago",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    cache = { records: [], settings: { ...DEFAULT_SETTINGS } };
  }
  return cache;
}

function persist() {
  // serialize writes; each write reads the current cache snapshot
  writeChain = writeChain.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, DATA_FILE);
  });
  return writeChain;
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/records", async (_req, res, next) => {
  try {
    const db = await load();
    res.json(db.records);
  } catch (e) {
    next(e);
  }
});

app.put("/api/records/:date", async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: "invalid date" });
    const rec = { ...(req.body || {}), date };
    const db = await load();
    db.records = db.records.filter((r) => r.date !== date);
    db.records.push(rec);
    db.records.sort((a, b) => a.date.localeCompare(b.date));
    await persist();
    res.json(rec);
  } catch (e) {
    next(e);
  }
});

app.delete("/api/records/:date", async (req, res, next) => {
  try {
    const db = await load();
    db.records = db.records.filter((r) => r.date !== req.params.date);
    await persist();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

app.delete("/api/records", async (_req, res, next) => {
  try {
    const db = await load();
    db.records = [];
    await persist();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

app.post("/api/records/bulk", async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body) ? req.body : [];
    const db = await load();
    let imported = 0;
    for (const r of incoming) {
      if (!r || !DATE_RE.test(r.date)) continue;
      db.records = db.records.filter((x) => x.date !== r.date);
      db.records.push(r);
      imported++;
    }
    db.records.sort((a, b) => a.date.localeCompare(b.date));
    await persist();
    res.json({ imported });
  } catch (e) {
    next(e);
  }
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    const db = await load();
    res.json(db.settings);
  } catch (e) {
    next(e);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    const db = await load();
    db.settings = { ...DEFAULT_SETTINGS, ...(req.body || {}) };
    await persist();
    res.json(db.settings);
  } catch (e) {
    next(e);
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "server error" });
});

app.listen(PORT, () => {
  console.log(`Harborwalk Reporting on :${PORT}, data file: ${DATA_FILE}`);
});

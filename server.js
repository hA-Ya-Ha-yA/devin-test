import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(__dirname, "data", "cache");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

fs.mkdirSync(CACHE_DIR, { recursive: true });

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const lines = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "lines.json"), "utf8")
);

const app = express();
app.use(express.static(path.join(__dirname, "public")));

function cacheKey(query) {
  return crypto.createHash("sha1").update(query).digest("hex");
}

function readCache(key) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    fs.writeFileSync(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify(value),
      "utf8"
    );
  } catch (e) {
    console.warn("cache write failed", e.message);
  }
}

async function runOverpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "rail-route-map/1.0 (https://github.com/; OSM route viewer)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass ${endpoint} -> HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All Overpass endpoints failed");
}

// Build an Overpass query that returns route relations matching name/operator.
function buildQuery({ nameRegex, operatorRegex }) {
  const filters = [`[type=route]`, `[route~"train|subway|light_rail|monorail|tram|funicular"]`];
  if (nameRegex) filters.push(`[name~"${nameRegex}"]`);
  if (operatorRegex) filters.push(`[operator~"${operatorRegex}"]`);
  const f = filters.join("");
  return `[out:json][timeout:90];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
relation${f}(area.jp);
out geom;`;
}

// Convert an Overpass relation (out geom) into route segments + station points.
function toGeoJSON(data) {
  const features = [];
  const relations = [];
  const seenWays = new Set();
  const seenStations = new Set();
  for (const el of data.elements || []) {
    if (el.type !== "relation") continue;
    relations.push({ id: el.id, tags: el.tags || {} });
    for (const m of el.members || []) {
      if (m.type === "way" && Array.isArray(m.geometry)) {
        if (m.ref != null && seenWays.has(m.ref)) continue;
        if (m.ref != null) seenWays.add(m.ref);
        const coords = m.geometry.map((g) => [g.lon, g.lat]);
        if (coords.length >= 2) {
          features.push({
            type: "Feature",
            properties: { relId: el.id, role: m.role || "" },
            geometry: { type: "LineString", coordinates: coords },
          });
        }
      }
      if (
        m.type === "node" &&
        typeof m.lat === "number" &&
        typeof m.role === "string" &&
        m.role.startsWith("stop")
      ) {
        if (m.ref != null && seenStations.has(m.ref)) continue;
        if (m.ref != null) seenStations.add(m.ref);
        features.push({
          type: "Feature",
          properties: { relId: el.id, station: true, name: (m.tags && m.tags.name) || "" },
          geometry: { type: "Point", coordinates: [m.lon, m.lat] },
        });
      }
    }
  }
  return {
    geojson: { type: "FeatureCollection", features },
    relations,
  };
}

app.get("/api/lines", (req, res) => {
  res.json(lines);
});

app.get("/api/route", async (req, res) => {
  try {
    let nameRegex = req.query.name;
    let operatorRegex = req.query.operator;
    const id = req.query.id;

    if (id) {
      const line = lines.find((l) => l.id === id);
      if (!line) return res.status(404).json({ error: "unknown line id" });
      nameRegex = line.nameRegex;
      operatorRegex = line.operatorRegex;
    }
    if (!nameRegex) return res.status(400).json({ error: "name or id required" });

    const query = buildQuery({ nameRegex, operatorRegex });
    const key = cacheKey(query);
    let raw = readCache(key);
    if (!raw) {
      raw = await runOverpass(query);
      writeCache(key, raw);
    }
    const { geojson, relations } = toGeoJSON(raw);
    if (!geojson.features.length) {
      return res.status(404).json({ error: "no geometry found", relations });
    }
    res.json({ geojson, relations });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// Free-text search across the curated list (client also filters, this is a helper).
app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json(lines);
  res.json(lines.filter((l) => (l.name + l.operator + l.region).includes(q)));
});

app.listen(PORT, () => {
  console.log(`rail-route-map listening on http://localhost:${PORT}`);
});

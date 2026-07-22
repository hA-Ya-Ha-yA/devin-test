import { Hono } from "hono";
import lines from "../data/lines.json";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const CACHE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function sha1(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

// Run an Overpass query, backed by the Workers Cache API (30-day TTL).
async function cachedOverpass(query, ctx) {
  const cache = caches.default;
  const key = new Request(`https://rail-route-map.cache/overpass?h=${await sha1(query)}`);
  const hit = await cache.match(key);
  if (hit) return await hit.json();

  const raw = await runOverpass(query);
  const resp = new Response(JSON.stringify(raw), {
    headers: {
      "content-type": "application/json",
      "Cache-Control": `max-age=${CACHE_MAX_AGE}`,
    },
  });
  const put = cache.put(key, resp.clone());
  if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  else await put;
  return raw;
}

// Build an Overpass query that returns route relations matching name/operator.
// `railway` is included so lines mapped only as a physical route (not a service
// pattern) are still found (e.g. 飯田線, 京急本線).
function buildQuery({ nameRegex, operatorRegex }) {
  const filters = [`[type=route]`, `[route~"train|subway|light_rail|monorail|tram|funicular|railway"]`];
  if (nameRegex) filters.push(`[name~"${nameRegex}"]`);
  if (operatorRegex) filters.push(`[operator~"${operatorRegex}"]`);
  const f = filters.join("");
  return `[out:json][timeout:90];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
relation${f}(area.jp)->.routes;
.routes out geom;
node(r.routes);
out tags;
way(r.routes)->.rw;
node(w.rw)[railway~"station|halt|stop"];
out;`;
}

// Through-running service relations span several lines and pull in foreign
// stations. They are identified by a 直通 marker in the name or a multi-line
// ref code such as "DT;Z" or "A;B".
function isThroughService(tags) {
  const name = tags.name || "";
  const ref = tags.ref || "";
  return name.includes("直通") || ref.includes(";");
}

// Convert an Overpass relation (out geom) into route segments + station points.
function toGeoJSON(data) {
  const features = [];
  const relations = [];
  const seenWays = new Set();
  const seenStations = new Set();
  // Collapse the same station appearing once per direction/loop relation
  // (up/down or inner/outer carry distinct stop nodes at ~identical coords).
  const seenStationNames = new Set();
  // Member nodes are emitted separately (out tags) so we can resolve station names.
  const nodeNames = new Map();
  // Station nodes that lie on the member ways but are not relation members.
  // Used as a fallback for lines whose relations carry no stop members.
  const wayStations = [];
  for (const el of data.elements || []) {
    if (el.type !== "node" || !el.tags) continue;
    if (el.tags.name) nodeNames.set(el.id, el.tags.name);
    const rw = el.tags.railway;
    if (
      typeof el.lat === "number" &&
      el.tags.name &&
      (rw === "station" || rw === "halt" || rw === "stop")
    ) {
      wayStations.push({ id: el.id, name: el.tags.name, lon: el.lon, lat: el.lat });
    }
  }
  let stationCount = 0;
  for (const el of data.elements || []) {
    if (el.type !== "relation") continue;
    const tags = el.tags || {};
    if (isThroughService(tags)) continue;
    relations.push({ id: el.id, tags });
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
        stationCount++;
        const name = (m.tags && m.tags.name) || nodeNames.get(m.ref) || "";
        if (name && seenStationNames.has(name)) continue;
        if (name) seenStationNames.add(name);
        features.push({
          type: "Feature",
          properties: { relId: el.id, station: true, name },
          geometry: { type: "Point", coordinates: [m.lon, m.lat] },
        });
      }
    }
  }
  // Fallback: no relation carried stop members, so derive stations from the
  // station nodes found on the member ways.
  if (stationCount === 0) {
    for (const s of wayStations) {
      if (seenStations.has(s.id)) continue;
      seenStations.add(s.id);
      if (s.name && seenStationNames.has(s.name)) continue;
      if (s.name) seenStationNames.add(s.name);
      features.push({
        type: "Feature",
        properties: { station: true, name: s.name },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      });
    }
  }
  return {
    geojson: { type: "FeatureCollection", features },
    relations,
  };
}

const app = new Hono();

app.get("/api/lines", (c) => c.json(lines));

app.get("/api/route", async (c) => {
  try {
    let nameRegex = c.req.query("name");
    let operatorRegex = c.req.query("operator");
    const id = c.req.query("id");

    if (id) {
      const line = lines.find((l) => l.id === id);
      if (!line) return c.json({ error: "unknown line id" }, 404);
      nameRegex = line.nameRegex;
      operatorRegex = line.operatorRegex;
    }
    if (!nameRegex) return c.json({ error: "name or id required" }, 400);

    const query = buildQuery({ nameRegex, operatorRegex });
    const raw = await cachedOverpass(query, c.executionCtx);
    const { geojson, relations } = toGeoJSON(raw);
    if (!geojson.features.length) {
      return c.json({ error: "no geometry found", relations }, 404);
    }
    return c.json({ geojson, relations });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

// Free-text search across the curated list (client also filters, this is a helper).
app.get("/api/search", (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json(lines);
  return c.json(lines.filter((l) => (l.name + l.operator + l.region).includes(q)));
});

export default app;

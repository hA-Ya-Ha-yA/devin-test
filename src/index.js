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
function buildQuery({ nameRegex, operatorRegex }) {
  const filters = [`[type=route]`, `[route~"train|subway|light_rail|monorail|tram|funicular"]`];
  if (nameRegex) filters.push(`[name~"${nameRegex}"]`);
  if (operatorRegex) filters.push(`[operator~"${operatorRegex}"]`);
  const f = filters.join("");
  return `[out:json][timeout:90];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
relation${f}(area.jp)->.routes;
.routes out geom;
node(r.routes);
out tags;`;
}

// Convert an Overpass relation (out geom) into route segments + station points.
function toGeoJSON(data) {
  const features = [];
  const relations = [];
  const seenWays = new Set();
  const seenStations = new Set();
  // Member nodes are emitted separately (out tags) so we can resolve station names.
  const nodeNames = new Map();
  for (const el of data.elements || []) {
    if (el.type === "node" && el.tags && el.tags.name) {
      nodeNames.set(el.id, el.tags.name);
    }
  }
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
          properties: {
            relId: el.id,
            station: true,
            name: (m.tags && m.tags.name) || nodeNames.get(m.ref) || "",
          },
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

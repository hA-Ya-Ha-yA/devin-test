"use strict";

// Simple map appearance: white land, light sea, gray prefecture borders.
const MAP_STYLE = {
  land: "#ffffff",
  sea: "#eef1f4",
  border: "#9aa4ad",
  label: "#1a1a1a",
  labelHalo: "#ffffff",
};

// Fixed output image size (portrait). Route is fit into this frame on export.
const OUT_W = 1125;
const OUT_H = 1755;
const OUT_PAD = 60;

const state = {
  lines: [],
  selected: null, // line metadata of currently drawn route
  routeLayer: null,
  stationLayer: null,
  geojson: null,
  prefectures: null, // prefecture boundary GeoJSON
};

const map = L.map("map", { preferCanvas: false, zoomControl: true }).setView(
  [36.2048, 138.2529],
  5
);

let prefLayer = null;
async function loadPrefectures() {
  const res = await fetch("data/japan-prefectures.geojson");
  if (!res.ok) throw new Error("都道府県境界の読み込みに失敗しました");
  const gj = await res.json();
  for (const f of gj.features) f._bbox = featureBBox(f);
  state.prefectures = gj;
  prefLayer = L.geoJSON(gj, {
    style: {
      color: MAP_STYLE.border,
      weight: 1,
      fillColor: MAP_STYLE.land,
      fillOpacity: 1,
    },
    interactive: false,
  }).addTo(map);
}

// ---------- geometry helpers ----------
function polygonsOf(geom) {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

function featureBBox(feat) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygonsOf(feat.geometry)) {
    for (const ring of poly) {
      for (const c of ring) {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// Ray-casting point-in-ring test. Point and ring use [lon, lat].
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function pointInFeature(coord, feat) {
  const bb = feat._bbox;
  if (bb && (coord[0] < bb.minX || coord[0] > bb.maxX || coord[1] < bb.minY || coord[1] > bb.maxY)) {
    return false;
  }
  for (const poly of polygonsOf(feat.geometry)) {
    if (!pointInRing(coord[0], coord[1], poly[0])) continue;
    let inHole = false;
    for (let k = 1; k < poly.length; k++) {
      if (pointInRing(coord[0], coord[1], poly[k])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// All route vertices and station points as [lon, lat].
function collectRouteCoords(geojson) {
  const out = [];
  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") {
      for (const c of f.geometry.coordinates) out.push(c);
    } else if (f.geometry.type === "Point") {
      out.push(f.geometry.coordinates);
    }
  }
  return out;
}

// Prefectures (in geojson order) that the route passes through.
function prefecturesForRoute(geojson) {
  const coords = collectRouteCoords(geojson);
  const names = [];
  for (const feat of state.prefectures.features) {
    for (const c of coords) {
      if (pointInFeature(c, feat)) { names.push(feat.properties.name); break; }
    }
  }
  return names;
}

// ---------- UI helpers ----------
const el = (id) => document.getElementById(id);
const statusEl = el("status");
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

function regionsOf(lines) {
  const order = ["関東", "中部", "関西", "九州", "新幹線", "運行系統"];
  const set = [...new Set(lines.map((l) => l.region))];
  set.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return set;
}

function renderRegionOptions() {
  const sel = el("region");
  const regions = regionsOf(state.lines);
  sel.innerHTML =
    '<option value="">すべてのエリア</option>' +
    regions.map((r) => `<option value="${r}">${r}</option>`).join("");
}

function renderLineList() {
  const region = el("region").value;
  const q = el("search").value.trim();
  const list = el("line-list");
  let items = state.lines;
  if (region) items = items.filter((l) => l.region === region);
  if (q) items = items.filter((l) => (l.name + l.operator + l.region).includes(q));

  if (!items.length) {
    list.innerHTML = '<p class="group-label">該当する路線がありません</p>';
    return;
  }

  const groups = {};
  for (const l of items) (groups[l.region] ||= []).push(l);

  let html = "";
  for (const region of regionsOf(items)) {
    html += `<div class="group-label">${region}</div>`;
    for (const l of groups[region]) {
      const active = state.selected && state.selected.id === l.id ? " active" : "";
      html += `
        <div class="line-item${active}" data-id="${l.id}">
          <span class="swatch" style="background:${l.color}"></span>
          <span class="meta">
            <span class="name">${l.name}</span>
            <span class="op">${l.operator}</span>
          </span>
        </div>`;
    }
  }
  list.innerHTML = html;

  list.querySelectorAll(".line-item").forEach((node) => {
    node.addEventListener("click", () => {
      const line = state.lines.find((l) => l.id === node.dataset.id);
      selectLine(line);
    });
  });
}

// ---------- route drawing ----------
function clearRoute() {
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  if (state.stationLayer) map.removeLayer(state.stationLayer);
  state.routeLayer = null;
  state.stationLayer = null;
  state.geojson = null;
}

function populatePrefectureSelect(geojson) {
  const sel = el("prefecture");
  const wrap = el("prefField");
  const names = prefecturesForRoute(geojson);
  sel.innerHTML =
    '<option value="">路線全体</option>' +
    names.map((n) => `<option value="${n}">${n}</option>`).join("");
  // Only useful when the route actually crosses more than one prefecture.
  wrap.classList.toggle("hidden", names.length <= 1);
}

function drawGeoJSON(geojson, color) {
  clearRoute();
  const width = Number(el("optWidth").value);
  const lineFeatures = {
    type: "FeatureCollection",
    features: geojson.features.filter((f) => f.geometry.type === "LineString"),
  };
  state.routeLayer = L.geoJSON(lineFeatures, {
    style: { color, weight: width, opacity: 0.95, lineJoin: "round", lineCap: "round" },
  }).addTo(map);
  state.geojson = geojson;

  if (el("optStations").checked) drawStations(geojson, color);

  const b = state.routeLayer.getBounds();
  if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getProjectedBounds(geojson, project) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function add(p) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  for (const f of geojson.features) {
    const geom = f.geometry;
    if (geom.type === "Point") {
      add(project(geom.coordinates[1], geom.coordinates[0]));
    } else if (geom.type === "LineString") {
      for (const [lng, lat] of geom.coordinates) add(project(lat, lng));
    } else if (geom.type === "MultiLineString") {
      for (const ring of geom.coordinates) {
        for (const [lng, lat] of ring.coordinates || ring) add(project(lat, lng));
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function getLabelDirNames(geojson, project) {
  const b = getProjectedBounds(geojson, project);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  // Horizontal routes get top/bottom labels; vertical routes get left/right.
  if (w > h * 1.2) return ["top", "bottom"];
  if (h > w * 1.2) return ["right", "left"];
  return ["right", "left", "top", "bottom"];
}

function drawStations(geojson, color) {
  const pts = geojson.features.filter((f) => f.geometry.type === "Point");
  if (!pts.length) return;
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
  const leadPx = isMobile ? 12 : 16;
  const targetZoom =
    state.routeLayer && state.routeLayer.getBounds().isValid()
      ? map.getBoundsZoom(state.routeLayer.getBounds(), false, L.point(40, 40))
      : map.getZoom();
  const dirNames = getLabelDirNames(geojson, (lat, lng) =>
    map.project(L.latLng(lat, lng), targetZoom)
  );
  const offsetFor = {
    right: L.point(leadPx, 0),
    left: L.point(-leadPx, 0),
    top: L.point(0, -leadPx),
    bottom: L.point(0, leadPx),
  };
  const layer = L.layerGroup();
  pts.forEach((f, i) => {
    const name = (f.properties.name || "").trim();
    const lat = f.geometry.coordinates[1];
    const lng = f.geometry.coordinates[0];
    const stationLatLng = L.latLng(lat, lng);
    L.circleMarker(stationLatLng, {
      radius: 4.5,
      color,
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(layer);
    if (!name) return;
    const cls = dirNames[i % dirNames.length];
    const stationPx = map.project(stationLatLng, targetZoom);
    const labelPx = stationPx.add(offsetFor[cls]);
    const labelLatLng = map.unproject(labelPx, targetZoom);
    L.polyline([stationLatLng, labelLatLng], {
      color: "#1a1a1a",
      weight: 1,
      opacity: 0.8,
      dashArray: "3,3",
    }).addTo(layer);
    const icon = L.divIcon({
      className: "station-label-wrap",
      html: `<span class="station-name station-${cls}">${escapeHtml(name)}</span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
    L.marker(labelLatLng, { icon, keyboard: false, zIndexOffset: 1000 }).addTo(layer);
  });
  state.stationLayer = layer.addTo(map);
}

async function selectLine(line) {
  if (!line) return;
  setStatus(`「${line.name}」の経路を取得中…`);
  el("download").disabled = true;
  try {
    const res = await fetch(`/api/route?id=${encodeURIComponent(line.id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "取得に失敗しました");
    state.selected = line;
    drawGeoJSON(data.geojson, line.color);
    populatePrefectureSelect(data.geojson);
    renderLineList();
    const n = data.geojson.features.filter((f) => f.geometry.type === "LineString").length;
    setStatus(`「${line.name}」を表示しました（${n} 区間）。画像を作成できます。`);
    el("download").disabled = false;
  } catch (e) {
    setStatus(`エラー: ${e.message}`, true);
  }
}

async function selectCustom(name) {
  name = (name || "").trim();
  if (!name) return;
  setStatus(`「${name}」を検索中…`);
  el("download").disabled = true;
  try {
    const res = await fetch(`/api/route?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "見つかりませんでした");
    const line = {
      id: "custom:" + name,
      name,
      operator: "カスタム検索",
      region: "",
      color: "#ff3b30",
    };
    state.selected = line;
    drawGeoJSON(data.geojson, line.color);
    populatePrefectureSelect(data.geojson);
    renderLineList();
    setStatus(`「${name}」を表示しました。画像を作成できます。`);
    el("download").disabled = false;
  } catch (e) {
    setStatus(`エラー: ${e.message}`, true);
  }
}

// ---------- image export ----------
// Bounds (of route coords) that the exported image should frame. When a
// prefecture is selected, frame only the route portion inside that prefecture.
function targetBounds() {
  const all = collectRouteCoords(state.geojson);
  let coords = all;
  const pref = el("prefecture").value;
  if (pref) {
    const feat = state.prefectures.features.find((f) => f.properties.name === pref);
    if (feat) {
      const inside = all.filter((c) => pointInFeature(c, feat));
      if (inside.length) coords = inside;
    }
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const c of coords) {
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
    if (c[0] < minLng) minLng = c[0];
    if (c[0] > maxLng) maxLng = c[0];
  }
  return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
}

// A [lat,lng] -> {x,y} projector that fits `bounds` into the OUT_W x OUT_H
// frame (with padding), preserving Web Mercator shape and aspect ratio.
function buildProjector(bounds) {
  const crs = map.options.crs;
  const a = crs.project(bounds.getNorthWest());
  const b = crs.project(bounds.getSouthEast());
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const scale = Math.min((OUT_W - 2 * OUT_PAD) / bw, (OUT_H - 2 * OUT_PAD) / bh);
  const offX = (OUT_W - bw * scale) / 2;
  const offY = (OUT_H - bh * scale) / 2;
  return (lat, lng) => {
    const p = crs.project(L.latLng(lat, lng));
    return { x: offX + (p.x - minX) * scale, y: offY + (maxY - p.y) * scale };
  };
}

function drawPrefecturesOnCanvas(ctx, proj) {
  if (!state.prefectures) return;
  ctx.lineJoin = "round";
  ctx.lineWidth = 1;
  ctx.strokeStyle = MAP_STYLE.border;
  ctx.fillStyle = MAP_STYLE.land;
  for (const f of state.prefectures.features) {
    for (const poly of polygonsOf(f.geometry)) {
      ctx.beginPath();
      for (const ring of poly) {
        ring.forEach((c, i) => {
          const p = proj(c[1], c[0]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
      }
      ctx.fill("evenodd");
      ctx.stroke();
    }
  }
}

function drawRouteOnCanvas(ctx, color, proj) {
  if (!state.geojson) return;
  const width = Number(el("optWidth").value);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const f of state.geojson.features) {
    if (f.geometry.type !== "LineString") continue;
    ctx.beginPath();
    f.geometry.coordinates.forEach((c, i) => {
      const p = proj(c[1], c[0]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  if (el("optStations").checked) drawStationsOnCanvas(ctx, color, proj);
}

function canvasDirData(name) {
  const LEAD = 14;
  const pad = 5;
  const boxH = 22;
  switch (name) {
    case "right":
      return { align: "left", textDx: LEAD + pad, textDy: 0, leadDx: LEAD, leadDy: 0 };
    case "left":
      return { align: "right", textDx: -(LEAD + pad), textDy: 0, leadDx: -LEAD, leadDy: 0 };
    case "top":
      return { align: "center", textDx: 0, textDy: -(LEAD + boxH / 2), leadDx: 0, leadDy: -LEAD };
    case "bottom":
      return { align: "center", textDx: 0, textDy: LEAD + boxH / 2, leadDx: 0, leadDy: LEAD };
    default:
      return { align: "left", textDx: LEAD + pad, textDy: 0, leadDx: LEAD, leadDy: 0 };
  }
}

function drawStationsOnCanvas(ctx, color, proj) {
  ctx.textBaseline = "middle";
  ctx.font = "16px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  ctx.lineJoin = "round";
  const pad = 5;
  const boxH = 22;
  const dirNames = getLabelDirNames(state.geojson, proj);
  let idx = 0;
  for (const f of state.geojson.features) {
    if (f.geometry.type !== "Point") continue;
    const name = (f.properties.name || "").trim();
    const p = proj(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();

    if (!name) {
      idx++;
      continue;
    }
    const dirName = dirNames[idx % dirNames.length];
    const dir = canvasDirData(dirName);
    const tx = p.x + dir.textDx;
    const ty = p.y + dir.textDy;
    const leadX = p.x + dir.leadDx;
    const leadY = p.y + dir.leadDy;
    const tw = ctx.measureText(name).width;
    const boxW = tw + pad * 2;
    const boxX =
      dir.align === "left"
        ? leadX
        : dir.align === "right"
        ? leadX - boxW
        : leadX - boxW / 2;
    const boxY =
      dir.align === "center"
        ? dir.textDy < 0
          ? leadY - boxH
          : leadY
        : leadY - boxH / 2;

    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(leadX, leadY);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#1a1a1a";
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#ffffff";
    roundRect(ctx, boxX, boxY, boxW, boxH, 5);
    ctx.fill();

    ctx.textAlign = dir.align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP_STYLE.labelHalo;
    ctx.strokeText(name, tx, ty);
    ctx.fillStyle = MAP_STYLE.label;
    ctx.fillText(name, tx, ty);
    idx++;
  }
  ctx.textAlign = "left";
}

function drawCaption(ctx, canvas) {
  if (!state.selected) return;
  const title = state.selected.name;
  let sub = state.selected.operator || "";
  const pref = el("prefecture").value;
  if (pref) sub = sub ? `${sub}（${pref}）` : pref;
  ctx.font = "bold 30px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  const tw = ctx.measureText(title).width;
  ctx.font = "18px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  const sw = ctx.measureText(sub).width;
  const boxW = Math.max(tw, sw) + 40;
  const boxH = sub ? 88 : 60;
  const x = 22;
  const y = canvas.height - boxH - 22;

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, x, y, boxW, boxH, 12);
  ctx.fill();
  ctx.fillStyle = state.selected.color || "#333";
  ctx.fillRect(x, y + 11, 8, boxH - 22);

  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";
  ctx.font = "bold 30px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  ctx.fillText(title, x + 24, y + 16);
  if (sub) {
    ctx.fillStyle = "#666";
    ctx.font = "18px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
    ctx.fillText(sub, x + 24, y + 54);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function exportImage() {
  if (!state.selected || !state.geojson) return;
  setStatus("画像を生成中…");
  const color = state.selected.color || "#ff3b30";
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d");

  const bounds = targetBounds();
  if (!bounds.isValid()) {
    setStatus("経路の範囲を計算できませんでした。", true);
    return;
  }
  const proj = buildProjector(bounds);

  ctx.fillStyle = MAP_STYLE.sea;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawPrefecturesOnCanvas(ctx, proj);
  drawRouteOnCanvas(ctx, color, proj);
  drawCaption(ctx, canvas);

  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    const pref = el("prefecture").value;
    const base = (state.selected.name || "route") + (pref ? `_${pref}` : "");
    const safe = base.replace(/[\\/:*?"<>|]/g, "_");
    a.download = `${safe}.png`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    setStatus("画像を保存しました。");
  }, "image/png");
}

// ---------- wiring ----------
function redrawIfNeeded() {
  if (state.selected && state.geojson) {
    drawGeoJSON(state.geojson, state.selected.color);
  }
}

el("region").addEventListener("change", renderLineList);
el("search").addEventListener("input", renderLineList);
el("customGo").addEventListener("click", () => selectCustom(el("customName").value));
el("customName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") selectCustom(el("customName").value);
});
el("optStations").addEventListener("change", redrawIfNeeded);
el("optWidth").addEventListener("input", redrawIfNeeded);
el("download").addEventListener("click", exportImage);
// Selecting a prefecture reframes the on-screen preview to match the export.
el("prefecture").addEventListener("change", () => {
  if (!state.geojson) return;
  const b = targetBounds();
  if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
});

document.querySelector(".sheet-handle")?.addEventListener("click", () => {
  el("sidebar").classList.toggle("collapsed");
});

async function init() {
  try {
    await loadPrefectures();
  } catch (e) {
    setStatus(e.message, true);
  }
  try {
    const res = await fetch("/api/lines");
    state.lines = await res.json();
    renderRegionOptions();
    renderLineList();
    setStatus("路線を選択してください。");
  } catch (e) {
    setStatus("路線一覧の読み込みに失敗しました: " + e.message, true);
  }
}
init();

"use strict";

// Simple map appearance: white land, light sea, gray prefecture borders.
const MAP_STYLE = {
  land: "#ffffff",
  sea: "#eef1f4",
  border: "#9aa4ad",
  label: "#1a1a1a",
  labelHalo: "#ffffff",
};

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

// ---------- UI helpers ----------
const el = (id) => document.getElementById(id);
const statusEl = el("status");
function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

function regionsOf(lines) {
  const order = ["関東", "中部", "関西", "九州", "新幹線"];
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

function drawStations(geojson, color) {
  const pts = geojson.features.filter((f) => f.geometry.type === "Point");
  if (!pts.length) return;
  state.stationLayer = L.layerGroup(
    pts.map((f) => {
      const name = (f.properties.name || "").trim();
      const marker = L.circleMarker(
        [f.geometry.coordinates[1], f.geometry.coordinates[0]],
        {
          radius: 4,
          color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        }
      );
      if (name) {
        marker.bindTooltip(name, {
          permanent: true,
          direction: "right",
          offset: [6, 0],
          className: "station-label",
        });
      }
      return marker;
    })
  ).addTo(map);
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
    renderLineList();
    setStatus(`「${name}」を表示しました。画像を作成できます。`);
    el("download").disabled = false;
  } catch (e) {
    setStatus(`エラー: ${e.message}`, true);
  }
}

// ---------- image export ----------
function drawPrefecturesOnCanvas(ctx) {
  if (!state.prefectures) return;
  ctx.lineJoin = "round";
  ctx.lineWidth = 1;
  ctx.strokeStyle = MAP_STYLE.border;
  ctx.fillStyle = MAP_STYLE.land;
  for (const f of state.prefectures.features) {
    const geom = f.geometry;
    const polys =
      geom.type === "Polygon"
        ? [geom.coordinates]
        : geom.type === "MultiPolygon"
        ? geom.coordinates
        : [];
    for (const poly of polys) {
      ctx.beginPath();
      for (const ring of poly) {
        ring.forEach((c, i) => {
          const p = map.latLngToContainerPoint([c[1], c[0]]);
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

function drawRouteOnCanvas(ctx, color) {
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
      const p = map.latLngToContainerPoint([c[1], c[0]]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  if (el("optStations").checked) drawStationsOnCanvas(ctx, color);
}

function drawStationsOnCanvas(ctx, color) {
  ctx.textBaseline = "middle";
  ctx.font =
    "12px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  ctx.lineJoin = "round";
  for (const f of state.geojson.features) {
    if (f.geometry.type !== "Point") continue;
    const p = map.latLngToContainerPoint([
      f.geometry.coordinates[1],
      f.geometry.coordinates[0],
    ]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();

    const name = (f.properties.name || "").trim();
    if (!name) continue;
    const tx = p.x + 7;
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP_STYLE.labelHalo;
    ctx.strokeText(name, tx, p.y);
    ctx.fillStyle = MAP_STYLE.label;
    ctx.fillText(name, tx, p.y);
  }
}

function drawCaption(ctx, canvas) {
  if (!state.selected) return;
  const title = state.selected.name;
  const sub = state.selected.operator || "";
  ctx.font = "bold 22px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  const tw = ctx.measureText(title).width;
  ctx.font = "13px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  const sw = ctx.measureText(sub).width;
  const boxW = Math.max(tw, sw) + 28;
  const boxH = sub ? 64 : 44;
  const x = 16;
  const y = canvas.height - boxH - 16;

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, x, y, boxW, boxH, 10);
  ctx.fill();
  ctx.fillStyle = state.selected.color || "#333";
  ctx.fillRect(x, y + 8, 6, boxH - 16);

  ctx.fillStyle = "#1a1a1a";
  ctx.textBaseline = "top";
  ctx.font = "bold 22px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
  ctx.fillText(title, x + 18, y + 12);
  if (sub) {
    ctx.fillStyle = "#666";
    ctx.font = "13px 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif";
    ctx.fillText(sub, x + 18, y + 40);
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
  if (!state.selected) return;
  setStatus("画像を生成中…");
  const color = state.selected.color || "#ff3b30";
  const size = map.getSize();
  const canvas = document.createElement("canvas");
  canvas.width = size.x;
  canvas.height = size.y;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = MAP_STYLE.sea;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawPrefecturesOnCanvas(ctx);
  drawRouteOnCanvas(ctx, color);
  drawCaption(ctx, canvas);

  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    const safe = (state.selected.name || "route").replace(/[\\/:*?"<>|]/g, "_");
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

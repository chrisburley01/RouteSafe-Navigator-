// main.js – RouteSafe Navigator v1.0
// Frontend for the RouteSafe-AI backend.

// --------------- CONFIG -----------------

const API_BASE_URL = "https://routesafe-ai.onrender.com"; // no trailing slash



// --------------- MAP SETUP (Leaflet) ----

let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;

function initMap() {
  map = L.map("map").setView([53.8, -1.55], 7); // UK default view

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  mainRouteLayer = L.polyline([], { weight: 5, color: "#3aa0ff" }).addTo(map);
  altRouteLayer = L.polyline([], {
    weight: 4,
    color: "#a0c9ff",
    dashArray: "6 6",
  }).addTo(map);
  bridgeLayer = L.layerGroup().addTo(map);
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  const form = document.getElementById("routeForm");
  form.addEventListener("submit", handleRouteSubmit);
});



// --------------- HELPERS ----------------

function setStatus(message, type = "info") {
  const el = document.getElementById("routeStatus");
  el.textContent = message;
  el.className = "ws-status";
  if (type === "error") el.classList.add("ws-status--error");
  if (type === "success") el.classList.add("ws-status--success");
}

function showCard(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !show;
}

function hideEmptyState() {
  const el = document.getElementById("mapEmptyState");
  if (el) el.style.display = "none";
}

function fmtKm(v) {
  if (v == null) return "–";
  const num = Number(v);
  if (Number.isNaN(num)) return "–";
  return `${num.toFixed(1)} km`;
}

function fmtMin(v) {
  if (v == null) return "–";
  const num = Number(v);
  if (Number.isNaN(num)) return "–";
  return `${num.toFixed(0)} min`;
}

function fmtMeters(v) {
  if (v == null) return "–";
  const num = Number(v);
  if (Number.isNaN(num)) return "–";
  return `${num.toFixed(0)} m`;
}



// --------------- FORM HANDLER -----------

async function handleRouteSubmit(e) {
  e.preventDefault();

  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();
  const height = parseFloat(
    document.getElementById("vehicleHeight").value.trim()
  );
  const avoidLowBridges =
    document.getElementById("avoidLowBridges").checked || false;

  if (!start || !end || !height || height <= 0) {
    setStatus("Please enter start, destination and a valid vehicle height.", "error");
    return;
  }

  setStatus("Requesting safe HGV route from RouteSafe-AI…");

  // Reset UI
  mainRouteLayer.setLatLngs([]);
  altRouteLayer.setLatLngs([]);
  bridgeLayer.clearLayers();
  hideEmptyState();
  showCard("routeSummaryCard", false);
  showCard("warningsCard", false);
  showCard("stepsCard", false);

  const payload = {
    start,
    end,
    vehicle_height_m: height,
    avoid_low_bridges: avoidLowBridges,
  };

  try {
    const res = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    renderRouteResult(data);
    setStatus("Route generated successfully ✔", "success");
  } catch (err) {
    console.error(err);
    setStatus(
      "Error generating route. Check the API is up and try again.",
      "error"
    );
  }
}



// --------------- RENDER RESULT ----------

function renderRouteResult(result) {
  // --- Map geometry ---
  const mainLatLngs = extractRouteLatLngs(result, "main");
  const altLatLngs = extractRouteLatLngs(result, "alt");

  if (mainLatLngs.length > 0) {
    mainRouteLayer.setLatLngs(mainLatLngs);
  }
  if (altLatLngs.length > 0) {
    altRouteLayer.setLatLngs(altLatLngs);
  }

  // Fit bounds if we have points
  const allPoints = [...mainLatLngs, ...altLatLngs];
  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }

  // --- Bridge markers ---
  const bridges =
    result.bridge_markers || result.bridges || result.low_bridges || [];
  bridges.forEach((b) => {
    if (!b.lat || !b.lon) return;
    const marker = L.circleMarker([b.lat, b.lon], {
      radius: 7,
      weight: 2,
      color: "#ff7043",
      fillColor: "#ff7043",
      fillOpacity: 0.9,
    });
    const h =
      b.height_m != null
        ? `${Number(b.height_m).toFixed(2)} m`
        : "Height unknown";
    const msg = b.message || `Low bridge: ${h}`;
    marker.bindPopup(msg);
    marker.addTo(bridgeLayer);
  });

  // --- Summary metrics ---
  const summary = result.summary || {};
  const distanceKm =
    summary.distance_km ?? result.distance_km ?? result.main_distance_km;
  const durationMin =
    summary.duration_min ?? result.duration_min ?? result.main_duration_min;

  document.getElementById("summaryDistance").textContent = fmtKm(distanceKm);
  document.getElementById("summaryDuration").textContent = fmtMin(durationMin);

  const bridgeRisk = result.bridge_risk || {};
  const riskLevel = bridgeRisk.level || "Unknown";
  document.getElementById("summaryRisk").textContent =
    bridgeRisk.status_text || riskLevel;

  const nearestHeight =
    bridgeRisk.nearest_bridge_height_m ?? bridgeRisk.nearest_height_m;
  const nearestDist =
    bridgeRisk.nearest_bridge_distance_m ?? bridgeRisk.nearest_distance_m;

  document.getElementById("summaryNearestBridge").textContent =
    nearestHeight == null && nearestDist == null
      ? "–"
      : `${fmtMeters(nearestHeight)} at ${fmtMeters(nearestDist)}`;

  const riskBadge = document.getElementById("riskBadge");
  riskBadge.textContent = riskLevel || "No data";
  riskBadge.className = "ws-badge";
  if (riskLevel === "high") riskBadge.classList.add("ws-badge--high");
  else if (riskLevel === "medium") riskBadge.classList.add("ws-badge--warn");
  else riskBadge.classList.add("ws-badge--ok");

  showCard("routeSummaryCard", true);

  // --- Warnings ---
  const warningsContainer = document.getElementById("warningsList");
  warningsContainer.innerHTML = "";

  const warnings = result.warnings || [];
  if (warnings.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No additional warnings.";
    warningsContainer.appendChild(li);
  } else {
    warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = typeof w === "string" ? w : w.message || "Warning";
      warningsContainer.appendChild(li);
    });
  }
  showCard("warningsCard", true);

  // --- Steps ---
  const stepsEl = document.getElementById("stepsList");
  stepsEl.innerHTML = "";
  const steps = result.steps || result.turn_by_turn || [];
  if (steps.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No turn-by-turn instructions returned.";
    stepsEl.appendChild(li);
  } else {
    steps.forEach((s, i) => {
      const li = document.createElement("li");
      const text = typeof s === "string" ? s : s.instruction || JSON.stringify(s);
      li.textContent = `${i + 1}. ${text}`;
      stepsEl.appendChild(li);
    });
  }
  showCard("stepsCard", true);
}



// --------------- GEOMETRY EXTRACTION ----

// Try to cope with different response shapes: `geometry`, `main_geojson`, etc.
function extractRouteLatLngs(result, which) {
  // which: "main" or "alt"
  const coords = [];

  // 1) Our original ORS-style geometry
  if (result.geometry && result.geometry.coordinates && which === "main") {
    result.geometry.coordinates.forEach(([lon, lat]) =>
      coords.push([lat, lon])
    );
  }

  if (result.alt_geometry && result.alt_geometry.coordinates && which === "alt") {
    result.alt_geometry.coordinates.forEach(([lon, lat]) =>
      coords.push([lat, lon])
    );
  }

  // 2) GeoJSON line under `main_geojson` / `alt_geojson`
  const key = which === "main" ? "main_geojson" : "alt_geojson";
  if (result[key] && result[key].coordinates) {
    result[key].coordinates.forEach(([lon, lat]) => coords.push([lat, lon]));
  }

  // 3) Fallback: no coords found
  return coords;
}
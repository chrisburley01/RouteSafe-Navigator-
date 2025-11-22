// RouteSafe Navigator front-end (v1.1)

// Backend API base (Python service on Render)
const API_BASE = "https://routesafe-ai.onrender.com";
const ROUTE_ENDPOINT = `${API_BASE}/api/route`;

let map;
let mainRouteLayer = null;
let altRouteLayer = null;
let bridgeLayerGroup = null;

function initMap() {
  map = L.map("map", {
    center: [53.8, -1.5], // roughly UK centre
    zoom: 6,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  bridgeLayerGroup = L.layerGroup().addTo(map);
}

// Convert ORS-style [lon, lat] coords to Leaflet [lat, lon]
function coordsToLatLngs(coords) {
  if (!Array.isArray(coords)) return [];
  // Handle either array of [lon,lat] or array of [lon,lat,?]
  return coords.map((c) => [c[1], c[0]]);
}

// Update the route summary card
function updateSummary(data) {
  const summaryCard = document.getElementById("routeSummaryCard");
  const distanceEl = document.getElementById("summaryDistance");
  const durationEl = document.getElementById("summaryDuration");
  const riskEl = document.getElementById("summaryRisk");
  const nearestEl = document.getElementById("summaryNearestBridge");
  const badge = document.getElementById("riskBadge");

  summaryCard.hidden = false;

  // Distance & duration – multiple schema fallbacks
  const distanceKm =
    data.distance_km ??
    data.summary?.distance_km ??
    data.summary?.distance ??
    null;
  const durationMin =
    data.duration_min ??
    data.summary?.duration_min ??
    data.summary?.duration ??
    null;

  distanceEl.textContent = distanceKm != null ? `${distanceKm.toFixed(1)} km` : "–";
  durationEl.textContent = durationMin != null ? `${durationMin.toFixed(1)} min` : "–";

  const warnings = data.bridge_warnings || data.warnings || [];
  const nearest = data.nearest_bridge || data.nearestBridge || null;

  if (!warnings.length) {
    riskEl.textContent = "No low-bridge conflicts detected";
    badge.textContent = "Low risk";
    badge.className = "ws-badge ws-badge--ok";
  } else {
    const conflictCount = warnings.filter((w) => w.has_conflict || w.conflict).length;
    if (conflictCount > 0) {
      riskEl.textContent = `${conflictCount} conflict(s) with vehicle height`;
      badge.textContent = "Route risk";
      badge.className = "ws-badge ws-badge--danger";
    } else {
      riskEl.textContent = `${warnings.length} nearby low bridge(s)`;
      badge.textContent = "Near limit";
      badge.className = "ws-badge ws-badge--warn";
    }
  }

  if (nearest) {
    const h = nearest.height_m ?? nearest.height ?? null;
    const d = nearest.distance_m ?? nearest.distance ?? null;
    let text = "";
    if (h != null) text += `${h.toFixed(2)} m`;
    if (d != null) text += text ? ` · ${d.toFixed(0)} m away` : `${d.toFixed(0)} m away`;
    nearestEl.textContent = text || "Shown on map";
  } else {
    nearestEl.textContent = warnings.length ? "Shown on map" : "None on route";
  }
}

// Update the warnings list
function updateWarnings(data) {
  const warningsCard = document.getElementById("warningsCard");
  const warningsList = document.getElementById("warningsList");

  const warnings = data.bridge_warnings || data.warnings || [];
  warningsList.innerHTML = "";

  if (!warnings.length) {
    warningsCard.hidden = true;
    return;
  }

  warningsCard.hidden = false;

  warnings.forEach((w) => {
    const li = document.createElement("li");
    const desc = w.description || "Low bridge";
    const height = w.height_m ?? w.height;
    const dist = w.distance_m ?? w.distance;
    let text = desc;
    if (height != null) text += ` · ${height.toFixed(2)} m`;
    if (dist != null) text += ` · ${dist.toFixed(0)} m from route`;
    li.textContent = text;
    warningsList.appendChild(li);
  });
}

// Optional: steps preview if backend returns them
function updateSteps(data) {
  const stepsCard = document.getElementById("stepsCard");
  const stepsList = document.getElementById("stepsList");
  const steps = data.steps || data.turn_by_turn || [];

  if (!steps.length) {
    stepsCard.hidden = true;
    return;
  }

  stepsCard.hidden = false;
  stepsList.innerHTML = "";
  steps.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s.instruction || s.text || s;
    stepsList.appendChild(li);
  });
}

// Draw routes & bridges on Leaflet map
function updateMap(data) {
  const emptyState = document.getElementById("mapEmptyState");
  emptyState.style.display = "none";

  // Clear old layers
  if (mainRouteLayer) {
    map.removeLayer(mainRouteLayer);
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    map.removeLayer(altRouteLayer);
    altRouteLayer = null;
  }
  bridgeLayerGroup.clearLayers();

  // Main route geometry – try a few possible field names
  const mainCoordsRaw =
    data.main_route?.geometry ||
    data.main_geometry ||
    data.geometry ||
    data.main_route ||
    null;

  if (!mainCoordsRaw || !Array.isArray(mainCoordsRaw)) {
    console.warn("No main route geometry found", data);
    return;
  }

  const mainLatLngs = coordsToLatLngs(mainCoordsRaw);
  mainRouteLayer = L.polyline(mainLatLngs, {
    color: "#4e8cff",
    weight: 5,
    opacity: 0.9,
  }).addTo(map);

  // Alternative route if available
  const altCoordsRaw =
    data.alt_route?.geometry ||
    data.alt_geometry ||
    data.alt_route ||
    null;

  if (altCoordsRaw && Array.isArray(altCoordsRaw)) {
    const altLatLngs = coordsToLatLngs(altCoordsRaw);
    altRouteLayer = L.polyline(altLatLngs, {
      color: "#9b59ff",
      weight: 4,
      opacity: 0.7,
      dashArray: "6 6",
    }).addTo(map);
  }

  // Bridge markers
  const warnings = data.bridge_warnings || data.warnings || [];
  warnings.forEach((w) => {
    const lat = w.lat ?? w.latitude;
    const lon = w.lon ?? w.longitude;
    if (lat == null || lon == null) return;

    const height = w.height_m ?? w.height;
    const hasConflict = w.has_conflict || w.conflict;

    const marker = L.circleMarker([lat, lon], {
      radius: 6,
      color: hasConflict ? "#ff5b5b" : "#ffb347",
      fillColor: hasConflict ? "#ff5b5b" : "#ffb347",
      fillOpacity: 0.9,
      weight: 1,
    });

    const desc = w.description || "Low bridge";
    let popupHtml = `<strong>${desc}</strong>`;
    if (height != null) popupHtml += `<br/>Height: ${height.toFixed(2)} m`;
    if (hasConflict) popupHtml += `<br/><span style="color:#ffaaaa;">Conflict with vehicle height</span>`;
    marker.bindPopup(popupHtml);
    bridgeLayerGroup.addLayer(marker);
  });

  // Fit map to route
  const bounds = mainRouteLayer.getBounds();
  map.fitBounds(bounds, { padding: [40, 40] });
}

// Form handling
function setupForm() {
  const form = document.getElementById("routeForm");
  const btn = document.getElementById("planRouteBtn");
  const statusEl = document.getElementById("routeStatus");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const start = document.getElementById("start").value.trim();
    const end = document.getElementById("end").value.trim();
    const heightStr = document.getElementById("vehicleHeight").value.trim();
    const avoidLowBridges = document.getElementById("avoidLowBridges").checked;

    if (!start || !end || !heightStr) {
      statusEl.textContent = "Please enter start, destination and vehicle height.";
      return;
    }

    const vehicleHeight = parseFloat(heightStr);
    if (Number.isNaN(vehicleHeight)) {
      statusEl.textContent = "Vehicle height must be a valid number (metres).";
      return;
    }

    btn.disabled = true;
    statusEl.textContent = "Requesting safe HGV route from RouteSafe-AI…";

    try {
      const response = await fetch(ROUTE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start,
          end,
          vehicle_height_m: vehicleHeight,
          avoid_low_bridges: avoidLowBridges,
        }),
      });

      const isJson = response.headers
        .get("content-type")
        ?.includes("application/json");

      if (!response.ok) {
        let detail = "Unknown error";
        if (isJson) {
          const errData = await response.json();
          if (typeof errData.detail === "string") {
            detail = errData.detail;
          } else if (Array.isArray(errData.detail) && errData.detail[0]?.msg) {
            detail = errData.detail[0].msg;
          }
        }
        statusEl.textContent = `Could not generate route: RouteSafe-AI error ${response.status}: ${detail}.`;
        return;
      }

      const data = isJson ? await response.json() : null;
      if (!data) {
        statusEl.textContent = "No data returned from RouteSafe-AI.";
        return;
      }

      console.log("RouteSafe-AI response:", data);

      updateSummary(data);
      updateWarnings(data);
      updateSteps(data);
      updateMap(data);

      statusEl.textContent = "Safe route generated.";
    } catch (err) {
      console.error(err);
      statusEl.textContent =
        "Error generating route. Check the API is up and try again.";
    } finally {
      btn.disabled = false;
    }
  });
}

// Init on load
window.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupForm();
});
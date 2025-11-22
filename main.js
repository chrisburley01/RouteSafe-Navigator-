// main.js – RouteSafe Navigator v1.0
// Frontend UI that talks to the RouteSafe-AI backend.

// 🔗 API base – RouteSafe-AI FastAPI service on Render
const API_BASE_URL = "https://routesafe-ai.onrender.com"; // adjust if your URL differs

// 🌍 Leaflet map setup
let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeMarkersLayer;

function initMap() {
  map = L.map("map").setView([53.8, -1.6], 7); // UK-ish default

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  mainRouteLayer = L.polyline([], { weight: 5 });
  altRouteLayer = L.polyline([], { weight: 4, dashArray: "6 6" });
  bridgeMarkersLayer = L.layerGroup();

  mainRouteLayer.addTo(map);
  altRouteLayer.addTo(map);
  bridgeMarkersLayer.addTo(map);
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  const form = document.getElementById("route-form");
  form.addEventListener("submit", handleRouteSubmit);
});

async function handleRouteSubmit(event) {
  event.preventDefault();

  clearStatus();
  setStatus("Requesting safe HGV route…");

  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();
  const heightM = parseFloat(
    document.getElementById("vehicle-height-m").value.trim()
  );
  const avoidLowBridges = document.getElementById("avoid-low-bridges").checked;

  if (!start || !end || isNaN(heightM) || heightM <= 0) {
    setStatus("Please enter start, end and a valid vehicle height.", "error");
    return;
  }

  const payload = {
    start,
    end,
    vehicle_height_m: heightM,
    avoid_low_bridges: avoidLowBridges,
  };

  try {
    const res = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    renderRouteResult(data);
    setStatus("Route generated using RouteSafe-AI ✅", "success");
  } catch (err) {
    console.error(err);
    setStatus(
      "Error generating route. Check start/end and try again (or engine logs).",
      "error"
    );
  }
}

// 🧠 Render route, alt route, bridges, warnings, steps, metrics
function renderRouteResult(result) {
  // 1) Route lines
  mainRouteLayer.setLatLngs([]);
  altRouteLayer.setLatLngs([]);
  bridgeMarkersLayer.clearLayers();

  if (result.geometry && result.geometry.coordinates) {
    const mainCoords = result.geometry.coordinates.map(([lon, lat]) => [
      lat,
      lon,
    ]);
    mainRouteLayer.setLatLngs(mainCoords);
  }

  if (result.alt_geometry && result.alt_geometry.coordinates) {
    const altCoords = result.alt_geometry.coordinates.map(([lon, lat]) => [
      lat,
      lon,
    ]);
    altRouteLayer.setLatLngs(altCoords);
  }

  // 2) Bridge markers
  if (Array.isArray(result.bridge_markers)) {
    result.bridge_markers.forEach((b) => {
      const color =
        b.risk_level === "high"
          ? "red"
          : b.risk_level === "medium"
          ? "orange"
          : "green";

      const marker = L.circleMarker([b.lat, b.lon], {
        radius: 7,
        weight: 2,
        color,
        fillOpacity: 0.8,
      });

      const msg =
        b.message ||
        `Bridge ${b.height_m ? b.height_m.toFixed(2) + " m" : ""} (${b.risk_level})`;
      marker.bindPopup(msg);
      bridgeMarkersLayer.addLayer(marker);
    });
  }

  // 3) Fit bounds
  const allPoints = [
    ...mainRouteLayer.getLatLngs(),
    ...altRouteLayer.getLatLngs(),
  ];
  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }

  // 4) Metrics
  const distanceKm =
    result.summary?.distance_km ?? result.distance_km ?? null;
  const durationMin =
    result.summary?.duration_min ?? result.duration_min ?? null;

  document.getElementById("metric-distance").textContent = distanceKm
    ? `${distanceKm.toFixed(1)} km`
    : "–";
  document.getElementById("metric-duration").textContent = durationMin
    ? `${durationMin.toFixed(0)} min`
    : "–";

  const bridgeRisk = result.bridge_risk || {};
  document.getElementById("metric-risk-level").textContent =
    bridgeRisk.level || "–";
  document.getElementById("metric-risk-status").textContent =
    bridgeRisk.status_text || "No status";
  document.getElementById("metric-bridge-height").textContent =
    bridgeRisk.nearest_bridge_height_m != null
      ? `${bridgeRisk.nearest_bridge_height_m.toFixed(2)} m`
      : "–";
  document.getElementById("metric-bridge-distance").textContent =
    bridgeRisk.nearest_bridge_distance_m != null
      ? `${bridgeRisk.nearest_bridge_distance_m.toFixed(0)} m`
      : "–";

  // 5) Warnings
  const warningsEl = document.getElementById("warnings-list");
  warningsEl.innerHTML = "";
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    result.warnings.forEach((w) => {
      const li = document.createElement("li");
      li.className = `warning warning-${w.level || "low"}`;
      li.textContent = w.message || "Warning";
      warningsEl.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "No additional warnings.";
    warningsEl.appendChild(li);
  }

  // 6) Turn-by-turn steps
  const stepsEl = document.getElementById("steps-list");
  stepsEl.innerHTML = "";
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    result.steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.textContent = `${i + 1}. ${s.instruction}`;
      stepsEl.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "No turn-by-turn instructions available.";
    stepsEl.appendChild(li);
  }
}

// 🧾 Status helpers
function setStatus(msg, type = "info") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = `status status-${type}`;
}

function clearStatus() {
  const el = document.getElementById("status");
  el.textContent = "";
  el.className = "status";
}
// frontend/main.js

const API_BASE = "https://routesafe-navigatorv2.onrender.com";

let map;
let mainRouteLayer;

// --- MAP ---
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  map = L.map("map").setView([53.8, -1.55], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  mainRouteLayer = L.geoJSON(null, { style: { weight: 4 } }).addTo(map);
}

function renderRouteOnMap(geometry) {
  if (!map || !mainRouteLayer) return;
  if (!geometry || !geometry.coordinates || !geometry.coordinates.length) return;

  mainRouteLayer.clearLayers();

  const feature = {
    type: "Feature",
    geometry,
    properties: {},
  };

  mainRouteLayer.addData(feature);

  try {
    const bounds = mainRouteLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  } catch {}
}

// --- UI HELPERS ---
function setRiskBadge(text) {
  const badgeEl = document.getElementById("risk-badge");
  if (!badgeEl) return;

  const value = (text || "").toLowerCase();
  badgeEl.textContent = text || "Unknown";

  badgeEl.classList.remove("risk-low", "risk-medium", "risk-high");

  if (value.includes("low")) badgeEl.classList.add("risk-low");
  else if (value.includes("medium")) badgeEl.classList.add("risk-medium");
  else if (value.includes("high")) badgeEl.classList.add("risk-high");
  else badgeEl.classList.add("risk-low");
}

function showError(msg) {
  console.error("RouteSafe error:", msg);
  const banner = document.getElementById("error-banner");
  const text = document.getElementById("error-text");
  const statusLine = document.getElementById("status-line");

  if (text) text.textContent = msg;
  if (banner) banner.style.display = "block";
  if (statusLine) statusLine.textContent = "Error contacting RouteSafe API.";

  if (!banner) alert(msg);
}

// --- API CALL ---
async function callRouteSafeAPI(payload) {
  const statusLine = document.getElementById("status-line");
  if (statusLine) statusLine.textContent = "Contacting RouteSafe API…";

  const res = await fetch(`${API_BASE}/api/route`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let extra = "";
    try {
      const body = await res.json();
      if (body && body.detail) {
        extra =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail);
      }
    } catch {}

    const baseMsg = `Error from RouteSafe API (${res.status})`;
    const msg = extra ? `${baseMsg}: ${extra}` : `${baseMsg}.`;
    throw new Error(msg);
  }

  const data = await res.json();
  if (statusLine) statusLine.textContent = "Route generated successfully.";
  return data;
}

// --- MAIN HANDLER ---
async function handleGenerate(e) {
  if (e) e.preventDefault(); // stop any form submit just in case

  const startInput = document.getElementById("start-postcode");
  const destInput = document.getElementById("dest-postcode");
  const heightInput = document.getElementById("vehicle-height");
  const avoidToggle = document.getElementById("avoid-low-bridges");

  const distanceValue = document.getElementById("distance-value");
  const timeValue = document.getElementById("time-value");
  const bridgeRiskValue = document.getElementById("bridge-risk-value");
  const nearestBridgeValue = document.getElementById("nearest-bridge-value");
  const generateBtn = document.getElementById("generate-route-btn");

  if (!startInput || !destInput || !heightInput || !generateBtn) {
    showError("Frontend inputs/buttons not found. Check element IDs.");
    return;
  }

  const start = startInput.value.trim();
  const dest = destInput.value.trim();
  const heightStr = heightInput.value.trim();
  const avoid = !!(avoidToggle && avoidToggle.checked);

  if (!start || !dest || !heightStr) {
    showError("Please enter start location, destination and vehicle height.");
    return;
  }

  const vehicleHeight = parseFloat(heightStr);
  if (!vehicleHeight || vehicleHeight <= 0) {
    showError("Please enter a valid vehicle height in metres.");
    return;
  }

  const payload = {
    start_postcode: start,
    dest_postcode: dest,
    vehicle_height_m: vehicleHeight,
    avoid_low_bridges: avoid,
  };

  const originalLabel = generateBtn.textContent;
  generateBtn.disabled = true;
  generateBtn.textContent = "Planning…";

  try {
    const result = await callRouteSafeAPI(payload);

    if (distanceValue) {
      distanceValue.textContent =
        typeof result.distance_km === "number"
          ? `${result.distance_km.toFixed(1)} km`
          : "–";
    }

    if (timeValue) {
      timeValue.textContent =
        typeof result.duration_min === "number"
          ? `${result.duration_min.toFixed(0)} min`
          : "–";
    }

    if (bridgeRiskValue) {
      bridgeRiskValue.textContent = result.bridge_risk || "Unknown";
    }

    setRiskBadge(result.bridge_risk || "Unknown");

    if (nearestBridgeValue) {
      const h = result.nearest_bridge_height_m;
      const d = result.nearest_bridge_distance_m;
      if (h == null || d == null) {
        nearestBridgeValue.textContent = "None on route";
      } else {
        nearestBridgeValue.textContent = `${h.toFixed(
          2
        )} m, ${d.toFixed(0)} m away`;
      }
    }

    renderRouteOnMap(result.geometry);
  } catch (err) {
    showError(err.message || "Unknown API error");
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = originalLabel || "Generate safe route";
  }
}

// --- WIRING ---
document.addEventListener("DOMContentLoaded", () => {
  initMap();

  const generateBtn = document.getElementById("generate-route-btn");
  const routeForm = document.getElementById("route-form");

  if (generateBtn) {
    generateBtn.addEventListener("click", handleGenerate);
  }

  if (routeForm) {
    routeForm.addEventListener("submit", handleGenerate);
  }
});
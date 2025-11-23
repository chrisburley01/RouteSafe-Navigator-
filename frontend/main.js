// frontend/main.js

// Python API base URL (your FastAPI service)
const API_BASE = "https://routesafe-navigatorv2.onrender.com";

const form = document.getElementById("route-form");
const startInput = document.getElementById("start-postcode");
const destInput = document.getElementById("dest-postcode");
const heightInput = document.getElementById("vehicle-height");
const avoidToggle = document.getElementById("avoid-low-bridges");

const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");

const statusLine = document.getElementById("status-line");

const riskBadge = document.getElementById("risk-badge");
const distanceValue = document.getElementById("distance-value");
const timeValue = document.getElementById("time-value");
const bridgeRiskValue = document.getElementById("bridge-risk-value");
const nearestBridgeValue = document.getElementById("nearest-bridge-value");

// Leaflet map setup
let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;

function initMap() {
  map = L.map("map").setView([53.8, -1.55], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  mainRouteLayer = L.geoJSON(null, { style: { weight: 4 } }).addTo(map);
  altRouteLayer = L.geoJSON(null, { style: { weight: 4, dashArray: "6 6" } }).addTo(map);
  bridgeLayer = L.layerGroup().addTo(map);
}

function setRiskBadge(riskText) {
  riskBadge.textContent = riskText;

  riskBadge.classList.remove("risk-low", "risk-medium", "risk-high");

  const normalized = (riskText || "").toLowerCase();

  if (normalized.includes("low")) {
    riskBadge.classList.add("risk-low");
  } else if (normalized.includes("medium")) {
    riskBadge.classList.add("risk-medium");
  } else if (normalized.includes("high")) {
    riskBadge.classList.add("risk-high");
  } else {
    riskBadge.classList.add("risk-low");
  }
}

function showError(message) {
  errorText.textContent = message;
  errorBanner.style.display = "block";
}

function hideError() {
  errorBanner.style.display = "none";
  errorText.textContent = "";
}

async function callRouteSafeAPI(payload) {
  hideError();
  statusLine.textContent = "Contacting RouteSafe API…";

  try {
    const response = await fetch(`${API_BASE}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Try to extract FastAPI error details
      let extra = "";
      try {
        const errJson = await response.json();
        if (errJson && errJson.detail) {
          if (typeof errJson.detail === "string") {
            extra = errJson.detail;
          } else {
            extra = JSON.stringify(errJson.detail);
          }
        }
      } catch (e) {
        // ignore JSON parse errors
      }

      const baseMsg = `Error from RouteSafe API (${response.status})`;
      const fullMsg = extra ? `${baseMsg}: ${extra}` : `${baseMsg}. Try again or check logs.`;
      throw new Error(fullMsg);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.error("RouteSafe API error", err);
    showError(err.message || "Unknown error from RouteSafe API.");
    statusLine.textContent = "Error contacting RouteSafe API.";
    throw err;
  }
}

function renderRouteOnMap(geometry) {
  mainRouteLayer.clearLayers();
  altRouteLayer.clearLayers();
  bridgeLayer.clearLayers();

  if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
    return;
  }

  const geojson = {
    type: "Feature",
    geometry: geometry,
    properties: {},
  };

  mainRouteLayer.addData(geojson);

  try {
    const bounds = mainRouteLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  } catch (e) {
    console.warn("Error fitting bounds:", e);
  }
}

function updateSummaryFromResponse(data) {
  const {
    distance_km,
    duration_min,
    bridge_risk,
    nearest_bridge_height_m,
    nearest_bridge_distance_m,
  } = data;

  distanceValue.textContent =
    typeof distance_km === "number" ? `${distance_km.toFixed(1)} km` : "–";

  timeValue.textContent =
    typeof duration_min === "number" ? `${duration_min.toFixed(0)} min` : "–";

  bridgeRiskValue.textContent = bridge_risk || "Unknown";
  setRiskBadge(bridge_risk || "Unknown");

  if (nearest_bridge_height_m == null || nearest_bridge_distance_m == null) {
    nearestBridgeValue.textContent = "None on route";
  } else {
    nearestBridgeValue.textContent = `${nearest_bridge_height_m.toFixed(
      2
    )} m, ${nearest_bridge_distance_m.toFixed(0)} m away`;
  }

  statusLine.textContent = "Route generated successfully.";
}

form.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  hideError();

  const start = startInput.value.trim();
  const dest = destInput.value.trim();
  const vehicleHeightStr = heightInput.value.trim();
  const avoid = !!avoidToggle.checked;

  if (!start || !dest || !vehicleHeightStr) {
    showError("Please enter start, destination, and vehicle height.");
    return;
  }

  const vehicleHeight = parseFloat(vehicleHeightStr);
  if (Number.isNaN(vehicleHeight) || vehicleHeight <= 0) {
    showError("Please enter a valid vehicle height in metres.");
    return;
  }

  const payload = {
    start_postcode: start,
    dest_postcode: dest,
    vehicle_height_m: vehicleHeight,
    avoid_low_bridges: avoid,
  };

  statusLine.textContent = "Planning route…";

  try {
    const result = await callRouteSafeAPI(payload);
    updateSummaryFromResponse(result);
    renderRouteOnMap(result.geometry);
  } catch (err) {
    // error already shown
  }
});

document.addEventListener("DOMContentLoaded", initMap);
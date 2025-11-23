// frontend/main.js

// Python API base URL (FastAPI service on Render)
const API_BASE = "https://routesafe-navigatorv2.onrender.com";

let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.error("Map container with id 'map' not found.");
    return;
  }

  map = L.map("map").setView([53.8, -1.55], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  mainRouteLayer = L.geoJSON(null, { style: { weight: 4 } }).addTo(map);
  altRouteLayer = L.geoJSON(null, { style: { weight: 4, dashArray: "6 6" } }).addTo(map);
  bridgeLayer = L.layerGroup().addTo(map);
}

function setRiskBadge(riskText, riskBadge) {
  if (!riskBadge) return;

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

function showError(message, errorBanner, errorText, statusLine) {
  if (errorText && errorBanner) {
    errorText.textContent = message;
    errorBanner.style.display = "block";
  }
  if (statusLine) {
    statusLine.textContent = "Error contacting RouteSafe API.";
  }
}

function hideError(errorBanner, errorText) {
  if (errorBanner) errorBanner.style.display = "none";
  if (errorText) errorText.textContent = "";
}

async function callRouteSafeAPI(payload, errorBanner, errorText, statusLine) {
  hideError(errorBanner, errorText);
  if (statusLine) statusLine.textContent = "Contacting RouteSafe API…";

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
        // ignore JSON parse issues
      }

      const baseMsg = `Error from RouteSafe API (${response.status})`;
      const fullMsg = extra ? `${baseMsg}: ${extra}` : `${baseMsg}. Try again or check logs.`;
      throw new Error(fullMsg);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.error("RouteSafe API error", err);
    showError(err.message || "Unknown error from RouteSafe API.", errorBanner, errorText, statusLine);
    throw err;
  }
}

function renderRouteOnMap(geometry) {
  if (!map || !mainRouteLayer || !geometry) return;

  mainRouteLayer.clearLayers();
  altRouteLayer.clearLayers();
  bridgeLayer.clearLayers();

  if (!geometry.coordinates || geometry.coordinates.length === 0) {
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

function updateSummaryFromResponse(data, ui) {
  const {
    distance_km,
    duration_min,
    bridge_risk,
    nearest_bridge_height_m,
    nearest_bridge_distance_m,
  } = data;

  const {
    distanceValue,
    timeValue,
    bridgeRiskValue,
    nearestBridgeValue,
    riskBadge,
    statusLine,
  } = ui;

  if (distanceValue) {
    distanceValue.textContent =
      typeof distance_km === "number" ? `${distance_km.toFixed(1)} km` : "–";
  }

  if (timeValue) {
    timeValue.textContent =
      typeof duration_min === "number" ? `${duration_min.toFixed(0)} min` : "–";
  }

  if (bridgeRiskValue) {
    bridgeRiskValue.textContent = bridge_risk || "Unknown";
  }

  setRiskBadge(bridge_risk || "Unknown", riskBadge);

  if (nearestBridgeValue) {
    if (nearest_bridge_height_m == null || nearest_bridge_distance_m == null) {
      nearestBridgeValue.textContent = "None on route";
    } else {
      nearestBridgeValue.textContent = `${nearest_bridge_height_m.toFixed(
        2
      )} m, ${nearest_bridge_distance_m.toFixed(0)} m away`;
    }
  }

  if (statusLine) statusLine.textContent = "Route generated successfully.";
}

// Wait for DOM *then* wire everything up
document.addEventListener("DOMContentLoaded", () => {
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

  // Initialise map
  initMap();

  if (!form) {
    console.error("Form with id 'route-form' not found – cannot bind submit handler.");
    return;
  }

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    hideError(errorBanner, errorText);

    const start = startInput ? startInput.value.trim() : "";
    const dest = destInput ? destInput.value.trim() : "";
    const vehicleHeightStr = heightInput ? heightInput.value.trim() : "";
    const avoid = !!(avoidToggle && avoidToggle.checked);

    if (!start || !dest || !vehicleHeightStr) {
      showError("Please enter start, destination, and vehicle height.", errorBanner, errorText, statusLine);
      return;
    }

    const vehicleHeight = parseFloat(vehicleHeightStr);
    if (Number.isNaN(vehicleHeight) || vehicleHeight <= 0) {
      showError("Please enter a valid vehicle height in metres.", errorBanner, errorText, statusLine);
      return;
    }

    const payload = {
      start_postcode: start,
      dest_postcode: dest,
      vehicle_height_m: vehicleHeight,
      avoid_low_bridges: avoid,
    };

    if (statusLine) statusLine.textContent = "Planning route…";

    try {
      const result = await callRouteSafeAPI(payload, errorBanner, errorText, statusLine);
      updateSummaryFromResponse(result, {
        distanceValue,
        timeValue,
        bridgeRiskValue,
        nearestBridgeValue,
        riskBadge,
        statusLine,
      });
      renderRouteOnMap(result.geometry);
    } catch (err) {
      // error already shown in callRouteSafeAPI
    }
  });
});
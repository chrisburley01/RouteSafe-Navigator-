// frontend/main.js

// ===== CONFIG =====
const API_BASE = "https://routesafe-navigatorv2.onrender.com";

// ===== MAP SETUP =====
let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.error("Map container #map not found");
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

function renderRouteOnMap(geometry) {
  if (!map || !mainRouteLayer || !geometry) return;

  mainRouteLayer.clearLayers();
  altRouteLayer.clearLayers();
  bridgeLayer.clearLayers();

  if (!geometry.coordinates || geometry.coordinates.length === 0) return;

  const feature = {
    type: "Feature",
    geometry,
    properties: {},
  };

  mainRouteLayer.addData(feature);
  try {
    const bounds = mainRouteLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  } catch (err) {
    console.warn("Error fitting bounds:", err);
  }
}

// ===== UI HELPERS =====
function setRiskBadge(text, badgeEl) {
  if (!badgeEl) return;

  const value = (text || "").toLowerCase();
  badgeEl.textContent = text || "Unknown";

  badgeEl.classList.remove("risk-low", "risk-medium", "risk-high");

  if (value.includes("low")) {
    badgeEl.classList.add("risk-low");
  } else if (value.includes("medium")) {
    badgeEl.classList.add("risk-medium");
  } else if (value.includes("high")) {
    badgeEl.classList.add("risk-high");
  } else {
    badgeEl.classList.add("risk-low");
  }
}

function showError(msg, errorBanner, errorText, statusLine) {
  console.error("RouteSafe error:", msg);
  if (errorText) errorText.textContent = msg;
  if (errorBanner) errorBanner.style.display = "block";
  if (statusLine) statusLine.textContent = "Error contacting RouteSafe API.";
}

function clearError(errorBanner, errorText) {
  if (errorBanner) errorBanner.style.display = "none";
  if (errorText) errorText.textContent = "";
}

// ===== API CALL =====
async function callRouteSafeAPI(payload, errorBanner, errorText, statusLine) {
  clearError(errorBanner, errorText);
  if (statusLine) statusLine.textContent = "Contacting RouteSafe API…";

  try {
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
          extra = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
        }
      } catch (_) {
        // ignore parse error
      }
      const baseMsg = `Error from RouteSafe API (${res.status})`;
      const msg = extra ? `${baseMsg}: ${extra}` : `${baseMsg}. Try again or check logs.`;
      throw new Error(msg);
    }

    const data = await res.json();
    return data;
  } catch (err) {
    showError(err.message || "Unknown API error", errorBanner, errorText, statusLine);
    throw err;
  }
}

// ===== MAIN WIRING =====
document.addEventListener("DOMContentLoaded", () => {
  // Inputs
  const form = document.getElementById("route-form");
  const startInput = document.getElementById("start-postcode");
  const destInput = document.getElementById("dest-postcode");
  const heightInput = document.getElementById("vehicle-height");
  const avoidToggle = document.getElementById("avoid-low-bridges");

  // Status + error
  const errorBanner = document.getElementById("error-banner");
  const errorText = document.getElementById("error-text");
  const statusLine = document.getElementById("status-line");

  // Summary
  const distanceValue = document.getElementById("distance-value");
  const timeValue = document.getElementById("time-value");
  const bridgeRiskValue = document.getElementById("bridge-risk-value");
  const nearestBridgeValue = document.getElementById("nearest-bridge-value");
  const riskBadge = document.getElementById("risk-badge");

  // Button (for spinner text)
  const submitBtn = document.querySelector("#route-form button[type='submit']");

  // Init map
  initMap();

  if (!form) {
    console.error("Form #route-form not found - JS not wired.");
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault(); // stop page refresh
    clearError(errorBanner, errorText);

    const start = startInput ? startInput.value.trim() : "";
    const dest = destInput ? destInput.value.trim() : "";
    const heightStr = heightInput ? heightInput.value.trim() : "";
    const avoid = !!(avoidToggle && avoidToggle.checked);

    if (!start || !dest || !heightStr) {
      showError("Please enter start, destination and vehicle height.", errorBanner, errorText, statusLine);
      return;
    }

    const vehicleHeight = parseFloat(heightStr);
    if (!vehicleHeight || vehicleHeight <= 0) {
      showError("Please enter a valid vehicle height in metres.", errorBanner, errorText, statusLine);
      return;
    }

    const payload = {
      start_postcode: start,
      dest_postcode: dest,
      vehicle_height_m: vehicleHeight,
      avoid_low_bridges: avoid,
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Planning…";
    }
    if (statusLine) statusLine.textContent = "Planning route…";

    try {
      const result = await callRouteSafeAPI(payload, errorBanner, errorText, statusLine);

      // Update summary
      if (distanceValue) {
        distanceValue.textContent =
          typeof result.distance_km === "number" ? `${result.distance_km.toFixed(1)} km` : "–";
      }
      if (timeValue) {
        timeValue.textContent =
          typeof result.duration_min === "number" ? `${result.duration_min.toFixed(0)} min` : "–";
      }
      if (bridgeRiskValue) bridgeRiskValue.textContent = result.bridge_risk || "Unknown";

      setRiskBadge(result.bridge_risk || "Unknown", riskBadge);

      if (nearestBridgeValue) {
        const h = result.nearest_bridge_height_m;
        const d = result.nearest_bridge_distance_m;
        if (h == null || d == null) {
          nearestBridgeValue.textContent = "None on route";
        } else {
          nearestBridgeValue.textContent = `${h.toFixed(2)} m, ${d.toFixed(0)} m away`;
        }
      }

      if (statusLine) statusLine.textContent = "Route generated successfully.";
      renderRouteOnMap(result.geometry);
    } catch (err) {
      // error already displayed
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Generate safe route";
      }
    }
  });
});
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
  if (!map || !mainRouteLayer) return;

  // Only touch the map if we actually have coordinates
  if (
    !geometry ||
    !geometry.type ||
    !geometry.coordinates ||
    !geometry.coordinates.length
  ) {
    console.warn("No geometry in API response; keeping existing map.");
    return;
  }

  mainRouteLayer.clearLayers();
  altRouteLayer.clearLayers();
  bridgeLayer.clearLayers();

  const feature = {
    type: "Feature",
    geometry,
    properties: {},
  };

  mainRouteLayer.addData(feature);

  try {
    const bounds = mainRouteLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
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

function showVisibleError(msg) {
  console.error("RouteSafe error:", msg);
  // Banner if it exists
  const errorBanner = document.getElementById("error-banner");
  const errorText = document.getElementById("error-text");
  const statusLine = document.getElementById("status-line");

  if (errorText) errorText.textContent = msg;
  if (errorBanner) errorBanner.style.display = "block";
  if (statusLine) statusLine.textContent = "Error contacting RouteSafe API.";

  // Fallback so *you definitely see it*
  if (!errorBanner) {
    alert(msg);
  }
}

// ===== API CALL =====
async function callRouteSafeAPI(payload) {
  const statusLine = document.getElementById("status-line");
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
          extra =
            typeof body.detail === "string"
              ? body.detail
              : JSON.stringify(body.detail);
        }
      } catch (_) {
        // ignore
      }
      const baseMsg = `Error from RouteSafe API (${res.status})`;
      const msg = extra ? `${baseMsg}: ${extra}` : `${baseMsg}.`;
      throw new Error(msg);
    }

    const data = await res.json();
    if (statusLine) statusLine.textContent = "Route generated successfully.";
    return data;
  } catch (err) {
    showVisibleError(err.message || "Unknown API error");
    throw err;
  }
}

// ===== MAIN WIRING =====
document.addEventListener("DOMContentLoaded", () => {
  initMap();

  // Try a few possible IDs for inputs to be safe
  const startInput =
    document.getElementById("start-location") ||
    document.getElementById("start-postcode") ||
    document.getElementById("start-postcode-input");

  const destInput =
    document.getElementById("destination") ||
    document.getElementById("dest-postcode") ||
    document.getElementById("dest-postcode-input");

  const heightInput =
    document.getElementById("vehicle-height") ||
    document.getElementById("vehicle-height-m") ||
    document.getElementById("vehicle-height-input");

  const avoidToggle =
    document.getElementById("avoid-low-bridges-toggle") ||
    document.getElementById("avoid-low-bridges");

  const generateBtn =
    document.getElementById("generate-route-btn") ||
    document.querySelector("button[data-role='generate-route']");

  const distanceValue = document.getElementById("distance-value");
  const timeValue = document.getElementById("time-value");
  const bridgeRiskValue = document.getElementById("bridge-risk-value");
  const nearestBridgeValue = document.getElementById("nearest-bridge-value");
  const riskBadge = document.getElementById("risk-badge");

  if (!generateBtn) {
    console.error(
      "Generate button not found (expected id='generate-route-btn')."
    );
    return;
  }

  generateBtn.addEventListener("click", async (e) => {
    e.preventDefault(); // stop any default form submit
    const start = startInput ? startInput.value.trim() : "";
    const dest = destInput ? destInput.value.trim() : "";
    const heightStr = heightInput ? heightInput.value.trim() : "";
    const avoid = !!(avoidToggle && avoidToggle.checked);

    if (!start || !dest || !heightStr) {
      showVisibleError(
        "Please enter start location, destination and vehicle height."
      );
      return;
    }

    const vehicleHeight = parseFloat(heightStr);
    if (!vehicleHeight || vehicleHeight <= 0) {
      showVisibleError("Please enter a valid vehicle height in metres.");
      return;
    }

    const payload = {
      start_postcode: start,
      dest_postcode: dest,
      vehicle_height_m: vehicleHeight,
      avoid_low_bridges: avoid,
    };

    const originalText = generateBtn.textContent;
    generateBtn.disabled = true;
    generateBtn.textContent = "Planning…";

    try {
      const result = await callRouteSafeAPI(payload);

      // Update summary
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

      setRiskBadge(result.bridge_risk || "Unknown", riskBadge);

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

      // Draw route (only if geometry is valid; otherwise leaves old map)
      renderRouteOnMap(result.geometry);
    } catch (err) {
      // Error already surfaced
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = originalText || "Generate safe route";
    }
  });
});
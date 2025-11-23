// frontend/main.js

// *** CONFIG ***
const API_BASE_URL = "https://routesafe-navigatorv2.onrender.com";

// Leaflet map + layers
let map;
let mainRouteLayer = null;
let altRouteLayer = null;
let hazardLayerGroup = null;

function initMap() {
  map = L.map("map").setView([53.8, -1.6], 6); // UK-ish centre

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  hazardLayerGroup = L.layerGroup().addTo(map);
}

function setStatus(message, type = "info") {
  const statusEl = document.getElementById("routeStatusText");
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.classList.remove("status-info", "status-error", "status-success");
  statusEl.classList.add(
    type === "error" ? "status-error" :
    type === "success" ? "status-success" :
    "status-info"
  );
}

function setError(message) {
  const errorEl = document.getElementById("errorBanner");
  if (!errorEl) return;

  errorEl.textContent = message;
  errorEl.style.display = message ? "block" : "none";
}

// Update summary card
function updateSummary(data) {
  const distanceEl = document.getElementById("distanceText");
  const timeEl = document.getElementById("timeText");
  const bridgeRiskEl = document.getElementById("bridgeRiskText");
  const nearestBridgeEl = document.getElementById("nearestBridgeText");

  if (distanceEl) {
    distanceEl.textContent =
      data.distance_km != null ? `${data.distance_km.toFixed(1)} km` : "–";
  }

  if (timeEl) {
    timeEl.textContent =
      data.duration_min != null ? `${Math.round(data.duration_min)} min` : "–";
  }

  if (bridgeRiskEl) {
    bridgeRiskEl.textContent = data.bridge_risk || "Unknown";
    bridgeRiskEl.className = ""; // reset
    bridgeRiskEl.classList.add("risk-pill");
    if (data.bridge_risk === "Low risk") {
      bridgeRiskEl.classList.add("risk-low");
    } else if (data.bridge_risk === "Medium risk") {
      bridgeRiskEl.classList.add("risk-medium");
    } else if (data.bridge_risk === "High risk") {
      bridgeRiskEl.classList.add("risk-high");
    }
  }

  if (nearestBridgeEl) {
    if (
      data.nearest_bridge_height_m != null &&
      data.nearest_bridge_distance_m != null
    ) {
      nearestBridgeEl.textContent =
        `${data.nearest_bridge_height_m.toFixed(2)} m ` +
        `at ${data.nearest_bridge_distance_m.toFixed(0)} m from route`;
    } else {
      nearestBridgeEl.textContent = "None on route";
    }
  }
}

// Draw route + hazards on the map
function updateMap(data) {
  if (!map) return;

  // Clear old layers
  if (mainRouteLayer) {
    map.removeLayer(mainRouteLayer);
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    map.removeLayer(altRouteLayer);
    altRouteLayer = null;
  }
  if (hazardLayerGroup) {
    hazardLayerGroup.clearLayers();
  }

  // Main route geometry (GeoJSON-like: { type: "LineString", coordinates: [[lon, lat], ...] })
  if (data.geometry && Array.isArray(data.geometry.coordinates)) {
    const coords = data.geometry.coordinates;

    const leafletCoords = coords.map((pt) => {
      if (!Array.isArray(pt) || pt.length < 2) return null;
      const [lon, lat] = pt;
      return [lat, lon]; // Leaflet wants [lat, lon]
    }).filter(Boolean);

    if (leafletCoords.length > 0) {
      mainRouteLayer = L.polyline(leafletCoords, {
        weight: 5,
      }).addTo(map);
      map.fitBounds(mainRouteLayer.getBounds(), { padding: [30, 30] });
    }
  }

  // Optional: alternative route
  if (
    data.alt_geometry &&
    Array.isArray(data.alt_geometry.coordinates)
  ) {
    const coordsAlt = data.alt_geometry.coordinates;
    const leafletCoordsAlt = coordsAlt.map((pt) => {
      if (!Array.isArray(pt) || pt.length < 2) return null;
      const [lon, lat] = pt;
      return [lat, lon];
    }).filter(Boolean);

    if (leafletCoordsAlt.length > 0) {
      altRouteLayer = L.polyline(leafletCoordsAlt, {
        weight: 4,
        dashArray: "6 6",
      }).addTo(map);
    }
  }

  // Optional: low-bridge / hazard markers
  if (Array.isArray(data.hazards) && hazardLayerGroup) {
    data.hazards.forEach((h) => {
      if (h.lat != null && h.lon != null) {
        const marker = L.circleMarker([h.lat, h.lon], {
          radius: 5,
        }).addTo(hazardLayerGroup);
        if (h.label) {
          marker.bindPopup(h.label);
        }
      }
    });
  }
}

// Main submit handler
async function handleGenerateRoute() {
  setError("");
  setStatus("Generating route…", "info");

  const startInput = document.getElementById("startPostcode");
  const destInput = document.getElementById("destPostcode");
  const heightInput = document.getElementById("vehicleHeight");
  const avoidToggle = document.getElementById("avoidLowBridges");

  if (!startInput || !destInput || !heightInput || !avoidToggle) {
    setError("Form fields missing in the page.");
    setStatus("Error", "error");
    return;
  }

  const start_postcode = startInput.value.trim();
  const dest_postcode = destInput.value.trim();
  const heightStr = heightInput.value.trim();
  const avoid_low_bridges = avoidToggle.checked;

  if (!start_postcode || !dest_postcode || !heightStr) {
    setError("Please fill in all fields before generating a route.");
    setStatus("Missing details", "error");
    return;
  }

  const vehicle_height_m = parseFloat(heightStr);
  if (Number.isNaN(vehicle_height_m) || vehicle_height_m <= 0) {
    setError("Vehicle height must be a positive number in metres.");
    setStatus("Invalid vehicle height", "error");
    return;
  }

  const payload = {
    start_postcode,
    dest_postcode,
    vehicle_height_m,
    avoid_low_bridges,
  };

  console.log("Sending to API:", API_BASE_URL + "/api/route", payload);

  try {
    const response = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("API error:", response.status, text);
      setError(
        `Error from RouteSafe API (${response.status}). Try again or check logs.`
      );
      setStatus("Error generating route", "error");
      return;
    }

    const data = await response.json();
    console.log("API response:", data);

    updateSummary(data);
    updateMap(data);

    setStatus("Route generated successfully.", "success");
  } catch (err) {
    console.error("Network/JS error calling API:", err);
    setError("Error generating route. Check the API is up and try again.");
    setStatus("Error generating route", "error");
  }
}

// Initialise everything when the page loads
document.addEventListener("DOMContentLoaded", () => {
  try {
    initMap();
  } catch (err) {
    console.error("Error initialising map:", err);
  }

  const btn = document.getElementById("generateRouteBtn");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      handleGenerateRoute();
    });
  }
});
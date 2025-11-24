// Base URL of the Python backend (v2 service on Render)
const API_URL = "https://routesafe-navigatorv2.onrender.com/api/route";

// Leaflet map + layers
let map;
let mainRouteLayer = null;
let altRouteLayer = null;
let bridgeMarkers = [];

// Helpers -------------------------------------------------

function showError(message) {
  const banner = document.getElementById("errorBanner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function clearError() {
  const banner = document.getElementById("errorBanner");
  banner.textContent = "";
  banner.classList.add("hidden");
}

function setRiskBadge(level) {
  const badge = document.getElementById("riskBadge");
  badge.textContent = level ? level.charAt(0).toUpperCase() + level.slice(1) : "Low";

  badge.classList.remove("risk-low", "risk-medium", "risk-high");

  switch ((level || "").toLowerCase()) {
    case "high":
      badge.classList.add("risk-high");
      break;
    case "medium":
      badge.classList.add("risk-medium");
      break;
    default:
      badge.classList.add("risk-low");
  }
}

function updateSummary(data) {
  // We are defensive here because backend may evolve
  const summary = data.summary || {};
  const bridge = data.bridge || {};
  const riskLevel = data.risk_level || "low";

  const distanceKm =
    typeof summary.distance_km === "number"
      ? summary.distance_km.toFixed(1) + " km"
      : "–";

  const durationMin =
    typeof summary.duration_minutes === "number"
      ? Math.round(summary.duration_minutes) + " min"
      : "–";

  let bridgeRiskText = "No low-bridge conflicts detected";
  if (bridge.has_conflict) {
    bridgeRiskText = "Low bridge conflict on route";
  } else if (bridge.near_height_limit) {
    bridgeRiskText = "Near vehicle height limit";
  }

  let nearestBridgeText = "None on route";
  if (bridge.nearest_bridge && typeof bridge.nearest_distance_m === "number") {
    const b = bridge.nearest_bridge;
    const dist = bridge.nearest_distance_m.toFixed(0);
    nearestBridgeText = `${b.height_m.toFixed(2)} m · ${dist} m away`;
  }

  document.getElementById("distanceValue").textContent = distanceKm;
  document.getElementById("etaValue").textContent = durationMin;
  document.getElementById("bridgeRiskText").textContent = bridgeRiskText;
  document.getElementById("nearestBridgeText").textContent = nearestBridgeText;

  setRiskBadge(riskLevel);
}

function clearMapLayers() {
  if (mainRouteLayer) {
    mainRouteLayer.remove();
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    altRouteLayer.remove();
    altRouteLayer = null;
  }
  bridgeMarkers.forEach((m) => m.remove());
  bridgeMarkers = [];
}

function drawRouteOnMap(data) {
  if (!map) return;

  clearMapLayers();

  const route = data.route || data.main_route;
  const altRoute = data.alternative_route || data.alt_route;
  const lowBridges = data.low_bridges_on_route || data.low_bridges || [];

  const boundsPoints = [];

  // Main route polyline
  if (route && Array.isArray(route.coordinates)) {
    const latLngs = route.coordinates.map(([lon, lat]) => [lat, lon]);
    mainRouteLayer = L.polyline(latLngs, { weight: 4, className: "route-main" }).addTo(
      map
    );
    boundsPoints.push(...latLngs);
  }

  // Alternative route polyline
  if (altRoute && Array.isArray(altRoute.coordinates)) {
    const latLngsAlt = altRoute.coordinates.map(([lon, lat]) => [lat, lon]);
    altRouteLayer = L.polyline(latLngsAlt, {
      weight: 4,
      dashArray: "6 6",
      className: "route-alt",
    }).addTo(map);
    boundsPoints.push(...latLngsAlt);
  }

  // Low bridge markers
  lowBridges.forEach((b) => {
    if (typeof b.lat === "number" && typeof b.lon === "number") {
      const marker = L.circleMarker([b.lat, b.lon], {
        radius: 6,
        className: "bridge-marker",
      }).addTo(map);
      marker.bindPopup(`Low bridge<br/>Height: ${b.height_m} m`);
      bridgeMarkers.push(marker);
      boundsPoints.push([b.lat, b.lon]);
    }
  });

  if (boundsPoints.length) {
    map.fitBounds(boundsPoints, { padding: [40, 40] });
  }
}

// Form / API -------------------------------------------------

async function handleGenerateRoute(event) {
  event.preventDefault();
  clearError();

  const start = document.getElementById("startPostcode").value.trim();
  const dest = document.getElementById("destPostcode").value.trim();
  const heightStr = document.getElementById("vehicleHeight").value.trim();
  const avoid = document.getElementById("avoidLowBridges").checked;

  if (!start || !dest || !heightStr) {
    showError("Please enter start, destination, and vehicle height.");
    return;
  }

  const height = parseFloat(heightStr);
  if (Number.isNaN(height) || height <= 0) {
    showError("Vehicle height must be a valid number in metres.");
    return;
  }

  const button = document.getElementById("generateRouteBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Generating…";

  try {
    const payload = {
      start_postcode: start,
      dest_postcode: dest,
      vehicle_height_m: height,
      avoid_low_bridges: avoid,
    };

    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Try to read any error JSON for more detail
      let detail = "";
      try {
        const errJson = await response.json();
        detail = errJson.error || errJson.detail || "";
      } catch (_) {
        // ignore
      }
      const baseMsg =
        response.status === 500
          ? "Error from RouteSafe engine (status 500)."
          : `RouteSafe engine error (status ${response.status}).`;

      showError(detail ? `${baseMsg} ${detail}` : baseMsg);
      return;
    }

    const data = await response.json();

    if (data.status && data.status !== "ok") {
      showError(data.message || "RouteSafe engine returned an error.");
      return;
    }

    updateSummary(data);
    drawRouteOnMap(data);
  } catch (err) {
    console.error("Error calling API:", err);
    showError("Error contacting RouteSafe engine. Please try again.");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// Init -------------------------------------------------

function initMap() {
  map = L.map("map", {
    center: [53.8, -1.6], // roughly Leeds
    zoom: 6,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();

  const form = document.getElementById("routeForm");
  form.addEventListener("submit", handleGenerateRoute);
});

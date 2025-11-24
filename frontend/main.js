// ===== CONFIG =====
const API_BASE_URL = "https://routesafe-navigatorv2.onrender.com";

// ===== DOM =====
const form = document.getElementById("routeForm");
const toastEl = document.getElementById("toast");

const startInput = document.getElementById("startPostcode");
const destInput = document.getElementById("destPostcode");
const heightInput = document.getElementById("vehicleHeight");
const avoidCheckbox = document.getElementById("avoidLowBridges");

const distanceValue = document.getElementById("distanceValue");
const durationValue = document.getElementById("durationValue");
const bridgeRiskValue = document.getElementById("bridgeRiskValue");
const nearestBridgeValue = document.getElementById("nearestBridgeValue");
const riskBadge = document.getElementById("riskBadge");

const generateBtn = document.getElementById("generateBtn");
const generateBtnText = document.getElementById("generateBtnText");
const generateBtnSpinner = document.getElementById("generateBtnSpinner");

// ===== TOAST / BUTTON HELPERS =====
let toastTimeoutId = null;

function showToast(message, type = "error") {
  toastEl.textContent = message;
  toastEl.className = `toast toast-${type}`;
  toastEl.hidden = false;

  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    toastEl.hidden = true;
  }, 6000);
}

function setLoading(isLoading) {
  if (isLoading) {
    generateBtn.disabled = true;
    generateBtnText.textContent = "Planning route…";
    generateBtnSpinner.hidden = false;
  } else {
    generateBtn.disabled = false;
    generateBtnText.textContent = "Generate safe route";
    generateBtnSpinner.hidden = true;
  }
}

// ===== MAP SETUP (Leaflet) =====
let map;
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;

function initMap() {
  const mapElement = document.getElementById("map");
  if (!mapElement) return;

  map = L.map("map", {
    center: [54.5, -2.5], // UK centre-ish
    zoom: 6,
    scrollWheelZoom: false,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  mainRouteLayer = L.polyline([], { weight: 4, className: "route-main" }).addTo(
    map
  );
  altRouteLayer = L.polyline([], {
    weight: 4,
    dashArray: "6 6",
    className: "route-alt",
  }).addTo(map);
  bridgeLayer = L.layerGroup().addTo(map);
}

function clearMap() {
  if (!map) return;
  mainRouteLayer.setLatLngs([]);
  altRouteLayer.setLatLngs([]);
  bridgeLayer.clearLayers();
}

function updateMapFromGeometry(geometry) {
  if (!map || !geometry) return;

  clearMap();

  // We support a couple of possible shapes to be safe.
  // 1) { main_route: [[lon, lat], ...], alternative_route: [[lon, lat], ...], bridges: [{lat, lon}, ...] }
  // 2) { coordinates: [[lon, lat], ...] }

  let bounds = [];

  // Main route
  if (Array.isArray(geometry.main_route)) {
    const latLngs = geometry.main_route.map(([lon, lat]) => [lat, lon]);
    mainRouteLayer.setLatLngs(latLngs);
    bounds = bounds.concat(latLngs);
  } else if (Array.isArray(geometry.coordinates)) {
    const latLngs = geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    mainRouteLayer.setLatLngs(latLngs);
    bounds = bounds.concat(latLngs);
  }

  // Alternative route
  if (Array.isArray(geometry.alternative_route)) {
    const latLngs = geometry.alternative_route.map(([lon, lat]) => [lat, lon]);
    altRouteLayer.setLatLngs(latLngs);
    bounds = bounds.concat(latLngs);
  }

  // Bridges
  if (Array.isArray(geometry.bridges)) {
    geometry.bridges.forEach((b) => {
      if (typeof b.lat === "number" && typeof b.lon === "number") {
        const marker = L.circleMarker([b.lat, b.lon], {
          radius: 5,
          className: "bridge-marker",
        });
        marker.addTo(bridgeLayer);
        bounds.push([b.lat, b.lon]);
      }
    });
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }
}

// ===== SUMMARY / RISK =====
function setRiskBadge(riskText) {
  const text = (riskText || "Low").toString();
  riskBadge.textContent = text;

  const lower = text.toLowerCase();
  riskBadge.classList.remove("risk-low", "risk-medium", "risk-high");

  if (lower.includes("high")) {
    riskBadge.classList.add("risk-high");
  } else if (lower.includes("med")) {
    riskBadge.classList.add("risk-medium");
  } else {
    riskBadge.classList.add("risk-low");
  }
}

function updateSummary(data) {
  if (!data) return;

  if (typeof data.distance_km === "number") {
    distanceValue.textContent = `${data.distance_km.toFixed(1)} km`;
  } else {
    distanceValue.textContent = "–";
  }

  if (typeof data.duration_min === "number") {
    const mins = Math.round(data.duration_min);
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    durationValue.textContent =
      hours > 0 ? `${hours}h ${rem}m` : `${mins} min`;
  } else {
    durationValue.textContent = "–";
  }

  bridgeRiskValue.textContent = data.bridge_risk || "–";

  if (
    data.nearest_bridge_height_m != null &&
    data.nearest_bridge_distance_m != null
  ) {
    nearestBridgeValue.textContent = `${data.nearest_bridge_height_m.toFixed(
      2
    )} m · ${data.nearest_bridge_distance_m.toFixed(0)} m ahead`;
  } else {
    nearestBridgeValue.textContent = "–";
  }

  setRiskBadge(data.bridge_risk);
}

// ===== FORM HANDLER =====
async function handleRouteSubmit(event) {
  event.preventDefault();

  const start = startInput.value.trim();
  const dest = destInput.value.trim();
  const heightRaw = heightInput.value.trim();
  const avoidLow = avoidCheckbox.checked;

  if (!start || !dest) {
    showToast("Please enter both start and destination postcodes.", "error");
    return;
  }

  const vehicleHeight = parseFloat(heightRaw);
  if (Number.isNaN(vehicleHeight) || vehicleHeight <= 0) {
    showToast("Please enter a valid vehicle height in metres.", "error");
    return;
  }

  setLoading(true);
  showToast("", "info"); // clear any previous; will hide shortly
  toastEl.hidden = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_postcode: start,
        dest_postcode: dest,
        vehicle_height_m: vehicleHeight,
        avoid_low_bridges: avoidLow,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }

    if (!response.ok) {
      console.error("RouteSafe API error:", response.status, data);
      const msg =
        (data && (data.detail || data.message)) ||
        `RouteSafe engine error (${response.status}).`;
      showToast(msg, "error");
      return;
    }

    updateSummary(data);
    if (data && data.geometry) {
      updateMapFromGeometry(data.geometry);
    }

    showToast("Route generated successfully.", "success");
  } catch (err) {
    console.error("RouteSafe request failed:", err);
    showToast("Error from RouteSafe engine.", "error");
  } finally {
    setLoading(false);
  }
}

// ===== BOOTSTRAP =====
window.addEventListener("load", () => {
  // Footer year
  const yearSpan = document.getElementById("year");
  if (yearSpan) yearSpan.textContent = new Date().getFullYear();

  initMap();
});

form.addEventListener("submit", handleRouteSubmit);

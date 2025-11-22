// ---------- CONFIG ----------
const API_BASE_URL = "https://routesafe-ai.onrender.com";

// ---------- DOM ELEMENTS ----------
const form = document.getElementById("routeForm");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const heightInput = document.getElementById("vehicleHeight");
const avoidLowBridgesInput = document.getElementById("avoidLowBridges");

const statusEl = document.getElementById("routeStatus");

const summaryCard = document.getElementById("routeSummaryCard");
const warningsCard = document.getElementById("warningsCard");
const stepsCard = document.getElementById("stepsCard");
const warningsList = document.getElementById("warningsList");
const stepsList = document.getElementById("stepsList");

const summaryDistance = document.getElementById("summaryDistance");
const summaryDuration = document.getElementById("summaryDuration");
const summaryRisk = document.getElementById("summaryRisk");
const summaryNearestBridge = document.getElementById("summaryNearestBridge");
const riskBadge = document.getElementById("riskBadge");

const mapEmptyState = document.getElementById("mapEmptyState");
const planRouteBtn = document.getElementById("planRouteBtn");

// ---------- MAP SETUP ----------
let map = L.map("map").setView([53.8, -1.6], 6); // roughly UK centre

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let mainRouteLayer = null;
let altRouteLayer = null;
let hazardLayerGroup = L.layerGroup().addTo(map);

function clearRouteLayers() {
  if (mainRouteLayer) {
    map.removeLayer(mainRouteLayer);
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    map.removeLayer(altRouteLayer);
    altRouteLayer = null;
  }
  hazardLayerGroup.clearLayers();
}

// ---------- UI HELPERS ----------
function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("ws-status--error", !!isError);
}

function showSummary(data) {
  if (!data) return;

  summaryDistance.textContent =
    data.main_route?.distance_text ||
    data.distance_text ||
    (data.main_route?.distance_km
      ? `${data.main_route.distance_km.toFixed(1)} km`
      : "–");

  summaryDuration.textContent =
    data.main_route?.duration_text ||
    data.duration_text ||
    (data.main_route?.duration_min
      ? `${Math.round(data.main_route.duration_min)} min`
      : "–");

  const hasConflict = data.bridge_summary?.has_conflict;
  const nearLimit = data.bridge_summary?.near_height_limit;

  if (hasConflict) {
    summaryRisk.textContent = "Low-bridge conflict";
    riskBadge.textContent = "HIGH RISK";
    riskBadge.className = "ws-badge ws-badge--risk";
  } else if (nearLimit) {
    summaryRisk.textContent = "Near vehicle height limit";
    riskBadge.textContent = "CHECK HEIGHT";
    riskBadge.className = "ws-badge ws-badge--warn";
  } else {
    summaryRisk.textContent = "No low-bridge conflicts detected";
    riskBadge.textContent = "OK";
    riskBadge.className = "ws-badge ws-badge--ok";
  }

  if (data.bridge_summary?.nearest_bridge) {
    const nb = data.bridge_summary.nearest_bridge;
    const dist = data.bridge_summary.nearest_distance_m;
    summaryNearestBridge.textContent = `${nb.height_m.toFixed(
      2
    )} m at ~${Math.round(dist)} m`;
  } else {
    summaryNearestBridge.textContent = "–";
  }

  summaryCard.hidden = false;
}

function showWarnings(data) {
  warningsList.innerHTML = "";
  const warnings = data.warnings || [];

  if (!warnings.length) {
    warningsCard.hidden = true;
    return;
  }

  warnings.forEach((w) => {
    const li = document.createElement("li");
    li.className = "ws-list-item";
    li.textContent = w;
    warningsList.appendChild(li);
  });

  warningsCard.hidden = false;
}

function showSteps(data) {
  stepsList.innerHTML = "";
  const steps = data.steps || data.main_route?.steps || [];

  if (!steps.length) {
    stepsCard.hidden = true;
    return;
  }

  steps.forEach((s) => {
    const li = document.createElement("li");
    li.className = "ws-steps-item";
    li.textContent = s.instruction || s;
    stepsList.appendChild(li);
  });

  stepsCard.hidden = false;
}

// ---------- MAP RENDERING ----------
function renderRouteOnMap(data) {
  clearRouteLayers();

  // Hide empty state once we have *any* route info
  if (mapEmptyState) {
    mapEmptyState.style.display = "none";
  }

  // Helper to convert GeoJSON LineString to Leaflet latlngs
  function coordsToLatLngs(geometry) {
    if (!geometry || geometry.type !== "LineString" || !geometry.coordinates) {
      return null;
    }
    return geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  }

  // Main route
  const mainGeom =
    data.main_route?.geometry ||
    data.main_route?.geojson ||
    data.main_route_geojson;

  const mainLatLngs = coordsToLatLngs(mainGeom);
  if (mainLatLngs) {
    mainRouteLayer = L.polyline(mainLatLngs, {
      color: "#4ea5ff",
      weight: 5
    }).addTo(map);
  }

  // Alternative route (if present)
  const altGeom =
    data.alt_route?.geometry ||
    data.alt_route?.geojson ||
    data.alt_route_geojson;

  const altLatLngs = coordsToLatLngs(altGeom);
  if (altLatLngs) {
    altRouteLayer = L.polyline(altLatLngs, {
      color: "#8f9bff",
      weight: 4,
      dashArray: "6, 8"
    }).addTo(map);
  }

  // Hazard points / low bridges (if the API sends them)
  const hazards = data.hazards || data.bridges || [];
  hazards.forEach((h) => {
    if (typeof h.lat === "number" && typeof h.lon === "number") {
      L.circleMarker([h.lat, h.lon], {
        radius: 6,
        color: "#ff5a5f",
        weight: 2
      })
        .bindPopup(
          h.label ||
            `Bridge ${h.height_m ? h.height_m.toFixed(2) + " m" : ""}`
        )
        .addTo(hazardLayerGroup);
    }
  });

  // Fit map to main route if we have it
  if (mainRouteLayer) {
    map.fitBounds(mainRouteLayer.getBounds(), { padding: [30, 30] });
  }
}

// ---------- FORM HANDLING ----------
async function handleFormSubmit(event) {
  event.preventDefault(); // stop normal form submit

  const start = startInput.value.trim();
  const end = endInput.value.trim();
  const vehicleHeight = parseFloat(heightInput.value);
  const avoidLowBridges = !!avoidLowBridgesInput.checked;

  if (!start || !end || isNaN(vehicleHeight)) {
    setStatus("Please enter start, destination and vehicle height.", true);
    return;
  }

  setStatus("Requesting safe HGV route from RouteSafe-AI…", false);
  planRouteBtn.disabled = true;
  planRouteBtn.textContent = "Working…";

  try {
    const response = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        start,
        end,
        vehicle_height_m: vehicleHeight,
        avoid_low_bridges: avoidLowBridges
      })
    });

    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error("Invalid JSON from API.");
    }

    if (!response.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        `RouteSafe-AI error ${response.status}`;
      setStatus(`Could not generate route: ${msg}`, true);
      return;
    }

    // SUCCESS
    setStatus("Safe HGV route generated.");
    if (!data) {
      setStatus("No data returned from RouteSafe-AI.", true);
      return;
    }

    renderRouteOnMap(data);
    showSummary(data);
    showWarnings(data);
    showSteps(data);
  } catch (err) {
    console.error(err);
    setStatus(
      "Error generating route. Check the API is up and try again.",
      true
    );
  } finally {
    // IMPORTANT: do NOT clear the form – keep inputs so the driver can tweak.
    planRouteBtn.disabled = false;
    planRouteBtn.textContent = "Generate safe route";
  }
}

// Attach handler
if (form) {
  form.addEventListener("submit", handleFormSubmit);
}
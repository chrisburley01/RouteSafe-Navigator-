// main.js – RouteSafe Navigator v1.0
// Talks to RouteSafe-AI backend at /api/route

// 🔗 BACKEND URL
const API_URL = "https://routesafe-ai.onrender.com/api/route";

// ---- DOM ELEMENTS ----
const form = document.getElementById("routeForm");
const startInput = document.getElementById("start");
const endInput = document.getElementById("end");
const vehicleHeightInput = document.getElementById("vehicleHeight");
const avoidLowBridgesInput = document.getElementById("avoidLowBridges");

const statusEl = document.getElementById("routeStatus");

const summaryCard = document.getElementById("routeSummaryCard");
const summaryDistanceEl = document.getElementById("summaryDistance");
const summaryDurationEl = document.getElementById("summaryDuration");
const summaryRiskEl = document.getElementById("summaryRisk");
const summaryNearestBridgeEl = document.getElementById("summaryNearestBridge");
const riskBadgeEl = document.getElementById("riskBadge");

const warningsCard = document.getElementById("warningsCard");
const warningsListEl = document.getElementById("warningsList");

const stepsCard = document.getElementById("stepsCard");
const stepsListEl = document.getElementById("stepsList");

const mapEmptyState = document.getElementById("mapEmptyState");

// ---- MAP INITIALISATION ----
let map = L.map("map").setView([53.8, -1.5], 6); // UK-ish

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

let mainRouteLayer = null;
let altRouteLayer = null;
let bridgeMarkersLayer = L.layerGroup().addTo(map);

// ---- HELPERS ----

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("ws-status--error", isError);
}

function clearRouteLayers() {
  if (mainRouteLayer) {
    map.removeLayer(mainRouteLayer);
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    map.removeLayer(altRouteLayer);
    altRouteLayer = null;
  }
  bridgeMarkersLayer.clearLayers();
}

function setRiskBadge(risk) {
  riskBadgeEl.classList.remove("ws-badge--ok", "ws-badge--warn", "ws-badge--danger");

  if (!risk || !risk.level) {
    riskBadgeEl.textContent = "No data";
    riskBadgeEl.classList.add("ws-badge--muted");
    return;
  }

  let label = "";
  if (risk.level === "low") {
    label = "Low risk";
    riskBadgeEl.classList.add("ws-badge--ok");
  } else if (risk.level === "medium") {
    label = "Medium risk";
    riskBadgeEl.classList.add("ws-badge--warn");
  } else {
    label = "High risk";
    riskBadgeEl.classList.add("ws-badge--danger");
  }
  riskBadgeEl.textContent = label;
}

// ---- FORM SUBMIT ----

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const start = startInput.value.trim();
  const end = endInput.value.trim();
  const heightStr = vehicleHeightInput.value.trim();
  const avoidLowBridges = !!avoidLowBridgesInput.checked;

  if (!start || !end || !heightStr) {
    setStatus("Please fill in start, destination and vehicle height.", true);
    return;
  }

  const vehicleHeight = parseFloat(heightStr);
  if (isNaN(vehicleHeight) || vehicleHeight <= 0) {
    setStatus("Vehicle height must be a positive number.", true);
    return;
  }

  setStatus("Requesting safe HGV route from RouteSafe-AI...");
  form.querySelector("button[type='submit']").disabled = true;
  mapEmptyState.style.display = "none";

  clearRouteLayers();
  summaryCard.hidden = true;
  warningsCard.hidden = true;
  stepsCard.hidden = true;

  try {
    const payload = {
      start: start,
      end: end,
      vehicle_height_m: vehicleHeight,
      avoid_low_bridges: avoidLowBridges,
    };

    // 🔍 DEBUG: show payload in UI if needed
    console.log("Sending to API:", payload);

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // If backend returned an error, grab its message
    if (!response.ok) {
      let detail = "";
      try {
        const errJson = await response.json();
        if (errJson && errJson.detail) {
          detail =
            typeof errJson.detail === "string"
              ? errJson.detail
              : JSON.stringify(errJson.detail);
        } else {
          detail = JSON.stringify(errJson);
        }
      } catch (e) {
        detail = "(no JSON error body)";
      }
      throw new Error(`RouteSafe-AI error ${response.status}: ${detail}`);
    }

    const data = await response.json();
    console.log("API response:", data);

    // ---- UPDATE SUMMARY ----
    summaryDistanceEl.textContent = `${data.summary.distance_km.toFixed(1)} km`;
    summaryDurationEl.textContent = `${data.summary.duration_min.toFixed(0)} min`;
    summaryRiskEl.textContent = data.bridge_risk.status_text || "-";

    if (data.bridge_risk.nearest_bridge_height_m) {
      const h = data.bridge_risk.nearest_bridge_height_m.toFixed(2);
      const d = data.bridge_risk.nearest_bridge_distance_m
        ? data.bridge_risk.nearest_bridge_distance_m.toFixed(0)
        : "–";
      summaryNearestBridgeEl.textContent = `${h} m (${d} m away)`;
    } else {
      summaryNearestBridgeEl.textContent = "No bridge nearby in dataset";
    }

    setRiskBadge(data.bridge_risk);
    summaryCard.hidden = false;

    // ---- WARNINGS ----
    warningsListEl.innerHTML = "";
    if (data.warnings && data.warnings.length > 0) {
      data.warnings.forEach((w) => {
        const li = document.createElement("li");
        li.textContent = w;
        warningsListEl.appendChild(li);
      });
      warningsCard.hidden = false;
    }

    // ---- STEPS ----
    stepsListEl.innerHTML = "";
    if (data.steps && data.steps.length > 0) {
      data.steps.forEach((s) => {
        const li = document.createElement("li");
        li.textContent = s;
        stepsListEl.appendChild(li);
      });
      stepsCard.hidden = false;
    }

    // ---- MAP ROUTES ----
    if (data.main_geojson && data.main_geojson.type === "LineString") {
      mainRouteLayer = L.geoJSON(
        {
          type: "Feature",
          geometry: data.main_geojson,
        },
        {
          style: {
            color: "#4c8dff",
            weight: 5,
          },
        }
      ).addTo(map);
      map.fitBounds(mainRouteLayer.getBounds(), { padding: [20, 20] });
    }

    if (data.alt_geojson && data.alt_geojson.type === "LineString") {
      altRouteLayer = L.geoJSON(
        {
          type: "Feature",
          geometry: data.alt_geojson,
        },
        {
          style: {
            color: "#8a8aff",
            weight: 4,
            dashArray: "8 6",
          },
        }
      ).addTo(map);
    }

    // ---- BRIDGE MARKERS ----
    bridgeMarkersLayer.clearLayers();
    if (data.bridges && data.bridges.length > 0) {
      data.bridges.forEach((b) => {
        const marker = L.circleMarker([b.lat, b.lon], {
          radius: 6,
          weight: 2,
          color: "#ff5b3a",
          fillColor: "#ff5b3a",
          fillOpacity: 0.9,
        });
        marker.bindPopup(
          `<strong>Bridge ${b.height_m.toFixed(2)} m</strong><br>${b.message}`
        );
        bridgeMarkersLayer.addLayer(marker);
      });
    }

    setStatus("Route generated successfully.");
  } catch (err) {
    console.error(err);
    setStatus(
      `Could not generate route: ${err.message}. Check Render logs if this keeps happening.`,
      true
    );
    mapEmptyState.style.display = "block";
  } finally {
    form.querySelector("button[type='submit']").disabled = false;
  }
});
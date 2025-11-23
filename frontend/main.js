// RouteSafe Navigator v1.1 frontend logic

// ✅ Backend endpoint (UI + API on same Render service)
const API_URL = "/api/route";

// Form + inputs
const form = document.getElementById("route-form");
const startInput = document.getElementById("start");
const destInput = document.getElementById("destination");
const heightInput = document.getElementById("height");
const avoidInput = document.getElementById("avoid");
const submitBtn = document.getElementById("submit-btn");

// Messages
const messageBox = document.getElementById("message");
const messageText = document.getElementById("message-text");

// Summary fields
const summaryDistance = document.getElementById("summary-distance");
const summaryTime = document.getElementById("summary-time");
const summaryBridgeRisk = document.getElementById("summary-bridge-risk");
const summaryNearest = document.getElementById("summary-nearest");
const riskChip = document.getElementById("risk-chip");
const riskLabel = document.getElementById("risk-label");

// Leaflet map
const map = L.map("map").setView([53.8, -1.6], 6); // UK view
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let routeLayer = null;

// --- UI helpers ---

function setMessage(text, type = "info") {
  if (!text) {
    messageBox.classList.remove("visible", "error", "info");
    messageText.textContent = "";
    return;
  }
  messageBox.classList.add("visible");
  messageBox.classList.remove("error", "info");
  messageBox.classList.add(type);
  messageText.textContent = text;
}

function setRiskLevel(level) {
  riskChip.classList.remove("primary", "low", "medium", "high");
  riskChip.classList.add(level);

  const dot = riskChip.querySelector(".badge-risk-dot");
  riskLabel.textContent =
    level === "high" ? "High risk" : level === "medium" ? "Medium risk" : "Low risk";

  if (level === "low") {
    riskChip.classList.add("primary");
  }
}

function formatKm(km) {
  if (km === undefined || km === null) return "–";
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  return `${km.toFixed(1)} km`;
}

function formatMinutes(mins) {
  if (mins === undefined || mins === null) return "–";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function formatBridgeRisk(result) {
  if (!result || !Array.isArray(result.conflicts)) {
    return "No data";
  }
  const count = result.conflicts.length;
  if (count === 0) return "No low-bridge conflicts detected";
  if (count === 1) return "1 low-bridge conflict";
  return `${count} low-bridge conflicts`;
}

function formatNearestBridge(nb) {
  if (!nb) return "None on route";
  const h = nb.height_m != null ? `${nb.height_m.toFixed(2)} m` : "unknown height";
  const d =
    nb.distance_m != null
      ? nb.distance_m > 1000
        ? `${(nb.distance_m / 1000).toFixed(1)} km`
        : `${Math.round(nb.distance_m)} m`
      : "unknown distance";
  return `${h} · ${d} ahead`;
}

function drawRoute(geojson) {
  if (!geojson) return;
  if (routeLayer) {
    map.removeLayer(routeLayer);
  }
  routeLayer = L.geoJSON(geojson, {
    style: {
      weight: 5,
      opacity: 0.9
    }
  }).addTo(map);
  try {
    map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
  } catch {
    // ignore
  }
}

// --- Form submit handler ---

async function handleSubmit(event) {
  event.preventDefault();
  setMessage("");

  const start = startInput.value.trim();
  const dest = destInput.value.trim();
  const heightVal = parseFloat(heightInput.value);

  if (!start || !dest || !heightVal || Number.isNaN(heightVal)) {
    setMessage("Please enter start, destination and a valid vehicle height.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Planning route…";

  try {
    const payload = {
      start,
      destination: dest,
      vehicle_height_m: heightVal,
      avoid_low_bridges: !!avoidInput.checked
    };

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Server responded ${resp.status}: ${txt || resp.statusText}`);
    }

    const data = await resp.json();

    // Expecting: { distance_km, duration_min, risk_level, bridge_result, nearest_bridge, route_geojson }
    summaryDistance.textContent = formatKm(data.distance_km);
    summaryTime.textContent = formatMinutes(data.duration_min);
    summaryBridgeRisk.textContent = formatBridgeRisk(data.bridge_result);
    summaryNearest.textContent = formatNearestBridge(data.nearest_bridge);

    setRiskLevel(data.risk_level || "low");

    if (data.route_geojson) {
      drawRoute(data.route_geojson);
    }

    setMessage("Route generated successfully.", "info");
  } catch (err) {
    console.error(err);
    setMessage(
      "Network error: " +
        (err.message && err.message.includes("Failed to fetch")
          ? "Unable to reach RouteSafe engine. Check API URL and server status."
          : err.message),
      "error"
    );
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate Safe Route";
  }
}

// --- Wire up form & defaults ---

form.addEventListener("submit", handleSubmit);

// Pre-fill useful demo values
startInput.value = "LS27 0BN";
destInput.value = "HD5 0RL";
heightInput.value = "5";
avoidInput.checked = true;
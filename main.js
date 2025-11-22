let map;
let routeLine;

window.onload = () => {
  map = L.map("map").setView([53.8, -1.6], 9);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
  }).addTo(map);

  document
    .getElementById("routeForm")
    .addEventListener("submit", handleRouteRequest);
};

async function handleRouteRequest(event) {
  event.preventDefault();

  const start = document.getElementById("start").value.trim();
  const end = document.getElementById("end").value.trim();
  const height = parseFloat(document.getElementById("vehicleHeight").value);
  const avoid = document.getElementById("avoidLowBridges").checked;

  const status = document.getElementById("routeStatus");
  status.textContent = "Requesting route…";

  const payload = {
    start: start,
    end: end,
    vehicle_height_m: height,
    avoid_low_bridges: avoid,
  };

  try {
    const res = await fetch("https://routesafe-ai.onrender.com/api/route", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      status.textContent = "Error: " + data.detail;
      return;
    }

    status.textContent = "Route loaded.";

    drawRouteOnMap(data);
    populateSummary(data);
    populateWarnings(data);

  } catch (err) {
    status.textContent = "Network error: " + err;
  }
}

// ----- DRAW ROUTE -----

function drawRouteOnMap(data) {
  const coords = data.route.routes[0].geometry.coordinates;

  const latlngs = coords.map(c => [c[1], c[0]]);

  if (routeLine) routeLine.remove();

  routeLine = L.polyline(latlngs, { color: "#002c77", weight: 4 }).addTo(map);

  map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

// ----- SUMMARY PANEL -----

function populateSummary(data) {
  document.getElementById("summaryCard").hidden = false;

  document.getElementById("sumDistance").textContent =
    (data.route_metrics.distance_km || 0).toFixed(2) + " km";

  document.getElementById("sumTime").textContent =
    (data.route_metrics.duration_min || 0).toFixed(0) + " min";

  const risk = data.bridge_summary.has_conflict
    ? "HIGH"
    : data.bridge_summary.near_height_limit
    ? "MEDIUM"
    : "LOW";

  document.getElementById("sumRisk").textContent = risk;

  const nb = data.bridge_summary.nearest_bridge;
  if (nb) {
    document.getElementById("sumNearest").textContent =
      `${nb.height_m}m (${data.bridge_summary.nearest_distance_m.toFixed(0)}m away)`;
  } else {
    document.getElementById("sumNearest").textContent = "No bridges near route";
  }
}

// ----- WARNINGS PANEL -----

function populateWarnings(data) {
  const warningsCard = document.getElementById("warningsCard");
  const list = document.getElementById("warningsList");

  list.innerHTML = "";

  if (!data.bridge_summary.has_conflict && !data.bridge_summary.near_height_limit) {
    warningsCard.hidden = true;
    return;
  }

  warningsCard.hidden = false;

  if (data.bridge_summary.has_conflict) {
    const li = document.createElement("li");
    li.textContent = "⚠️ Low bridge on route – NOT SAFE at current height";
    list.appendChild(li);
  }

  if (data.bridge_summary.near_height_limit) {
    const li = document.createElement("li");
    li.textContent = "⚠️ Bridge height close to vehicle limit – use caution";
    list.appendChild(li);
  }
}
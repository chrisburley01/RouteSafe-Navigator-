// main.js

let map = null;
let mainRouteLayer = null;
let altRouteLayer = null;
let bridgeLayer = null;

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("routeForm");
  const statusEl = document.getElementById("routeStatus");
  const planBtn = document.getElementById("planRouteBtn");

  const routeSummaryCard = document.getElementById("routeSummaryCard");
  const warningsCard = document.getElementById("warningsCard");
  const stepsCard = document.getElementById("stepsCard");

  const summaryDistance = document.getElementById("summaryDistance");
  const summaryDuration = document.getElementById("summaryDuration");
  const summaryRisk = document.getElementById("summaryRisk");
  const summaryNearestBridge = document.getElementById("summaryNearestBridge");
  const riskBadge = document.getElementById("riskBadge");

  const warningsList = document.getElementById("warningsList");
  const stepsList = document.getElementById("stepsList");

  const mapEmptyState = document.getElementById("mapEmptyState");

  // Init Leaflet map
  initMap();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const start = document.getElementById("start").value.trim();
    const end = document.getElementById("end").value.trim();
    const vehicleHeightStr = document
      .getElementById("vehicleHeight")
      .value.trim();
    const avoidLowBridges =
      document.getElementById("avoidLowBridges").checked ?? true;

    if (!start || !end || !vehicleHeightStr) {
      setStatus("Please fill in all fields.", "warn");
      return;
    }

    const vehicleHeightM = parseFloat(vehicleHeightStr);
    if (isNaN(vehicleHeightM) || vehicleHeightM <= 0) {
      setStatus("Vehicle height must be a positive number in metres.", "warn");
      return;
    }

    setStatus("Calculating HGV-safe route…", "info");
    setLoading(true);

    try {
      const payload = {
        start,
        end,
        vehicle_height_m: vehicleHeightM,
        avoid_low_bridges: avoidLowBridges,
      };

      const response = await fetch("/api/route", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`API responded with ${response.status}`);
      }

      const data = await response.json();
      handleRouteResponse(data);
      setStatus("Route generated successfully.", "ok");
    } catch (err) {
      console.error("Route error:", err);
      // Fallback demo mode so UI still shows something
      const demo = buildDemoRoute(start, end, vehicleHeightM);
      handleRouteResponse(demo);
      setStatus(
        "RouteSafe engine not reachable; showing demo route layout only.",
        "warn"
      );
    } finally {
      setLoading(false);
    }
  });

  function setStatus(message, level) {
    statusEl.textContent = message || "";
    statusEl.style.color =
      level === "ok"
        ? "#bbf7d0"
        : level === "warn"
        ? "#fed7aa"
        : "#9ca3af";
  }

  function setLoading(isLoading) {
    planBtn.disabled = isLoading;
    planBtn.textContent = isLoading ? "Calculating…" : "Generate safe route";
  }

  function handleRouteResponse(data) {
    if (!data) return;

    const distanceKm = data.distance_km ?? data.summary?.distance_km ?? null;
    const durationMin =
      data.duration_min ?? data.summary?.duration_min ?? null;
    const risk = data.bridge_risk || data.bridge_status || {};
    const steps = data.steps || data.route_steps || [];
    const warnings = data.warnings || data.bridge_warnings || [];

    // Summary
    summaryDistance.textContent = distanceKm
      ? `${distanceKm.toFixed(1)} km`
      : "–";
    summaryDuration.textContent = durationMin
      ? `${Math.round(durationMin)} min`
      : "–";

    const riskText = risk.status_text || "No bridge data";
    summaryRisk.textContent = riskText;

    if (risk.nearest_bridge_height_m != null) {
      const height = risk.nearest_bridge_height_m.toFixed(2);
      const dist =
        risk.nearest_bridge_distance_m != null
          ? `${risk.nearest_bridge_distance_m.toFixed(0)} m away`
          : "";
      summaryNearestBridge.textContent = `${height} m ${dist}`.trim();
    } else {
      summaryNearestBridge.textContent = "–";
    }

    // Risk badge
    const level = (risk.level || risk.risk_level || "unknown").toLowerCase();
    riskBadge.textContent =
      level === "high"
        ? "High bridge risk"
        : level === "medium"
        ? "Medium bridge risk"
        : level === "low"
        ? "Low bridge risk"
        : "No data";

    riskBadge.className = "ws-badge " + getBadgeClass(level);

    // Warnings
    warningsList.innerHTML = "";
    if (warnings.length > 0) {
      warningsCard.hidden = false;
      warnings.forEach((w) => {
        const item = document.createElement("li");
        const lvl = (w.level || "").toLowerCase();

        item.className =
          "ws-list-item " +
          (lvl === "high"
            ? "ws-list-item--danger"
            : lvl === "medium"
            ? "ws-list-item--warning"
            : "");

        item.textContent = w.message || w.text || JSON.stringify(w);
        warningsList.appendChild(item);
      });
    } else {
      warningsCard.hidden = true;
    }

    // Steps
    stepsList.innerHTML = "";
    if (steps.length > 0) {
      stepsCard.hidden = false;
      steps.forEach((s, idx) => {
        const li = document.createElement("li");
        const text =
          s.instruction ||
          s.text ||
          `Step ${idx + 1}: ${JSON.stringify(s)} `;
        li.textContent = text;
        stepsList.appendChild(li);
      });
    } else {
      stepsCard.hidden = true;
    }

    // Show cards
    routeSummaryCard.hidden = false;

    // Map geometry extraction
    const mainGeom = extractMainGeometry(data);
    const altGeom = extractAltGeometry(data);
    const bridgeMarkers = extractBridgeMarkers(data);

    drawRouteOnMap(mainGeom, altGeom, bridgeMarkers);

    if (mapEmptyState) {
      mapEmptyState.style.opacity = mainGeom ? 0 : 1;
    }
  }

  function getBadgeClass(level) {
    if (level === "high") return "ws-badge--danger";
    if (level === "medium") return "ws-badge--warn";
    if (level === "low") return "ws-badge--ok";
    return "ws-badge--muted";
  }
});

/* ---------- MAP FUNCTIONS ---------- */

function initMap() {
  if (!window.L) {
    console.warn("Leaflet not loaded; map disabled.");
    return;
  }

  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  // Rough UK center, zoomed out
  map = L.map("map").setView([53.8, -1.6], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);
}

function drawRouteOnMap(mainGeom, altGeom, bridgeMarkers) {
  if (!map || !window.L) return;

  // Clear existing layers
  if (mainRouteLayer) {
    map.removeLayer(mainRouteLayer);
    mainRouteLayer = null;
  }
  if (altRouteLayer) {
    map.removeLayer(altRouteLayer);
    altRouteLayer = null;
  }
  if (bridgeLayer) {
    map.removeLayer(bridgeLayer);
    bridgeLayer = null;
  }

  const layersToFit = [];

  if (mainGeom && mainGeom.type === "LineString") {
    const latLngs = geojsonCoordsToLatLngs(mainGeom.coordinates);
    if (latLngs.length > 0) {
      mainRouteLayer = L.polyline(latLngs, {
        weight: 5,
        opacity: 0.9,
      }).addTo(map);
      layersToFit.push(mainRouteLayer);
    }
  }

  if (altGeom && altGeom.type === "LineString") {
    const latLngsAlt = geojsonCoordsToLatLngs(altGeom.coordinates);
    if (latLngsAlt.length > 0) {
      altRouteLayer = L.polyline(latLngsAlt, {
        weight: 4,
        dashArray: "6,8",
        opacity: 0.8,
      }).addTo(map);
      layersToFit.push(altRouteLayer);
    }
  }

  if (bridgeMarkers && bridgeMarkers.length > 0) {
    bridgeLayer = L.layerGroup();
    bridgeMarkers.forEach((b) => {
      const lat = b.lat ?? b.latitude;
      const lon = b.lon ?? b.lng ?? b.longitude;
      if (lat == null || lon == null) return;

      const risk = (b.risk_level || b.level || "low").toLowerCase();
      const color =
        risk === "high" ? "#f97316" : risk === "medium" ? "#eab308" : "#22c55e";

      const marker = L.circleMarker([lat, lon], {
        radius: 6,
        weight: 2,
        color,
        fillColor: color,
        fillOpacity: 0.8,
      });

      const msg =
        b.message ||
        b.text ||
        `Bridge ${b.height_m ? b.height_m.toFixed(2) + " m" : ""}`;

      marker.bindPopup(msg);
      marker.addTo(bridgeLayer);
    });
    bridgeLayer.addTo(map);
    layersToFit.push(bridgeLayer);
  }

  if (layersToFit.length > 0) {
    const group = L.featureGroup(layersToFit);
    map.fitBounds(group.getBounds().pad(0.2));
  }
}

function geojsonCoordsToLatLngs(coords) {
  if (!Array.isArray(coords)) return [];
  // GeoJSON is [lon, lat]
  return coords
    .map((c) =>
      Array.isArray(c) && c.length >= 2 ? [c[1], c[0]] : null
    )
    .filter(Boolean);
}

/* ---------- BACKEND EXTRACTION HELPERS ---------- */

function extractMainGeometry(data) {
  // Try a few common field names
  if (data.geometry && data.geometry.type === "LineString") {
    return data.geometry;
  }
  if (data.route_geometry && data.route_geometry.type === "LineString") {
    return data.route_geometry;
  }
  if (data.main_geometry && data.main_geometry.type === "LineString") {
    return data.main_geometry;
  }
  return null;
}

function extractAltGeometry(data) {
  if (data.alt_geometry && data.alt_geometry.type === "LineString") {
    return data.alt_geometry;
  }
  if (data.alternative_geometry && data.alternative_geometry.type === "LineString") {
    return data.alternative_geometry;
  }
  return null;
}

function extractBridgeMarkers(data) {
  if (Array.isArray(data.bridge_markers)) return data.bridge_markers;
  if (Array.isArray(data.bridges)) return data.bridges;
  if (Array.isArray(data.bridge_warnings)) return data.bridge_warnings;
  return [];
}

/* ---------- DEMO ROUTE WHEN BACKEND OFFLINE ---------- */

function buildDemoRoute(start, end, vehicleHeightM) {
  const highRisk = vehicleHeightM > 4.8;

  // Fake line somewhere near Leeds -> Manchester-ish
  const demoLine = {
    type: "LineString",
    coordinates: [
      [-1.602, 53.758],
      [-1.55, 53.75],
      [-1.48, 53.74],
      [-1.35, 53.73],
      [-2.25, 53.48],
    ],
  };

  const demoAltLine = highRisk
    ? {
        type: "LineString",
        coordinates: [
          [-1.602, 53.758],
          [-1.62, 53.72],
          [-1.7, 53.68],
          [-1.9, 53.58],
          [-2.25, 53.48],
        ],
      }
    : null;

  const bridgeMarkers = highRisk
    ? [
        {
          lat: 53.74,
          lon: -1.5,
          height_m: 4.6,
          risk_level: "high",
          message: "Low bridge 4.6 m – main route diverted.",
        },
      ]
    : [];

  return {
    summary: {
      distance_km: 27.3,
      duration_min: 42,
    },
    distance_km: 27.3,
    duration_min: 42,
    bridge_risk: {
      level: highRisk ? "high" : "low",
      status_text: highRisk
        ? "Low bridge on direct path; alternative offered."
        : "No conflicts detected for this height.",
      nearest_bridge_height_m: highRisk ? 4.6 : 5.2,
      nearest_bridge_distance_m: 130,
    },
    warnings: highRisk
      ? [
          {
            level: "high",
            message:
              "Low bridge (4.6 m) detected near Morley; main route diverted.",
          },
        ]
      : [],
    steps: [
      { instruction: `Start at ${start}` },
      { instruction: "Head towards M62 via A650." },
      {
        instruction: highRisk
          ? "Follow HGV diversion avoiding low bridge near Morley."
          : "Follow primary route through Morley.",
      },
      { instruction: `Arrive at ${end}.` },
    ],
    geometry: demoLine,
    alt_geometry: demoAltLine,
    bridge_markers: bridgeMarkers,
  };
}
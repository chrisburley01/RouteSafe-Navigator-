// main.js
// Frontend for RouteSafe Navigator
// Uses the Python API deployed at routesafe-navigatorv2.onrender.com

const API_BASE_URL = "https://routesafe-navigatorv2.onrender.com";

let map;
let mainRouteLayer = null;
let altRouteLayer = null;
let bridgeLayer = null;

/* ---------- UI helpers ---------- */

function showError(message) {
  const banner = document.getElementById("error-banner");
  const text = document.getElementById("error-text");
  if (!banner || !text) return;

  text.textContent = message;
  banner.classList.add("visible");
}

function clearError() {
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  banner.classList.remove("visible");
}

function setStatus(message) {
  const el = document.getElementById("status-line");
  if (el) el.textContent = message;
}

/* ---------- Map setup ---------- */

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.error("Map container #map not found");
    return;
  }

  map = L.map("map", {
    zoomControl: true
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Centre of GB
  map.setView([54.2, -2.5], 6);
}

/* ---------- Summary helpers ---------- */

function formatKm(value) {
  if (value == null || isNaN(value)) return "–";
  const km = value > 1000 ? value / 1000 : value;
  return km.toFixed(1) + " km";
}

function formatMinutes(value) {
  if (value == null || isNaN(value)) return "–";
  const mins = Math.round(value);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatBridgeDistance(value) {
  if (value == null || isNaN(value)) return "–";
  if (value > 1000) return (value / 1000).toFixed(1) + " km";
  return Math.round(value) + " m";
}

function getRiskClass(risk) {
  const r = (risk || "").toLowerCase();
  if (r === "high") return "risk-high";
  if (r === "medium" || r === "med") return "risk-medium";
  return "risk-low";
}

function updateSummary(data) {
  try {
    const distanceEl = document.getElementById("distance-value");
    const timeEl = document.getElementById("time-value");
    const riskEl = document.getElementById("bridge-risk-value");
    const nearestBridgeEl = document.getElementById("nearest-bridge-value");
    const riskBadge = document.getElementById("risk-badge");

    if (distanceEl) {
      const dist = data.distance_km ?? data.distance_m;
      distanceEl.textContent = formatKm(dist);
    }

    if (timeEl) {
      const dur = data.duration_min ?? data.duration_minutes;
      timeEl.textContent = formatMinutes(dur);
    }

    const riskText = data.bridge_risk || data.risk_level || "Low";
    if (riskEl) riskEl.textContent = riskText;

    let nearestText = "None on route";
    if (data.nearest_bridge_distance_m != null) {
      nearestText =
        formatBridgeDistance(data.nearest_bridge_distance_m) +
        (data.nearest_bridge_height_m != null
          ? ` away · ${data.nearest_bridge_height_m.toFixed(2)} m`
          : "");
    }
    if (nearestBridgeEl) nearestBridgeEl.textContent = nearestText;

    if (riskBadge) {
      riskBadge.textContent = riskText;
      riskBadge.classList.remove("risk-low", "risk-medium", "risk-high");
      riskBadge.classList.add(getRiskClass(riskText));
    }
  } catch (err) {
    console.error("Error updating summary", err);
  }
}

/* ---------- Geometry helpers ---------- */

function lineFromGeoJson(geo) {
  if (!geo || geo.type !== "LineString" || !Array.isArray(geo.coordinates)) {
    return null;
  }
  return geo.coordinates.map(([lon, lat]) => [lat, lon]);
}

function extractMainGeometry(geometry) {
  if (!geometry) return null;

  // Direct LineString
  if (geometry.type === "LineString") return geometry;

  // ORS-style FeatureCollection
  if (geometry.type === "FeatureCollection" && Array.isArray(geometry.features)) {
    const feature = geometry.features[0];
    if (feature && feature.geometry && feature.geometry.type === "LineString") {
      return feature.geometry;
    }
  }

  console.warn("Unrecognised geometry format", geometry);
  return null;
}

function drawRouteOnMap(geometry) {
  if (!map || !geometry) {
    console.warn("No map or geometry to draw");
    return;
  }

  // Clear existing
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

  try {
    const mainGeo = extractMainGeometry(geometry);
    const mainLine = mainGeo ? lineFromGeoJson(mainGeo) : null;

    if (mainLine && mainLine.length) {
      mainRouteLayer = L.polyline(mainLine, { weight: 4 });
      mainRouteLayer.addTo(map);
      layersToFit.push(mainRouteLayer);
    }

    // Optional: bridges array
    const bridgePoints = [];
    if (Array.isArray(geometry.bridges)) {
      geometry.bridges.forEach((b) => {
        if (Array.isArray(b) && b.length >= 2) {
          const [lon, lat] = b;
          bridgePoints.push([lat, lon]);
        } else if (b && typeof b.lat === "number" && typeof b.lon === "number") {
          bridgePoints.push([b.lat, b.lon]);
        }
      });
    }

    if (bridgePoints.length) {
      bridgeLayer = L.layerGroup(
        bridgePoints.map((latLng) =>
          L.circleMarker(latLng, {
            radius: 5
          })
        )
      );
      bridgeLayer.addTo(map);
      layersToFit.push(bridgeLayer);
    }

    if (layersToFit.length) {
      const group = L.featureGroup(layersToFit);
      map.fitBounds(group.getBounds().pad(0.2));
    }
  } catch (err) {
    console.error("Error drawing geometry", err);
  }
}

/* ---------- Generate button ---------- */

async function handleGenerateClick() {
  clearError();

  const startEl = document.getElementById("start-postcode");
  const destEl = document.getElementById("dest-postcode");
  const heightEl = document.getElementById("vehicle-height");
  const avoidEl = document.getElementById("avoid-low-bridges");

  const start = startEl ? startEl.value.trim() : "";
  const dest = destEl ? destEl.value.trim() : "";
  const heightStr = heightEl ? heightEl.value.trim() : "";
  const avoidLow = avoidEl ? avoidEl.checked : true;

  if (!start || !dest || !heightStr) {
    showError("Please enter start, destination and vehicle height.");
    return;
  }

  const vehicleHeight = Number(heightStr);
  if (isNaN(vehicleHeight) || vehicleHeight <= 0) {
    showError("Vehicle height must be a positive number.");
    return;
  }

  const btn = document.getElementById("generate-route-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating…";
  }
  setStatus("Contacting RouteSafe engine…");

  try {
    const payload = {
      start_postcode: start,
      dest_postcode: dest,
      vehicle_height_m: vehicleHeight,
      avoid_low_bridges: avoidLow
    };

    const response = await fetch(`${API_BASE_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let detail = `RouteSafe API error (${response.status})`;
      try {
        const body = await response.json();
        if (body && body.detail) {
          detail =
            typeof body.detail === "string"
              ? body.detail
              : JSON.stringify(body.detail);
        }
      } catch (e) {
        // ignore
      }
      console.error("API error", detail);
      showError(detail);
      setStatus("Error from RouteSafe engine.");
      return;
    }

    const data = await response.json();
    console.log("RouteSafe response", data);

    updateSummary(data);

    if (data.geometry) {
      drawRouteOnMap(data.geometry);
    } else {
      console.warn("No geometry in response");
    }

    setStatus("Route generated.");
  } catch (err) {
    console.error("Error calling RouteSafe API", err);
    showError("Unable to reach RouteSafe engine. Please try again.");
    setStatus("Error contacting RouteSafe engine.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Generate safe route";
    }
  }
}

/* ---------- Boot ---------- */

document.addEventListener("DOMContentLoaded", () => {
  try {
    initMap();
  } catch (err) {
    console.error("Failed to init map", err);
  }

  const btn = document.getElementById("generate-route-btn");
  if (btn) {
    btn.addEventListener("click", handleGenerateClick);
  }
});

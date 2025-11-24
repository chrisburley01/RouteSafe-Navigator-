// Base URL of the Python API service on Render
const API_BASE = "https://routesafe-navigatorv2.onrender.com";

document.addEventListener("DOMContentLoaded", () => {
  // ---- DOM elements ----
  const startInput = document.getElementById("startPostcodeInput");
  const destInput = document.getElementById("destPostcodeInput");
  const heightInput = document.getElementById("vehicleHeightInput");
  const avoidToggle = document.getElementById("avoidLowBridgesToggle");
  const generateBtn = document.getElementById("generateBtn");
  const statusText = document.getElementById("statusText");

  const distanceValue = document.getElementById("distanceValue");
  const durationValue = document.getElementById("durationValue");
  const bridgeRiskValue = document.getElementById("bridgeRiskValue");
  const nearestBridgeValue = document.getElementById("nearestBridgeValue");
  const riskBadge = document.getElementById("riskLevelBadge");

  // ---- Map setup ----
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  }).setView([53.8, -1.6], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  let mainRouteLayer = null;
  let altRouteLayer = null;
  let bridgeMarkers = [];

  function clearMapOverlays() {
    if (mainRouteLayer) {
      map.removeLayer(mainRouteLayer);
      mainRouteLayer = null;
    }
    if (altRouteLayer) {
      map.removeLayer(altRouteLayer);
      altRouteLayer = null;
    }
    bridgeMarkers.forEach((m) => map.removeLayer(m));
    bridgeMarkers = [];
  }

  function setStatus(message, type = "info") {
    statusText.textContent = message || "";
    statusText.classList.remove("status-error", "status-success");
    if (type === "error") statusText.classList.add("status-error");
    if (type === "success") statusText.classList.add("status-success");
  }

  function setRiskBadge(risk) {
    const value = (risk || "").toLowerCase();
    riskBadge.classList.remove("risk-low", "risk-medium", "risk-high");

    if (value === "high") {
      riskBadge.textContent = "High";
      riskBadge.classList.add("risk-high");
    } else if (value === "medium" || value === "moderate") {
      riskBadge.textContent = "Medium";
      riskBadge.classList.add("risk-medium");
    } else {
      riskBadge.textContent = "Low";
      riskBadge.classList.add("risk-low");
    }
  }

  function updateSummary(data) {
    if (!data) return;

    distanceValue.textContent =
      data.distance_km != null ? `${data.distance_km.toFixed(1)} km` : "–";

    durationValue.textContent =
      data.duration_min != null ? `${data.duration_min.toFixed(0)} min` : "–";

    bridgeRiskValue.textContent = data.bridge_risk || "–";

    if (data.nearest_bridge_height_m != null && data.nearest_bridge_distance_m != null) {
      nearestBridgeValue.textContent = `${data.nearest_bridge_height_m.toFixed(
        1
      )} m · ${data.nearest_bridge_distance_m.toFixed(0)} m away`;
    } else {
      nearestBridgeValue.textContent = "–";
    }

    setRiskBadge(data.bridge_risk);
  }

  function updateMapFromGeometry(geometry, bridges = []) {
    clearMapOverlays();

    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
      return;
    }

    const coords = geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    mainRouteLayer = L.polyline(coords, {
      color: "#2563eb",
      weight: 4,
    }).addTo(map);

    const bounds = mainRouteLayer.getBounds();
    map.fitBounds(bounds, { padding: [40, 40] });

    // Optional: bridge markers if backend sends them
    if (Array.isArray(bridges)) {
      bridges.forEach((b) => {
        if (b.lat != null && b.lon != null) {
          const marker = L.circleMarker([b.lat, b.lon], {
            radius: 5,
            color: "#fb923c",
            fillColor: "#fed7aa",
            fillOpacity: 0.9,
          }).addTo(map);
          marker.bindPopup(
            `Low bridge<br/>Height: ${b.height_m?.toFixed?.(1) ?? b.height_m} m`
          );
          bridgeMarkers.push(marker);
        }
      });
    }
  }

  async function generateRoute() {
    const start = (startInput.value || "").trim();
    const dest = (destInput.value || "").trim();
    const heightStr = (heightInput.value || "").trim();
    const avoidLow = !!avoidToggle.checked;

    if (!start || !dest || !heightStr) {
      setStatus("Please enter start, destination and vehicle height.", "error");
      return;
    }

    const vehicleHeightM = parseFloat(heightStr);
    if (Number.isNaN(vehicleHeightM) || vehicleHeightM <= 0) {
      setStatus("Vehicle height must be a valid number in metres.", "error");
      return;
    }

    setStatus("Contacting RouteSafe engine…");
    generateBtn.disabled = true;
    const originalText = generateBtn.textContent;
    generateBtn.textContent = "Planning route…";

    try {
      const payload = {
        start_postcode: start,
        dest_postcode: dest,
        vehicle_height_m: vehicleHeightM,
        avoid_low_bridges: avoidLow,
      };

      const response = await fetch(`${API_BASE}/api/route`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("RouteSafe API error:", response.status, text);
        setStatus(
          `Error from RouteSafe engine (status ${response.status}).`,
          "error"
        );
        return;
      }

      const data = await response.json();
      console.log("RouteSafe response:", data);

      updateSummary(data);
      updateMapFromGeometry(data.geometry, data.bridge_points || []);
      setStatus("Route generated successfully.", "success");
    } catch (err) {
      console.error("Network/API error:", err);
      setStatus("Error contacting RouteSafe engine. Please try again.", "error");
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = originalText;
    }
  }

  generateBtn.addEventListener("click", (e) => {
    e.preventDefault();
    generateRoute();
  });
});

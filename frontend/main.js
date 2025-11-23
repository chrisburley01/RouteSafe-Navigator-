// frontend/main.js

document.addEventListener("DOMContentLoaded", () => {
  // 👉 Your live backend URL
  const API_BASE_URL = "https://routesafe-navigatorv2.onrender.com";

  // Inputs
  const startInput = document.getElementById("startPostcode");
  const destInput = document.getElementById("destPostcode");
  const heightInput = document.getElementById("vehicleHeight");
  const avoidCheckbox = document.getElementById("avoidLowBridges");

  // Button / form (whichever exists)
  const generateBtn = document.getElementById("generateRouteBtn");
  const form = document.getElementById("routeForm");

  // Output fields (if any of these don’t exist, we just skip them)
  const summaryRisk = document.getElementById("summaryBridgeRisk");
  const summaryDistance = document.getElementById("summaryDistance");
  const summaryDuration = document.getElementById("summaryDuration");
  const summaryNearestBridge = document.getElementById("summaryNearestBridge");
  const statusMessage = document.getElementById("statusMessage");

  function setStatus(message, isError = false) {
    if (statusMessage) {
      statusMessage.textContent = message;
      statusMessage.style.color = isError ? "#b00020" : "#0a5c0a";
    } else {
      console.log(message);
    }
  }

  function updateSummary(data) {
    if (summaryRisk) {
      summaryRisk.textContent = data.bridge_risk || "Unknown";
    }
    if (summaryDistance) {
      summaryDistance.textContent =
        data.distance_km != null ? `${data.distance_km.toFixed(1)} km` : "–";
    }
    if (summaryDuration) {
      summaryDuration.textContent =
        data.duration_min != null ? `${Math.round(data.duration_min)} mins` : "–";
    }
    if (summaryNearestBridge) {
      if (data.nearest_bridge_height_m != null && data.nearest_bridge_distance_m != null) {
        summaryNearestBridge.textContent =
          `${data.nearest_bridge_height_m.toFixed(2)} m high, ` +
          `${data.nearest_bridge_distance_m.toFixed(0)} m from route`;
      } else {
        summaryNearestBridge.textContent = "None on route";
      }
    }
  }

  async function handleGenerate(evt) {
    if (evt) evt.preventDefault();

    const start_postcode = startInput ? startInput.value.trim() : "";
    const dest_postcode = destInput ? destInput.value.trim() : "";
    const vehicle_height_m = heightInput ? parseFloat(heightInput.value) : NaN;
    const avoid_low_bridges = avoidCheckbox ? !!avoidCheckbox.checked : true;

    if (!start_postcode || !dest_postcode || isNaN(vehicle_height_m)) {
      setStatus("Please fill in all fields (both postcodes and vehicle height).", true);
      return;
    }

    const payload = {
      start_postcode,
      dest_postcode,
      vehicle_height_m,
      avoid_low_bridges,
    };

    setStatus("Calculating safest route…");

    try {
      const response = await fetch(`${API_BASE_URL}/api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("API error", response.status, text);
        setStatus(`Route planner error (${response.status}). Please try again.`, true);
        return;
      }

      const data = await response.json();
      console.log("Route response", data);

      updateSummary(data);
      setStatus("Route calculated successfully.");
    } catch (err) {
      console.error("Network/API error", err);
      setStatus("Could not contact RouteSafe Navigator API. Please try again.", true);
    }
  }

  // Hook up events
  if (form) {
    form.addEventListener("submit", handleGenerate);
  }
  if (generateBtn) {
    generateBtn.addEventListener("click", handleGenerate);
  }
});
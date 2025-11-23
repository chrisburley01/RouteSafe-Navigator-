// main.js
// RouteSafe Navigator frontend logic

const API_URL = "https://routesafe-navigatorv2.onrender.com";

// Small helper to get an element safely
function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setBadge(risk) {
  const badge = $("riskBadge");
  const label = $("riskLabel");
  if (!badge || !label) return;

  const normalised = (risk || "").toLowerCase();

  badge.classList.remove(
    "badge-low",
    "badge-medium",
    "badge-high",
    "badge-unknown"
  );

  let cls = "badge-unknown";
  let txt = "Unknown";

  if (normalised === "low") {
    cls = "badge-low";
    txt = "Low risk";
  } else if (normalised === "medium") {
    cls = "badge-medium";
    txt = "Medium risk";
  } else if (normalised === "high") {
    cls = "badge-high";
    txt = "HIGH risk";
  }

  badge.classList.add(cls);
  label.textContent = txt;
}

function showLoading(isLoading) {
  const btn = $("planRouteBtn");
  const spinner = $("loadingSpinner");
  const error = $("errorBanner");

  if (btn) {
    btn.disabled = isLoading;
  }
  if (spinner) {
    spinner.style.display = isLoading ? "inline-block" : "none";
  }
  if (error && isLoading) {
    error.style.display = "none";
  }
}

function showError(message) {
  const error = $("errorBanner");
  if (!error) return;
  error.textContent = message || "Something went wrong. Please try again.";
  error.style.display = "block";
}

function showResultCard(show) {
  const card = $("resultCard");
  if (!card) return;
  card.style.display = show ? "block" : "none";
}

async function handlePlanRoute(event) {
  event.preventDefault();

  const startPostcodeEl = $("startPostcode");
  const destPostcodeEl = $("destPostcode");
  const heightEl = $("vehicleHeight");
  const avoidEl = $("avoidLowBridges");

  if (!startPostcodeEl || !destPostcodeEl || !heightEl || !avoidEl) {
    console.error("One or more input elements are missing from the page.");
    return;
  }

  const start_postcode = startPostcodeEl.value.trim();
  const dest_postcode = destPostcodeEl.value.trim();
  const vehicle_height_m = parseFloat(heightEl.value);
  const avoid_low_bridges = avoidEl.checked;

  if (!start_postcode || !dest_postcode || isNaN(vehicle_height_m)) {
    showError("Please enter both postcodes and a valid vehicle height.");
    return;
  }

  showLoading(true);
  showResultCard(false);

  try {
    const response = await fetch(`${API_URL}/api/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        start_postcode,
        dest_postcode,
        vehicle_height_m,
        avoid_low_bridges,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("API error:", response.status, text);
      showError(
        `Route request failed (${response.status}). Please check the postcodes and try again.`
      );
      return;
    }

    const data = await response.json();

    // Expected from API:
    // {
    //   distance_km,
    //   duration_min,
    //   bridge_risk,
    //   nearest_bridge_height_m,
    //   nearest_bridge_distance_m,
    //   geometry
    // }

    setText(
      "distanceValue",
      data.distance_km != null ? `${data.distance_km.toFixed(1)} km` : "–"
    );
    setText(
      "durationValue",
      data.duration_min != null ? `${data.duration_min.toFixed(0)} min` : "–"
    );

    if (data.nearest_bridge_height_m != null) {
      setText(
        "bridgeHeightValue",
        `${data.nearest_bridge_height_m.toFixed(2)} m`
      );
    } else {
      setText("bridgeHeightValue", "–");
    }

    if (data.nearest_bridge_distance_m != null) {
      setText(
        "bridgeDistanceValue",
        `${data.nearest_bridge_distance_m.toFixed(0)} m`
      );
    } else {
      setText("bridgeDistanceValue", "–");
    }

    setBadge(data.bridge_risk);

    // Optional: dump raw geometry (for debugging)
    const geomEl = $("geometryDebug");
    if (geomEl) {
      geomEl.value = data.geometry
        ? JSON.stringify(data.geometry).slice(0, 4000)
        : "";
    }

    showResultCard(true);
  } catch (err) {
    console.error("Network / JS error:", err);
    showError("Network error talking to RouteSafe Navigator API.");
  } finally {
    showLoading(false);
  }
}

// Hook everything up on load
document.addEventListener("DOMContentLoaded", () => {
  const form = $("routeForm");
  if (form) {
    form.addEventListener("submit", handlePlanRoute);
  } else {
    console.error("routeForm element not found in DOM.");
  }

  // Hide result card initially
  showResultCard(false);
  const spinner = $("loadingSpinner");
  if (spinner) spinner.style.display = "none";
  const error = $("errorBanner");
  if (error) error.style.display = "none";
});
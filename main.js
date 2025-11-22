// main.js
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

    // Expecting backend shape; adjust to your actual JSON fields.
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

    // TODO: draw route + markers on map once library wired in
    if (mapEmptyState) {
      mapEmptyState.style.opacity = 0.15;
    }
  }

  function getBadgeClass(level) {
    if (level === "high") return "ws-badge--danger";
    if (level === "medium") return "ws-badge--warn";
    if (level === "low") return "ws-badge--ok";
    return "ws-badge--muted";
  }

  // Demo payload generator if backend is offline
  function buildDemoRoute(start, end, vehicleHeightM) {
    const highRisk = vehicleHeightM > 4.8;
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
      // geometry / coords will arrive from backend later
      geometry: null,
    };
  }
});
// =============================================
// RouteSafe Navigator – Frontend JS (v1.0)
// =============================================

// 🔗 BACKEND ROUTESAFE-AI API
const API_BASE_URL = "https://routesafe-ai.onrender.com";  



// ----------------------------
// DOM ELEMENTS
// ----------------------------
const form = document.getElementById("route-form");
const mapContainer = document.getElementById("map");
const metricsBox = document.getElementById("metrics-box");
const warnBox = document.getElementById("warnings-box");
const stepsBox = document.getElementById("steps-box");

let map; // Leaflet instance
let mainRouteLayer;
let altRouteLayer;
let bridgeLayer;


// ----------------------------
// INITIALISE MAP
// ----------------------------
function initMap() {
    map = L.map(mapContainer).setView([53.8, -1.55], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    mainRouteLayer = L.geoJSON().addTo(map);
    altRouteLayer = L.geoJSON().addTo(map);
    bridgeLayer = L.layerGroup().addTo(map);
}

initMap();


// ----------------------------
// HELPER: Draw route on map
// ----------------------------
function drawRoute(geojson, layer, colour, dashed=false) {
    layer.clearLayers();

    if (!geojson) return;

    layer.addData(geojson);

    layer.setStyle({
        color: colour,
        weight: 5,
        opacity: 0.9,
        dashArray: dashed ? "8 8" : null
    });

    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
}


// ----------------------------
// HELPER: Draw bridge hazards
// ----------------------------
function drawBridges(bridges) {
    bridgeLayer.clearLayers();
    if (!bridges) return;

    bridges.forEach(b => {
        const marker = L.circleMarker([b.lat, b.lon], {
            radius: 6,
            color: "#ff4e33",
            fillColor: "#ff4e33",
            fillOpacity: 0.9
        });

        marker.bindPopup(`Low bridge:<br><b>${b.height_m}m</b>`);
        marker.addTo(bridgeLayer);
    });
}


// ----------------------------
// DISPLAY METRICS / WARNINGS
// ----------------------------
function renderMetrics(m) {
    if (!m) {
        metricsBox.innerHTML = "<p>No metrics returned.</p>";
        return;
    }

    metricsBox.innerHTML = `
        <p><b>Main route distance:</b> ${m.main_distance_km} km</p>
        <p><b>Alternative distance:</b> ${m.alt_distance_km ?? "N/A"} km</p>
        <p><b>Main duration:</b> ${m.main_duration_min} min</p>
        <p><b>Low-bridge conflicts:</b> ${m.low_bridge_conflicts}</p>
    `;
}

function renderWarnings(w) {
    if (!w || w.length === 0) {
        warnBox.innerHTML = "<p>No warnings 🎉</p>";
        return;
    }

    warnBox.innerHTML = w
        .map(item => `<p>⚠️ ${item}</p>`)
        .join("");
}

function renderSteps(steps) {
    if (!steps || steps.length === 0) {
        stepsBox.innerHTML = "<p>No turn-by-turn steps.</p>";
        return;
    }

    stepsBox.innerHTML = steps
        .map(s => `<p>➡️ ${s}</p>`)
        .join("");
}



// ----------------------------
// SUBMIT HANDLER – CALL API
// ----------------------------
form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const start = document.getElementById("start").value.trim();
    const end = document.getElementById("end").value.trim();
    const height = parseFloat(document.getElementById("height").value);
    const avoid = document.getElementById("avoid-low").checked;

    if (!start || !end) {
        alert("Enter both start and destination.");
        return;
    }

    const payload = {
        start,
        end,
        vehicle_height_m: height,
        avoid_low_bridges: avoid
    };

    // Reset UI
    mainRouteLayer.clearLayers();
    altRouteLayer.clearLayers();
    bridgeLayer.clearLayers();
    metricsBox.innerHTML = "Loading…";
    warnBox.innerHTML = "";
    stepsBox.innerHTML = "";

    try {
        const res = await fetch(`${API_BASE_URL}/api/route`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            throw new Error(`API error: ${res.status}`);
        }

        const data = await res.json();

        // Draw main + alt routes
        if (data.main_geojson) {
            drawRoute(data.main_geojson, mainRouteLayer, "#3aa0ff", false);
        }
        if (data.alt_geojson) {
            drawRoute(data.alt_geojson, altRouteLayer, "#94c5ff", true);
        }

        // Bridge hazard markers
        drawBridges(data.bridges);

        // Metrics + warnings + steps
        renderMetrics(data.metrics);
        renderWarnings(data.warnings);
        renderSteps(data.steps);

    } catch (err) {
        console.error(err);
        metricsBox.innerHTML = `<p style="color:red;">Error: ${err.message}</p>`;
    }
});
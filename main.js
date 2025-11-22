// ==========================
// RouteSafe Navigator (FULL)
// ==========================

// CLEAN UK POSTCODES BEFORE SENDING TO BACKEND
function normalisePostcode(value) {
  if (!value) return value;

  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (raw.length < 5 || raw.length > 7) return value.trim();

  return raw.slice(0, raw.length - 3) + " " + raw.slice(-3);
}

const API_URL = "https://routesafe-ai.onrender.com/api/route";

let map = L.map("map").setView([53.8, -1.55], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
}).addTo(map);

let mainRouteLayer = null;

document.getElementById("routeForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const startRaw = document.getElementById("start").value;
  const endRaw = document.getElementById("end").value;
  const vehicleHeight = parseFloat(document.getElementById("vehicleHeight").value);
  const avoidLowBridges = document.getElementById("avoidLowBridges").checked;

  // Postcode clean
  const start = normalisePostcode(startRaw);
  const end = normalisePostcode(endRaw);

  const status = document.getElementById("routeStatus");
  status.textContent = "Requesting safe HGV route from RouteSafe-AI...";

  const payload = {
    start,
    end,
    vehicle_height_m: vehicleHeight,
    avoid_low_bridges: avoidLowBridges,
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers:
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import os
import json

from bridge_engine import BridgeEngine

app = FastAPI()

# ------------------------------------------------------------------------------
# CORS – allow static site to call backend
# ------------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# ORS API KEY
# ------------------------------------------------------------------------------
ORS_API_KEY = os.getenv("ORS_API_KEY")
if not ORS_API_KEY:
    print("WARNING: ORS_API_KEY is not set!")


# ------------------------------------------------------------------------------
# Bridge engine
# ------------------------------------------------------------------------------
bridge_engine = BridgeEngine(
    csv_path="bridge_heights_clean.csv",
    search_radius_m=300,
    conflict_clearance_m=0.0,
    near_clearance_m=0.25,
)


# ------------------------------------------------------------------------------
# Input model
# ------------------------------------------------------------------------------
class RouteRequest(BaseModel):
    start: str
    destination: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


# ------------------------------------------------------------------------------
# Health check
# ------------------------------------------------------------------------------
@app.get("/")
def root():
    return {"status": "ok", "service": "routesafe-backend"}


# ------------------------------------------------------------------------------
# ORS geocode helper
# ------------------------------------------------------------------------------
def geocode(postcode: str):
    url = "https://api.openrouteservice.org/geocode/search"
    params = {"api_key": ORS_API_KEY, "text": postcode, "boundary.country": "GBR"}
    r = requests.get(url, params=params, timeout=15)
    data = r.json()

    if "features" not in data or not data["features"]:
        raise HTTPException(status_code=400, detail=f"Could not geocode: {postcode}")

    coords = data["features"][0]["geometry"]["coordinates"]
    return coords[1], coords[0]  # lat, lon


# ------------------------------------------------------------------------------
# ORS routing helper
# ------------------------------------------------------------------------------
def ors_route(lat1, lon1, lat2, lon2):
    url = "https://api.openrouteservice.org/v2/directions/driving-hgv"
    headers = {"Authorization": ORS_API_KEY}
    body = {
        "coordinates": [
            [lon1, lat1],
            [lon2, lat2]
        ]
    }

    r = requests.post(url, json=body, headers=headers, timeout=20)
    if r.status_code != 200:
        print("ORS error:", r.text)
        raise HTTPException(status_code=500, detail="ORS routing failed")

    return r.json()


# ------------------------------------------------------------------------------
# Main routing endpoint
# ------------------------------------------------------------------------------
@app.post("/api/route")
def route(req: RouteRequest):
    # Geocode
    lat1, lon1 = geocode(req.start)
    lat2, lon2 = geocode(req.destination)

    # Route from ORS
    ors = ors_route(lat1, lon1, lat2, lon2)

    summary = ors["features"][0]["properties"]["summary"]
    geometry = ors["features"][0]["geometry"]

    distance_km = summary.get("distance", 0) / 1000.0
    duration_min = summary.get("duration", 0) / 60.0

    # Bridge checks along straight line (start → end)
    bridge_result = bridge_engine.check_leg(
        (lat1, lon1),
        (lat2, lon2),
        req.vehicle_height_m
    )

    nearest_bridge = None
    if bridge_result.nearest_bridge:
        nearest_bridge = {
            "lat": bridge_result.nearest_bridge.lat,
            "lon": bridge_result.nearest_bridge.lon,
            "height_m": bridge_result.nearest_bridge.height_m,
            "distance_m": bridge_result.nearest_distance_m,
        }

    # Risk level logic
    if bridge_result.has_conflict:
        risk_level = "high"
    elif bridge_result.near_height_limit:
        risk_level = "medium"
    else:
        risk_level = "low"

    return {
        "distance_km": distance_km,
        "duration_min": duration_min,
        "risk_level": risk_level,
        "bridge_result": {
            "has_conflict": bridge_result.has_conflict,
            "near_height_limit": bridge_result.near_height_limit,
            "conflicts": []  # future: provide detailed conflicts
        },
        "nearest_bridge": nearest_bridge,
        "route_geojson": geometry
    }
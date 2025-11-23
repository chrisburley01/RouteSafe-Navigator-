# main.py
#
# RouteSafe Navigator backend
# FastAPI + OpenRouteService + UK low-bridge engine

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

import os
import requests

from bridge_engine import BridgeEngine


# -----------------------------------------------------------------------------
# FastAPI app + CORS
# -----------------------------------------------------------------------------

app = FastAPI(title="RouteSafe Navigator Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # lock down later if you want
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

ORS_API_KEY = os.getenv("ORS_API_KEY")

if not ORS_API_KEY:
    # It will still start, but any route call will fail with a clear error
    print("⚠️  WARNING: ORS_API_KEY environment variable is NOT set.")


# Bridge engine (loads CSV once on startup)
bridge_engine = BridgeEngine(
    csv_path="bridge_heights_clean.csv",
    search_radius_m=300.0,
    conflict_clearance_m=0.0,
    near_clearance_m=0.25,
)


# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------

class RouteRequest(BaseModel):
    start: str                # UK postcode or address
    destination: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


class NearestBridge(BaseModel):
    lat: float
    lon: float
    height_m: float
    distance_m: float


class RouteResponse(BaseModel):
    distance_km: float
    duration_min: float
    risk_level: str
    bridge_result: dict
    nearest_bridge: Optional[NearestBridge]
    route_geojson: dict


# -----------------------------------------------------------------------------
# Helpers – ORS
# -----------------------------------------------------------------------------

def _require_ors_key():
    if not ORS_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ORS_API_KEY is not configured on the server."
        )


def geocode(postcode: str):
    """
    Geocode a UK postcode using ORS.
    Returns (lat, lon).
    """
    _require_ors_key()

    url = "https://api.openrouteservice.org/geocode/search"
    params = {
        "api_key": ORS_API_KEY,
        "text": postcode,
        "boundary.country": "GBR",
    }

    try:
        r = requests.get(url, params=params, timeout=15)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Geocoding request failed: {e}")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Geocoding failed: {r.text}")

    data = r.json()
    features = data.get("features", [])
    if not features:
        raise HTTPException(status_code=400, detail=f"Could not geocode: {postcode}")

    coords = features[0]["geometry"]["coordinates"]  # [lon, lat]
    return coords[1], coords[0]


def ors_route(lat1: float, lon1: float, lat2: float, lon2: float) -> dict:
    """
    Request an HGV route from ORS.
    Returns the JSON response.
    """
    _require_ors_key()

    url = "https://api.openrouteservice.org/v2/directions/driving-hgv"
    headers = {"Authorization": ORS_API_KEY}
    body = {
        "coordinates": [
            [lon1, lat1],
            [lon2, lat2],
        ]
    }

    try:
        r = requests.post(url, json=body, headers=headers, timeout=30)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Routing request failed: {e}")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Routing failed: {r.text}")

    return r.json()


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------

@app.get("/")
def root():
    """
    Simple health endpoint – DOES NOT try to serve index.html.
    """
    return {"status": "ok", "service": "routesafe-backend"}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    """
    Main routing endpoint used by the frontend.
    """
    # 1) Geocode start + destination
    lat1, lon1 = geocode(req.start)
    lat2, lon2 = geocode(req.destination)

    # 2) Request HGV route from ORS
    ors_data = ors_route(lat1, lon1, lat2, lon2)

    feature = ors_data["features"][0]
    summary = feature["properties"]["summary"]
    geometry = feature["geometry"]

    distance_km = summary.get("distance", 0.0) / 1000.0
    duration_min = summary.get("duration", 0.0) / 60.0

    # 3) Bridge check along the leg (start → end).
    #    (Simple leg check – we can later upgrade to follow the polyline.)
    bridge_result = bridge_engine.check_leg(
        (lat1, lon1),
        (lat2, lon2),
        req.vehicle_height_m,
    )

    nearest_bridge = None
    if bridge_result.nearest_bridge is not None:
        nearest_bridge = NearestBridge(
            lat=bridge_result.nearest_bridge.lat,
            lon=bridge_result.nearest_bridge.lon,
            height_m=bridge_result.nearest_bridge.height_m,
            distance_m=bridge_result.nearest_distance_m or 0.0,
        )

    # Determine overall risk level
    if bridge_result.has_conflict:
        risk_level = "high"
    elif bridge_result.near_height_limit:
        risk_level = "medium"
    else:
        risk_level = "low"

    bridge_result_dict = {
        "has_conflict": bridge_result.has_conflict,
        "near_height_limit": bridge_result.near_height_limit,
        # Placeholder for future detailed conflict list
        "conflicts": [],
    }

    return RouteResponse(
        distance_km=distance_km,
        duration_min=duration_min,
        risk_level=risk_level,
        bridge_result=bridge_result_dict,
        nearest_bridge=nearest_bridge,
        route_geojson=geometry,
    )
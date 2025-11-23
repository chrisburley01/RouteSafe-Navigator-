# main.py – RouteSafe Navigator backend (Render)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import openrouteservice

from bridge_engine import BridgeEngine, BridgeCheckResult

app = FastAPI(title="RouteSafe Navigator API", version="1.0")

# Allow the static frontend domains
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can lock this down later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazily init engine so a CSV issue doesn’t blow up startup
_bridge_engine: BridgeEngine | None = None
_ors_client: openrouteservice.Client | None = None


def get_bridge_engine() -> BridgeEngine:
    global _bridge_engine
    if _bridge_engine is None:
        _bridge_engine = BridgeEngine()  # uses auto CSV locator
    return _bridge_engine


def get_ors_client() -> openrouteservice.Client:
    global _ors_client
    if _ors_client is None:
        api_key = os.getenv("ORS_API_KEY")
        if not api_key:
            raise RuntimeError("ORS_API_KEY environment variable not set")
        _ors_client = openrouteservice.Client(key=api_key)
    return _ors_client


class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


class RouteResponse(BaseModel):
    distance_km: float
    duration_min: float
    bridge_risk: str
    nearest_bridge_height_m: float | None
    nearest_bridge_distance_m: float | None
    geometry: dict


@app.get("/")
def root():
    return {"status": "ok", "service": "RouteSafe Navigator API"}


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    try:
        engine = get_bridge_engine()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"BridgeEngine error: {e}")

    try:
        ors = get_ors_client()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ORS client error: {e}")

    # Geocode postcodes via ORS
    try:
        start = ors.pelias_search(text=req.start_postcode)["features"][0]["geometry"]["coordinates"]
        dest = ors.pelias_search(text=req.dest_postcode)["features"][0]["geometry"]["coordinates"]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error geocoding postcodes: {e}")

    # ORS uses [lon, lat]
    start_lon, start_lat = start
    dest_lon, dest_lat = dest

    # Get a route from ORS
    try:
        route = ors.directions(
           coordinates=[start, dest],
           profile="driving-hgv",
           format="geojson",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting route from ORS: {e}")

    feat = route["features"][0]
    props = feat["properties"]
    distance_km = props["segments"][0]["distance"] / 1000.0
    duration_min = props["segments"][0]["duration"] / 60.0

    # For now we just check the straight line leg start→end with BridgeEngine
    check: BridgeCheckResult = engine.check_leg_for_bridges(
        start_lat=start_lat,
        start_lon=start_lon,
        end_lat=dest_lat,
        end_lon=dest_lon,
        vehicle_height_m=req.vehicle_height_m,
    )

    if check.has_conflict and req.avoid_low_bridges:
        risk = "conflict"
    elif check.near_height_limit:
        risk = "near-limit"
    else:
        risk = "low"

    nearest_height = check.nearest_bridge.height_m if check.nearest_bridge else None

    return RouteResponse(
        distance_km=distance_km,
        duration_min=duration_min,
        bridge_risk=risk,
        nearest_bridge_height_m=nearest_height,
        nearest_bridge_distance_m=check.nearest_distance_m,
        geometry=feat["geometry"],
    )


# Uvicorn entry point for Render
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=10000, reload=True)
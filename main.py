import os
import math
from typing import List, Optional, Dict, Any, Tuple

import pandas as pd
import openrouteservice
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# ==================== Config ====================

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"
BRIDGE_SEARCH_RADIUS_M = 300.0   # how close a bridge has to be to the route to be considered "on route"
MAX_ROUTE_SAMPLES = 200          # sampling of geometry for speed

ORS_API_KEY = os.getenv("ORS_API_KEY")
if not ORS_API_KEY:
    raise RuntimeError("ORS_API_KEY environment variable ORS_API_KEY not set")

ors_client = openrouteservice.Client(key=ORS_API_KEY)


# ==================== Helpers ====================

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Distance in metres between two lat/lon points.
    """
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def geocode_postcode(postcode: str) -> Tuple[float, float]:
    """
    Geocode UK postcode via ORS Pelias search.
    Returns (lat, lon).
    """
    try:
        res = ors_client.pelias_search(text=postcode, size=1)
        features = res.get("features") or []
        if not features:
            raise HTTPException(status_code=400, detail=f"Could not geocode postcode '{postcode}'")
        geom = features[0]["geometry"]
        lon, lat = geom["coordinates"]
        return float(lat), float(lon)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error geocoding postcode '{postcode}': {e}")


# ==================== Bridge data ====================

# Load UK low-bridge data once at startup
try:
    _bridge_df = pd.read_csv(BRIDGE_CSV_PATH)
    BRIDGES: List[Dict[str, Any]] = _bridge_df.to_dict(orient="records")
except Exception as e:
    raise RuntimeError(f"Error loading bridge CSV '{BRIDGE_CSV_PATH}': {e}")


def analyse_bridges_along_route(
    coords: List[List[float]],
    vehicle_height_m: float,
) -> Tuple[str, Optional[Dict[str, Any]], Optional[float], List[Dict[str, Any]]]:
    """
    Given a route polyline (lon, lat) and vehicle height, work out:

    - overall risk ("None", "Low", "Conflict")
    - nearest bridge (any height)
    - distance to nearest bridge in metres
    - list of conflicting bridges (height < vehicle & within radius)
    """
    if not coords or not BRIDGES:
        return "None", None, None, []

    # Sample the route to keep it cheap
    step = max(1, len(coords) // MAX_ROUTE_SAMPLES)
    sample_points = coords[::step]

    nearest_bridge: Optional[Dict[str, Any]] = None
    nearest_distance_m: Optional[float] = None
    conflicting: List[Dict[str, Any]] = []

    for lon, lat in sample_points:
        for b in BRIDGES:
            blat = float(b["lat"])
            blon = float(b["lon"])
            dist = haversine_m(lat, lon, blat, blon)

            # Track absolute nearest bridge
            if nearest_distance_m is None or dist < nearest_distance_m:
                nearest_distance_m = dist
                nearest_bridge = b

            # Conflicting bridge (too low & close enough to route)
            try:
                bheight = float(b["height_m"])
            except Exception:
                continue

            if vehicle_height_m and bheight < vehicle_height_m and dist <= BRIDGE_SEARCH_RADIUS_M:
                conflicting.append(
                    {
                        "lat": blat,
                        "lon": blon,
                        "height_m": bheight,
                        "distance_m": dist,
                    }
                )

    if conflicting:
        risk = "Conflict"
    elif nearest_bridge is not None:
        risk = "Low"
    else:
        risk = "None"

    return risk, nearest_bridge, nearest_distance_m, conflicting


def build_avoid_polygon_for_conflicts(conflicts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Build a simple avoid polygon around the first conflicting bridge.
    ORS expects a GeoJSON Polygon in lon/lat.
    """
    if not conflicts:
        return None

    lat = conflicts[0]["lat"]
    lon = conflicts[0]["lon"]

    # ~500m box around bridge (very rough, but fine for prototype)
    delta = 0.005
    ring = [
        [lon - delta, lat - delta],
        [lon - delta, lat + delta],
        [lon + delta, lat + delta],
        [lon + delta, lat - delta],
        [lon - delta, lat - delta],
    ]

    return {"type": "Polygon", "coordinates": [ring]}


# ==================== Pydantic models ====================

class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float = Field(..., gt=0, description="Vehicle height in metres")
    vehicle_weight_t: Optional[float] = Field(
        default=None,
        gt=0,
        description="Vehicle gross weight in tonnes (for weight-restricted routing)",
    )
    avoid_low_bridges: bool = True


class RouteGeometry(BaseModel):
    coords: List[List[float]]  # [lon, lat]


class BridgeInfo(BaseModel):
    lat: float
    lon: float
    height_m: float
    distance_m: float


class RouteMetrics(BaseModel):
    distance_km: float
    duration_min: float


class RouteResponse(BaseModel):
    metrics: RouteMetrics
    bridge_risk: str
    nearest_bridge_height_m: Optional[float]
    nearest_bridge_distance_m: Optional[float]
    risk_level: str
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry] = None
    conflict_bridges: List[BridgeInfo] = []


# ==================== FastAPI app ====================

app = FastAPI(title="RouteSafe Navigator API", version="1.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> dict:
    return {"message": "RouteSafe Navigator API"}


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


def build_ors_options(req: RouteRequest) -> Dict[str, Any]:
    """
    Build ORS options for HGV height/weight restrictions.
    """
    restrictions: Dict[str, Any] = {"height": req.vehicle_height_m}

    if req.vehicle_weight_t and req.vehicle_weight_t > 0:
        # ORS expects kilograms
        restrictions["weight"] = req.vehicle_weight_t * 1000.0

    options: Dict[str, Any] = {
        "profile_params": {"restrictions": restrictions},
        "vehicle_type": "hgv",
    }
    return options


def call_ors_directions(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    options: Dict[str, Any],
) -> Dict[str, Any]:
    coords = [(start_lon, start_lat), (end_lon, end_lat)]
    try:
        route = ors_client.directions(
            coordinates=coords,
            profile="driving-hgv",
            format="geojson",
            **{"options": options},
        )
        return route
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error getting route from ORS: {e}")


def extract_metrics_and_geometry(route: Dict[str, Any]) -> Tuple[RouteMetrics, List[List[float]]]:
    try:
        feat = route["features"][0]
        props = feat["properties"]
        summary = props.get("summary") or {}
        distance_km = float(summary.get("distance", 0.0)) / 1000.0
        duration_min = float(summary.get("duration", 0.0)) / 60.0
        coords = feat["geometry"]["coordinates"]
        metrics = RouteMetrics(distance_km=distance_km, duration_min=duration_min)
        return metrics, coords
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error parsing ORS response: {e}")


def derive_risk_level(
    bridge_risk: str,
    nearest_bridge_height_m: Optional[float],
    vehicle_height_m: float,
) -> str:
    if bridge_risk == "Conflict":
        return "High"
    if nearest_bridge_height_m is None:
        return "None"
    # if within 25cm of vehicle height, call it medium
    if nearest_bridge_height_m - vehicle_height_m < 0.25:
        return "Medium"
    return "Low"


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest) -> RouteResponse:
    # 1. Geocode postcodes
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    # 2. Main HGV route (height/weight aware)
    base_options = build_ors_options(req)
    main_route_raw = call_ors_directions(start_lat, start_lon, end_lat, end_lon, base_options)
    main_metrics, main_coords = extract_metrics_and_geometry(main_route_raw)

    # 3. Bridge analysis on main route
    bridge_risk, nearest_bridge, nearest_distance_m, conflicts = analyse_bridges_along_route(
        main_coords,
        vehicle_height_m=req.vehicle_height_m if req.avoid_low_bridges else 0.0,
    )

    nearest_bridge_height_m: Optional[float] = None
    if nearest_bridge is not None:
        try:
            nearest_bridge_height_m = float(nearest_bridge["height_m"])
        except Exception:
            nearest_bridge_height_m = None

    risk_level = derive_risk_level(
        bridge_risk=bridge_risk,
        nearest_bridge_height_m=nearest_bridge_height_m,
        vehicle_height_m=req.vehicle_height_m,
    )

    # 4. If bridge conflict and avoid_low_bridges is enabled, compute alternative route
    alt_geom: Optional[List[List[float]]] = None
    if req.avoid_low_bridges and bridge_risk == "Conflict" and conflicts:
        avoid_polygon = build_avoid_polygon_for_conflicts(conflicts)
        if avoid_polygon:
            alt_options = dict(base_options)  # shallow copy
            alt_options["avoid_polygons"] = avoid_polygon
            alt_route_raw = call_ors_directions(start_lat, start_lon, end_lat, end_lon, alt_options)
            _, alt_coords = extract_metrics_and_geometry(alt_route_raw)
            alt_geom = alt_coords

    # 5. Build response
    conflict_models = [
        BridgeInfo(
            lat=c["lat"],
            lon=c["lon"],
            height_m=c["height_m"],
            distance_m=c["distance_m"],
        )
        for c in conflicts
    ]

    resp = RouteResponse(
        metrics=main_metrics,
        bridge_risk=bridge_risk,
        nearest_bridge_height_m=nearest_bridge_height_m,
        nearest_bridge_distance_m=nearest_distance_m,
        risk_level=risk_level,
        main_route=RouteGeometry(coords=main_coords),
        alt_route=RouteGeometry(coords=alt_geom) if alt_geom else None,
        conflict_bridges=conflict_models,
    )
    return resp
# main.py
#
# RouteSafe Navigator v2 backend
# FastAPI + ORS + simple low-bridge engine

from __future__ import annotations

import csv
import json
import math
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ============== Config ==============

ORS_API_KEY = os.getenv("ORS_API_KEY")

ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search"
ORS_DIRECTIONS_URL = (
    "https://api.openrouteservice.org/v2/directions/driving-hgv"
)

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"

EARTH_RADIUS_M = 6371000.0

# ============== Bridge engine ==============


@dataclass
class Bridge:
    lat: float
    lon: float
    height_m: float


@dataclass
class BridgeCheckResult:
    has_conflict: bool
    near_height_limit: bool
    nearest_bridge: Optional[Bridge]
    nearest_distance_m: Optional[float]
    risk_level: str


class BridgeEngine:
    """
    Very simple low-bridge checker.
    Loads a CSV of bridges, then samples points along the route polyline
    and looks for nearby bridges that are lower than the vehicle height.
    """

    def __init__(
        self,
        csv_path: str = BRIDGE_CSV_PATH,
        search_radius_m: float = 300.0,
        conflict_clearance_m: float = 0.0,
        near_clearance_m: float = 0.25,
    ):
        self.search_radius_m = search_radius_m
        self.conflict_clearance_m = conflict_clearance_m
        self.near_clearance_m = near_clearance_m
        self.bridges: List[Bridge] = []

        try:
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    try:
                        lat = float(row["lat"])
                        lon = float(row["lon"])
                        height_m = float(row["height_m"])
                        self.bridges.append(Bridge(lat=lat, lon=lon, height_m=height_m))
                    except Exception:
                        # Skip bad rows
                        continue
        except FileNotFoundError:
            # No bridge data – engine will just return "Low" risk with no info
            self.bridges = []

    @staticmethod
    def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Distance in metres between two lat/lon points."""
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)

        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return EARTH_RADIUS_M * c

    def check_route(
        self, coords: List[Tuple[float, float]], vehicle_height_m: float
    ) -> Tuple[BridgeCheckResult, List[Bridge]]:
        """
        coords: list of (lat, lon) along the route
        Returns a BridgeCheckResult and a list of nearby bridges (for map plotting)
        """

        if not self.bridges or len(coords) < 2:
            return BridgeCheckResult(
                has_conflict=False,
                near_height_limit=False,
                nearest_bridge=None,
                nearest_distance_m=None,
                risk_level="Low",
            ), []

        # Sample every N-th point along the polyline to keep it cheap
        step = max(1, len(coords) // 100)  # at most ~100 samples
        sample_points = coords[::step]

        nearest_bridge: Optional[Bridge] = None
        nearest_distance_m: Optional[float] = None
        has_conflict = False
        near_limit = False
        nearby_bridges: List[Bridge] = []

        for (plat, plon) in sample_points:
            for bridge in self.bridges:
                d = self._haversine_m(plat, plon, bridge.lat, bridge.lon)
                if d <= self.search_radius_m:
                    # Track for plotting
                    if bridge not in nearby_bridges:
                        nearby_bridges.append(bridge)

                    clearance = bridge.height_m - vehicle_height_m

                    if clearance < self.conflict_clearance_m:
                        has_conflict = True
                    elif clearance < self.near_clearance_m:
                        near_limit = True

                    if nearest_distance_m is None or d < nearest_distance_m:
                        nearest_distance_m = d
                        nearest_bridge = bridge

        # Decide risk level
        if has_conflict:
            risk_level = "High"
        elif near_limit:
            risk_level = "Medium"
        else:
            risk_level = "Low"

        result = BridgeCheckResult(
            has_conflict=has_conflict,
            near_height_limit=near_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_distance_m,
            risk_level=risk_level,
        )
        return result, nearby_bridges


bridge_engine = BridgeEngine()

# ============== ORS helpers ==============


def _call_ors(url: str, params: dict | None = None, body: dict | None = None) -> dict:
    if not ORS_API_KEY:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    if params is None:
        params = {}
    params["api_key"] = ORS_API_KEY

    full_url = url + "?" + urllib.parse.urlencode(params)

    data_bytes = None
    headers = {}
    if body is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(full_url, data=data_bytes, headers=headers, method="POST" if body else "GET")

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error calling ORS: {e}") from e


def geocode_postcode(postcode: str) -> Tuple[float, float]:
    """
    Returns (lat, lon) for a UK postcode using ORS geocoding.
    """
    text = f"{postcode}, UK"
    data = _call_ors(
        ORS_GEOCODE_URL,
        params={"text": text, "boundary.country": "GBR", "size": 1},
    )
    features = data.get("features") or []
    if not features:
        raise HTTPException(status_code=400, detail=f"Could not geocode postcode '{postcode}'")

    geom = features[0].get("geometry", {})
    coords = geom.get("coordinates")
    if not coords or len(coords) < 2:
        raise HTTPException(status_code=400, detail=f"Invalid geocode result for '{postcode}'")

    lon, lat = coords[0], coords[1]
    return lat, lon


def get_hgv_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float):
    """
    Calls ORS HGV directions and returns (coords[(lat,lon)...], distance_km, duration_min)
    """
    body = {
        "coordinates": [
            [start_lon, start_lat],
            [end_lon, end_lat],
        ]
    }
    data = _call_ors(
        ORS_DIRECTIONS_URL,
        params={"geometry_format": "geojson"},
        body=body,
    )

    routes = data.get("routes") or []
    if not routes:
        raise HTTPException(status_code=502, detail="No route returned from ORS")

    route = routes[0]
    summary = route.get("summary", {})
    distance_m = float(summary.get("distance", 0.0))
    duration_s = float(summary.get("duration", 0.0))

    geom = route.get("geometry", {})
    coords_raw = geom.get("coordinates") or []
    # ORS GeoJSON coords are [lon, lat] – convert to [lat, lon]
    coords = [[c[1], c[0]] for c in coords_raw]

    distance_km = distance_m / 1000.0
    duration_min = duration_s / 60.0

    return coords, distance_km, duration_min


# ============== Pydantic models ==============


class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


class RouteGeometry(BaseModel):
    coords: List[List[float]]
    distance_km: float
    duration_min: float


class BridgeInfo(BaseModel):
    lat: float
    lon: float
    height_m: float
    distance_m: float


class BridgeResultModel(BaseModel):
    has_conflict: bool
    near_height_limit: bool
    nearest_bridge_height_m: Optional[float] = None
    nearest_bridge_distance_m: Optional[float] = None
    risk_level: str


class RouteResponse(BaseModel):
    metrics: dict
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry] = None  # placeholder for future
    bridges: List[BridgeInfo]
    bridge_result: BridgeResultModel


# ============== FastAPI app ==============

app = FastAPI(title="RouteSafe Navigator API", version="1.0")

# CORS so the static frontend can talk to this API
origins = [
    "https://routesafe-navigator.onrender.com",
    "http://localhost",
    "http://localhost:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"message": "RouteSafe Navigator API"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    # 1. Geocode postcodes
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    # 2. Get HGV route from ORS
    coords, distance_km, duration_min = get_hgv_route(
        start_lat, start_lon, end_lat, end_lon
    )

    # 3. Check for low bridges (if requested)
    bridges_for_map: List[BridgeInfo] = []
    if req.avoid_low_bridges:
        br_result, nearby_bridges = bridge_engine.check_route(
            coords, req.vehicle_height_m
        )
        for b in nearby_bridges:
            # Distance from first point – simple approximation for now
            d = bridge_engine._haversine_m(coords[0][0], coords[0][1], b.lat, b.lon)
            bridges_for_map.append(
                BridgeInfo(
                    lat=b.lat,
                    lon=b.lon,
                    height_m=b.height_m,
                    distance_m=d,
                )
            )

        nearest_h = (
            br_result.nearest_bridge.height_m if br_result.nearest_bridge else None
        )
        nearest_d = br_result.nearest_distance_m

        bridge_result_model = BridgeResultModel(
            has_conflict=br_result.has_conflict,
            near_height_limit=br_result.near_height_limit,
            nearest_bridge_height_m=nearest_h,
            nearest_bridge_distance_m=nearest_d,
            risk_level=br_result.risk_level,
        )
    else:
        bridge_result_model = BridgeResultModel(
            has_conflict=False,
            near_height_limit=False,
            nearest_bridge_height_m=None,
            nearest_bridge_distance_m=None,
            risk_level="Low",
        )

    main_geom = RouteGeometry(
        coords=coords,
        distance_km=distance_km,
        duration_min=duration_min,
    )

    metrics = {
        "distance_km": distance_km,
        "duration_min": duration_min,
    }

    resp = RouteResponse(
        metrics=metrics,
        main_route=main_geom,
        alt_route=None,
        bridges=bridges_for_map,
        bridge_result=bridge_result_model,
    )
    return resp
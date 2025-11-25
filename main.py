from __future__ import annotations

import csv
import json
import math
import os
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict

import urllib.parse
import urllib.request

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ================== Config ==================

ORS_API_KEY = os.getenv("ORS_API_KEY")
if not ORS_API_KEY:
  # We don't crash app, but /api/route will raise a clear 500
  print("WARNING: ORS_API_KEY is not set – /api/route will fail until configured.")

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"
EARTH_RADIUS_M = 6371000.0

ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search"
ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson"

# ================== Bridge engine ==================


@dataclass
class Bridge:
    lat: float
    lon: float
    height_m: float


@dataclass
class BridgeScanResult:
    has_conflict: bool
    near_height_limit: bool
    nearest_bridge: Optional[Bridge]
    nearest_distance_m: Optional[float]
    risk_level: str


class BridgeEngine:
    """
    Loads low-bridge data from CSV and can scan a route polyline
    for bridges that are too low for a given vehicle height.
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
            print(f"Loaded {len(self.bridges)} bridges from {csv_path}")
        except FileNotFoundError:
            print(f"WARNING: {csv_path} not found – bridge checks disabled.")
            self.bridges = []

    @staticmethod
    def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
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

    def scan_route(
        self, coords: List[Tuple[float, float]], vehicle_height_m: float
    ) -> Tuple[BridgeScanResult, List[Bridge]]:
        """
        coords: list of [lat, lon] along the route polyline
        Returns (BridgeScanResult, list_of_nearby_bridges)
        """

        if not self.bridges or len(coords) < 2:
            # No data = assume low risk
            result = BridgeScanResult(
                has_conflict=False,
                near_height_limit=False,
                nearest_bridge=None,
                nearest_distance_m=None,
                risk_level="Low",
            )
            return result, []

        # Sample at most ~100 points along route for efficiency
        step = max(1, len(coords) // 100)
        sample_points = coords[::step]

        nearest_bridge: Optional[Bridge] = None
        nearest_distance_m: Optional[float] = None
        has_conflict = False
        near_limit = False
        nearby_bridges: List[Bridge] = []

        for plat, plon in sample_points:
            for bridge in self.bridges:
                d = self.haversine_m(plat, plon, bridge.lat, bridge.lon)
                if d <= self.search_radius_m:
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

        if has_conflict:
            risk = "High"
        elif near_limit:
            risk = "Medium"
        else:
            risk = "Low"

        result = BridgeScanResult(
            has_conflict=has_conflict,
            near_height_limit=near_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_distance_m,
            risk_level=risk,
        )
        return result, nearby_bridges


bridge_engine = BridgeEngine()

# ================== ORS helpers ==================


def ors_request(
    method: str,
    url: str,
    params: Optional[Dict[str, str]] = None,
    body: Optional[dict] = None,
) -> dict:
    """Generic ORS HTTP helper using Authorization header."""
    if not ORS_API_KEY:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    if params is None:
        params = {}

    if params:
        url = url + "?" + urllib.parse.urlencode(params)

    headers = {
        "Authorization": ORS_API_KEY,
    }
    data_bytes = None

    if body is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error calling ORS: {e}") from e


def geocode_postcode(postcode: str) -> Tuple[float, float]:
    """Geocode UK postcode → (lat, lon) using ORS."""
    text = f"{postcode}, UK"
    params = {
        "text": text,
        "boundary.country": "GBR",
        "size": 1,
    }
    data = ors_request("GET", ORS_GEOCODE_URL, params=params)
    features = data.get("features") or []
    if not features:
        raise HTTPException(status_code=400, detail=f"Could not geocode '{postcode}'")

    geom = features[0].get("geometry", {})
    coords = geom.get("coordinates")
    if not coords or len(coords) < 2:
        raise HTTPException(status_code=400, detail=f"Invalid geocode result for '{postcode}'")

    lon, lat = coords[0], coords[1]
    return lat, lon


def get_hgv_route(
    start_lat: float, start_lon: float, end_lat: float, end_lon: float
) -> Tuple[List[List[float]], float, float]:
    """
    Calls ORS HGV directions and returns:
    (coords_latlon_list, distance_km, duration_min)
    """
    body = {
        "coordinates": [
            [start_lon, start_lat],
            [end_lon, end_lat],
        ]
    }

    data = ors_request("POST", ORS_DIRECTIONS_URL, body=body)
    features = data.get("features") or []
    if not features:
        raise HTTPException(status_code=502, detail="No route returned from ORS")

    feat = features[0]
    props = feat.get("properties", {})
    segments = props.get("segments") or [{}]
    seg0 = segments[0]

    distance_m = float(seg0.get("distance", 0.0))
    duration_s = float(seg0.get("duration", 0.0))

    geom = feat.get("geometry", {})
    coords_raw = geom.get("coordinates") or []
    # ORS coords: [lon, lat] → convert to [lat, lon]
    coords_latlon = [[c[1], c[0]] for c in coords_raw]

    return coords_latlon, distance_m / 1000.0, duration_s / 60.0


# ================== Pydantic models ==================


class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


class RouteGeometry(BaseModel):
    coords: List[List[float]]  # [lat, lon]
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
    metrics: Dict[str, float]
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry] = None
    bridges: List[BridgeInfo]
    bridge_result: BridgeResultModel


# ================== FastAPI app ==================

app = FastAPI(title="RouteSafe Navigator API", version="1.0")

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
    # 1. Geocode
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    # 2. HGV route
    coords_latlon, distance_km, duration_min = get_hgv_route(
        start_lat, start_lon, end_lat, end_lon
    )

    # 3. Bridge scan (if enabled)
    bridges_for_map: List[BridgeInfo] = []
    if req.avoid_low_bridges:
        scan_result, nearby_bridges = bridge_engine.scan_route(
            coords_latlon, req.vehicle_height_m
        )

        for b in nearby_bridges:
            # Distance from route start – just for a simple display metric
            d = bridge_engine.haversine_m(
                coords_latlon[0][0], coords_latlon[0][1], b.lat, b.lon
            )
            bridges_for_map.append(
                BridgeInfo(
                    lat=b.lat,
                    lon=b.lon,
                    height_m=b.height_m,
                    distance_m=d,
                )
            )

        nearest_h = (
            scan_result.nearest_bridge.height_m
            if scan_result.nearest_bridge
            else None
        )
        nearest_d = scan_result.nearest_distance_m

        bridge_result_model = BridgeResultModel(
            has_conflict=scan_result.has_conflict,
            near_height_limit=scan_result.near_height_limit,
            nearest_bridge_height_m=nearest_h,
            nearest_bridge_distance_m=nearest_d,
            risk_level=scan_result.risk_level,
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
        coords=coords_latlon,
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
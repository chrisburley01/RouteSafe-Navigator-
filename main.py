from __future__ import annotations

import csv
import json
import math
import os
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict

import urllib.parse
import urllib.request

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ============================================================
# CONFIG
# ============================================================

ORS_API_KEY = os.getenv("ORS_API_KEY")
if not ORS_API_KEY:
    print("WARNING: ORS_API_KEY not set — routing will fail until configured.")

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"
EARTH_RADIUS_M = 6371000.0

ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search"
ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson"


# ============================================================
# BRIDGE ENGINE
# ============================================================

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
                        continue
            print(f"Loaded {len(self.bridges)} low bridges from {csv_path}")
        except FileNotFoundError:
            print(f"WARNING: {csv_path} not found — bridge checks disabled.")
            self.bridges = []

    @staticmethod
    def haversine_m(lat1, lon1, lat2, lon2):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1)
            * math.cos(phi2)
            * math.sin(dlambda / 2) ** 2
        )
        return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    def scan_route(
        self, coords: List[List[float]], vehicle_height_m: float
    ) -> Tuple[BridgeScanResult, List[Bridge]]:
        if not self.bridges or len(coords) < 2:
            return (
                BridgeScanResult(
                    has_conflict=False,
                    near_height_limit=False,
                    nearest_bridge=None,
                    nearest_distance_m=None,
                    risk_level="Low",
                ),
                [],
            )

        # Reduce computation by sampling along the route
        step = max(1, len(coords) // 80)
        sample_points = coords[::step]

        nearest_bridge = None
        nearest_distance_m = None
        has_conflict = False
        near_limit = False
        nearby: List[Bridge] = []

        for plat, plon in sample_points:
            for b in self.bridges:
                d = self.haversine_m(plat, plon, b.lat, b.lon)
                if d <= self.search_radius_m:
                    if b not in nearby:
                        nearby.append(b)

                    clearance = b.height_m - vehicle_height_m

                    if clearance < self.conflict_clearance_m:
                        has_conflict = True
                    elif clearance < self.near_clearance_m:
                        near_limit = True

                    if nearest_distance_m is None or d < nearest_distance_m:
                        nearest_distance_m = d
                        nearest_bridge = b

        if has_conflict:
            risk = "High"
        elif near_limit:
            risk = "Medium"
        else:
            risk = "Low"

        return (
            BridgeScanResult(
                has_conflict=has_conflict,
                near_height_limit=near_limit,
                nearest_bridge=nearest_bridge,
                nearest_distance_m=nearest_distance_m,
                risk_level=risk,
            ),
            nearby,
        )


bridge_engine = BridgeEngine()


# ============================================================
# ORS HELPERS
# ============================================================

def ors_request(method: str, url: str, params=None, body=None) -> dict:
    if not ORS_API_KEY:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    if params:
        url = url + "?" + urllib.parse.urlencode(params)

    headers = {"Authorization": ORS_API_KEY}
    data_bytes = None

    if body is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body).encode("utf-8")

    try:
        req = urllib.request.Request(
            url, data=data_bytes, headers=headers, method=method
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error calling ORS: {e}")


def geocode_postcode(pc: str) -> Tuple[float, float]:
    params = {
        "text": pc + ", UK",
        "boundary.country": "GBR",
        "size": 1,
    }
    data = ors_request("GET", ORS_GEOCODE_URL, params=params)
    feats = data.get("features") or []

    if not feats:
        raise HTTPException(status_code=400, detail=f"Could not geocode '{pc}'")

    lon, lat = feats[0]["geometry"]["coordinates"]
    return lat, lon


def get_hgv_route(start_lat, start_lon, end_lat, end_lon):
    body = {
        "coordinates": [
            [start_lon, start_lat],
            [end_lon, end_lat],
        ]
    }

    data = ors_request("POST", ORS_DIRECTIONS_URL, body=body)
    feats = data.get("features") or []
    if not feats:
        raise HTTPException(status_code=502, detail="ORS returned no route")

    feat = feats[0]
    seg = feat["properties"]["segments"][0]

    coords_raw = feat["geometry"]["coordinates"]
    coords_latlon = [[c[1], c[0]] for c in coords_raw]

    return coords_latlon, seg["distance"] / 1000, seg["duration"] / 60


# ============================================================
# ALTERNATIVE ROUTE ENGINE (avoid polygons)
# ============================================================

def get_hgv_route_avoiding_bridges(
    start_lat, start_lon, end_lat, end_lon, bridges: List[Bridge], buffer_m=150
):
    if not bridges:
        raise HTTPException(status_code=400, detail="No bridges to avoid")

    buffer_deg = buffer_m / 111_000.0  # (approx) metres → degrees

    multipoly = []
    for b in bridges:
        lat, lon = b.lat, b.lon
        ring = [
            [lon - buffer_deg, lat - buffer_deg],
            [lon + buffer_deg, lat - buffer_deg],
            [lon + buffer_deg, lat + buffer_deg],
            [lon - buffer_deg, lat + buffer_deg],
            [lon - buffer_deg, lat - buffer_deg],
        ]
        multipoly.append([ring])

    body = {
        "coordinates": [
            [start_lon, start_lat],
            [end_lon, end_lat],
        ],
        "options": {
            "avoid_polygons": {
                "type": "MultiPolygon",
                "coordinates": multipoly,
            }
        }
    }

    data = ors_request("POST", ORS_DIRECTIONS_URL, body=body)
    feats = data.get("features") or []
    if not feats:
        raise HTTPException(status_code=502, detail="ORS alt route failed")

    feat = feats[0]
    seg = feat["properties"]["segments"][0]

    coords_raw = feat["geometry"]["coordinates"]
    coords_latlon = [[c[1], c[0]] for c in coords_raw]

    return coords_latlon, seg["distance"] / 1000, seg["duration"] / 60


# ============================================================
# MODELS
# ============================================================

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
    nearest_bridge_height_m: Optional[float]
    nearest_bridge_distance_m: Optional[float]
    risk_level: str


class RouteResponse(BaseModel):
    metrics: Dict[str, float]
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry]
    bridges: List[BridgeInfo]
    bridge_result: BridgeResultModel


class RegScanResponse(BaseModel):
    reg: str
    confidence: float


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(title="RouteSafe Navigator API", version="1.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://routesafe-navigator.onrender.com",
        "http://localhost",
        "http://localhost:8000",
    ],
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


# ============================================================
# REG SCANNING ENDPOINT
# ============================================================

@app.post("/api/scan-reg", response_model=RegScanResponse)
async def scan_reg(image: UploadFile = File(...)):
    """
    TEMPORARY: stubbed ANPR for demo.
    When ready, replace with real OCR/ANPR service.
    """
    _ = await image.read()

    # Return a predictable plate for now
    detected = "YX71ABC"
    confidence = 0.95

    return RegScanResponse(reg=detected, confidence=confidence)


# ============================================================
# MAIN ROUTE ENDPOINT
# ============================================================

@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    # 1. Geocode
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    # 2. Base route
    base_coords, base_dist_km, base_dur_min = get_hgv_route(
        start_lat, start_lon, end_lat, end_lon
    )

    chosen_coords = base_coords
    chosen_dist = base_dist_km
    chosen_dur = base_dur_min

    alt_geom = None
    bridges_for_map: List[BridgeInfo] = []

    # 3. Bridge scan
    if req.avoid_low_bridges:
        scan_result, nearby_bridges = bridge_engine.scan_route(
            base_coords, req.vehicle_height_m
        )
    else:
        scan_result = BridgeScanResult(
            has_conflict=False, near_height_limit=False,
            nearest_bridge=None, nearest_distance_m=None,
            risk_level="Low",
        )
        nearby_bridges = []

    # 4. Alternative route attempt
    if req.avoid_low_bridges and scan_result.has_conflict and nearby_bridges:
        try:
            alt_coords, alt_dist, alt_dur = get_hgv_route_avoiding_bridges(
                start_lat, start_lon, end_lat, end_lon, nearby_bridges
            )
            alt_scan, alt_nearby = bridge_engine.scan_route(
                alt_coords, req.vehicle_height_m
            )

            # If alt safe → swap
            if not alt_scan.has_conflict:
                alt_geom = RouteGeometry(
                    coords=base_coords,
                    distance_km=base_dist_km,
                    duration_min=base_dur_min,
                )
                chosen_coords = alt_coords
                chosen_dist = alt_dist
                chosen_dur = alt_dur
                scan_result = alt_scan
                nearby_bridges = alt_nearby
            else:
                # alt still risky → show it as purple
                alt_geom = RouteGeometry(
                    coords=alt_coords,
                    distance_km=alt_dist,
                    duration_min=alt_dur,
                )

        except HTTPException as e:
            print("No alternative route found:", e.detail)

    # 5. Bridge markers
    for b in nearby_bridges:
        d = bridge_engine.haversine_m(
            chosen_coords[0][0], chosen_coords[0][1], b.lat, b.lon
        )
        bridges_for_map.append(
            BridgeInfo(lat=b.lat, lon=b.lon, height_m=b.height_m, distance_m=d)
        )

    # 6. Build response
    main_geom = RouteGeometry(
        coords=chosen_coords,
        distance_km=chosen_dist,
        duration_min=chosen_dur,
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

    metrics = {"distance_km": chosen_dist, "duration_min": chosen_dur}

    return RouteResponse(
        metrics=metrics,
        main_route=main_geom,
        alt_route=alt_geom,
        bridges=bridges_for_map,
        bridge_result=bridge_result_model,
    )
from __future__ import annotations

import csv
import json
import math
import os
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict

import requests
import urllib.parse
import urllib.request

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ============================================================
# CONFIG
# ============================================================

ORS_API_KEY = os.getenv("ORS_API_KEY")
DVLA_API_KEY = os.getenv("DVLA_API_KEY")

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"
EARTH_RADIUS_M = 6371000.0

ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search"
ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson"

DVLA_API_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles"


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
            print(f"Loaded {len(self.bridges)} bridges.")
        except FileNotFoundError:
            print("WARNING: Bridge CSV not found — no bridge risks loaded.")

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

        step = max(1, len(coords) // 80)
        points = coords[::step]

        nearest_bridge = None
        nearest_distance = None
        has_conflict = False
        near_limit = False
        nearby: List[Bridge] = []

        for lat, lon in points:
            for b in self.bridges:
                d = self.haversine_m(lat, lon, b.lat, b.lon)
                if d <= self.search_radius_m:
                    if b not in nearby:
                        nearby.append(b)

                    clearance = b.height_m - vehicle_height_m
                    if clearance < self.conflict_clearance_m:
                        has_conflict = True
                    elif clearance < self.near_clearance_m:
                        near_limit = True

                    if nearest_distance is None or d < nearest_distance:
                        nearest_distance = d
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
                nearest_distance_m=nearest_distance,
                risk_level=risk,
            ),
            nearby,
        )


bridge_engine = BridgeEngine()


# ============================================================
# HELPERS: ORS request + geocode
# ============================================================

def ors_request(method: str, url: str, params=None, body=None) -> dict:
    if not ORS_API_KEY:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    if params:
        url += "?" + urllib.parse.urlencode(params)

    headers = {"Authorization": ORS_API_KEY}
    data_bytes = None

    if body is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body).encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error calling ORS: {e}")


def geocode_postcode(pc: str) -> Tuple[float, float]:
    params = {"text": pc + ", UK", "boundary.country": "GBR", "size": 1}
    data = ors_request("GET", ORS_GEOCODE_URL, params=params)
    features = data.get("features") or []
    if not features:
        raise HTTPException(status_code=400, detail=f"Could not geocode '{pc}'")
    lon, lat = features[0]["geometry"]["coordinates"]
    return lat, lon


# ============================================================
# DVLA LOOKUP
# ============================================================

def normalise_reg(reg: str) -> str:
    return reg.replace(" ", "").upper()


class VehicleProfile(BaseModel):
    reg: str
    make: Optional[str] = None
    colour: Optional[str] = None
    revenue_weight_kg: Optional[int] = None
    gross_weight_t: Optional[float] = None
    wheelplan: Optional[str] = None
    type_approval: Optional[str] = None
    inferred_class: Optional[str] = None
    is_dvla: bool = False


def map_dvla_to_profile(reg_norm: str, data: dict) -> VehicleProfile:
    revenue_weight = data.get("revenueWeight")
    wheelplan = data.get("wheelplan")
    type_approval = data.get("typeApproval")

    inferred = None
    if revenue_weight:
        if revenue_weight >= 7500:
            inferred = "hgv"
        elif revenue_weight >= 3500:
            inferred = "lgv"
        else:
            inferred = "car/van"

    gross_t = revenue_weight / 1000 if revenue_weight else None

    return VehicleProfile(
        reg=reg_norm,
        make=data.get("make"),
        colour=data.get("colour"),
        revenue_weight_kg=revenue_weight,
        gross_weight_t=gross_t,
        wheelplan=wheelplan,
        type_approval=type_approval,
        inferred_class=inferred,
        is_dvla=True,
    )


# ============================================================
# ROUTE MODELS
# ============================================================

class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True
    vehicle_reg: Optional[str] = None
    gross_weight_kg: Optional[int] = None  # NEW for weight routing


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

app = FastAPI(title="RouteSafe Navigator API", version="1.4")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
# REG SCAN (Stub)
# ============================================================

@app.post("/api/scan-reg", response_model=RegScanResponse)
async def scan_reg(image: UploadFile = File(...)):
    # Stub: replace with actual ANPR model
    _ = await image.read()
    return RegScanResponse(reg="YX71ABC", confidence=0.95)


# ============================================================
# DVLA PROFILE ENDPOINT
# ============================================================

@app.get("/api/vehicle-profile/{reg}", response_model=VehicleProfile)
def get_vehicle_profile(reg: str):
    reg_norm = normalise_reg(reg)

    if not DVLA_API_KEY:
        raise HTTPException(status_code=503, detail="DVLA API key not configured")

    try:
        resp = requests.post(
            DVLA_API_URL,
            headers={
                "x-api-key": DVLA_API_KEY,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={"registrationNumber": reg_norm},
            timeout=5,
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Error contacting DVLA: {e}")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    if resp.status_code == 400:
        raise HTTPException(status_code=400, detail="Bad registration number")

    if resp.status_code >= 500:
        raise HTTPException(status_code=503, detail="DVLA service error")

    data = resp.json()
    return map_dvla_to_profile(reg_norm, data)


# ============================================================
# ORS ROUTING WITH VEHICLE PARAMETERS
# ============================================================

def build_vehicle_params(height_m: float, gross_weight_kg: Optional[int]) -> dict:
    params = {}

    # Height → mm
    if height_m:
        params["height"] = int(height_m * 1000)

    # Weight + axle load
    if gross_weight_kg:
        params["weight"] = gross_weight_kg
        params["axleload"] = int(gross_weight_kg / 4)

    # Standard artic size
    params["length"] = 13600  # mm
    params["width"] = 2550    # mm

    return params


def get_hgv_route(start_lat, start_lon, end_lat, end_lon, vehicle_params):
    body = {
        "coordinates": [[start_lon, start_lat], [end_lon, end_lat]],
        "vehicle_type": "heavyvehicle",
        "vehicle_parameters": vehicle_params,
    }
    data = ors_request("POST", ORS_DIRECTIONS_URL, body=body)

    feats = data.get("features") or []
    if not feats:
        raise HTTPException(status_code=502, detail="ORS returned no routes")

    feat = feats[0]
    seg = feat["properties"]["segments"][0]

    coords = feat["geometry"]["coordinates"]
    latlon = [[c[1], c[0]] for c in coords]

    return latlon, seg["distance"] / 1000, seg["duration"] / 60


def get_hgv_route_avoiding_bridges(start_lat, start_lon, end_lat, end_lon, bridges, veh_params, buffer_m=150):
    if not bridges:
        raise HTTPException(status_code=400, detail="No bridges to avoid")

    buffer_deg = buffer_m / 111_000.0

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
        "coordinates": [[start_lon, start_lat], [end_lon, end_lat]],
        "vehicle_type": "heavyvehicle",
        "vehicle_parameters": veh_params,
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

    coords = feat["geometry"]["coordinates"]
    latlon = [[c[1], c[0]] for c in coords]

    return latlon, seg["distance"] / 1000, seg["duration"] / 60


# ============================================================
# MAIN ROUTE ENDPOINT
# ============================================================

@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):

    # ----------------------------------------------------------
    # Geocoding
    # ----------------------------------------------------------
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    # ----------------------------------------------------------
    # VEHICLE WEIGHT (DVLA overrides user)
    # ----------------------------------------------------------
    gross_weight_kg = req.gross_weight_kg

    if req.vehicle_reg:
        try:
            profile = get_vehicle_profile(req.vehicle_reg)
            if profile and profile.revenue_weight_kg:
                gross_weight_kg = profile.revenue_weight_kg
        except Exception:
            pass  # DVLA errors should not break routing

    # ----------------------------------------------------------
    # Vehicle parameters for ORS
    # ----------------------------------------------------------
    vehicle_params = build_vehicle_params(req.vehicle_height_m, gross_weight_kg)

    # ----------------------------------------------------------
    # BASE ROUTE
    # ----------------------------------------------------------
    base_coords, base_dist, base_dur = get_hgv_route(
        start_lat, start_lon, end_lat, end_lon, vehicle_params
    )

    chosen_coords = base_coords
    chosen_dist = base_dist
    chosen_dur = base_dur

    alt_geom = None
    bridges_for_map: List[BridgeInfo] = []

    # ----------------------------------------------------------
    # BRIDGE SCAN
    # ----------------------------------------------------------
    if req.avoid_low_bridges:
        scan_result, nearby_bridges = bridge_engine.scan_route(
            base_coords, req.vehicle_height_m
        )
    else:
        scan_result = BridgeScanResult(
            has_conflict=False, near_height_limit=False,
            nearest_bridge=None, nearest_distance_m=None,
            risk_level="Low"
        )
        nearby_bridges = []

    # ----------------------------------------------------------
    # ALTERNATIVE ROUTE
    # ----------------------------------------------------------
    if req.avoid_low_bridges and scan_result.has_conflict and nearby_bridges:
        try:
            alt_coords, alt_dist, alt_dur = get_hgv_route_avoiding_bridges(
                start_lat, start_lon, end_lat, end_lon, nearby_bridges, vehicle_params
            )

            alt_scan, alt_nearby = bridge_engine.scan_route(
                alt_coords, req.vehicle_height_m
            )

            if not alt_scan.has_conflict:
                alt_geom = RouteGeometry(
                    coords=base_coords,
                    distance_km=base_dist,
                    duration_min=base_dur
                )
                chosen_coords = alt_coords
                chosen_dist = alt_dist
                chosen_dur = alt_dur
                scan_result = alt_scan
                nearby_bridges = alt_nearby
            else:
                alt_geom = RouteGeometry(
                    coords=alt_coords,
                    distance_km=alt_dist,
                    duration_min=alt_dur
                )

        except HTTPException:
            pass

    # ----------------------------------------------------------
    # BRIDGE MARKERS FOR MAP
    # ----------------------------------------------------------
    for b in nearby_bridges:
        d = bridge_engine.haversine_m(
            chosen_coords[0][0], chosen_coords[0][1], b.lat, b.lon
        )
        bridges_for_map.append(
            BridgeInfo(lat=b.lat, lon=b.lon, height_m=b.height_m, distance_m=d)
        )

    # ----------------------------------------------------------
    # BUILD RESPONSE
    # ----------------------------------------------------------
    main_geom = RouteGeometry(
        coords=chosen_coords, distance_km=chosen_dist, duration_min=chosen_dur
    )

    nearest_h = scan_result.nearest_bridge.height_m if scan_result.nearest_bridge else None
    nearest_d = scan_result.nearest_distance_m

    bridge_info = BridgeResultModel(
        has_conflict=scan_result.has_conflict,
        near_height_limit=scan_result.near_height_limit,
        nearest_bridge_height_m=nearest_h,
        nearest_bridge_distance_m=nearest_d,
        risk_level=scan_result.risk_level,
    )

    return RouteResponse(
        metrics={"distance_km": chosen_dist, "duration_min": chosen_dur},
        main_route=main_geom,
        alt_route=alt_geom,
        bridges=bridges_for_map,
        bridge_result=bridge_info,
    )
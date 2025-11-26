import os
import math
from typing import List, Optional, Tuple

import openrouteservice
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from bridge_engine import BridgeEngine, Bridge, BridgeCheckResult


# ================= FastAPI app =================

app = FastAPI(title="RouteSafe Navigator API", version="1.1")

app.add_middleware(
    CORSMiddleware,
    # Frontend is on a different Render service, so allow all
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


# ================= ORS helpers =================

_ors_client: Optional[openrouteservice.Client] = None


def get_ors_client() -> openrouteservice.Client:
    global _ors_client
    if _ors_client is None:
        api_key = os.getenv("ORS_API_KEY")
        if not api_key:
            raise RuntimeError("ORS_API_KEY environment variable is not set")
        _ors_client = openrouteservice.Client(key=api_key)
    return _ors_client


def geocode_postcode(postcode: str) -> Tuple[float, float]:
    """
    Geocode a UK postcode to (lat, lon) via ORS Pelias.
    """
    client = get_ors_client()
    res = client.pelias_search(text=postcode, size=1)
    features = res.get("features")
    if not features:
        raise HTTPException(
            status_code=400,
            detail=f"Could not geocode postcode '{postcode}'",
        )
    coords = features[0]["geometry"]["coordinates"]  # [lon, lat]
    lon, lat = coords[0], coords[1]
    return lat, lon


# ================= Bridge engine helper =================

_bridge_engine: Optional[BridgeEngine] = None


def get_bridge_engine() -> BridgeEngine:
    global _bridge_engine
    if _bridge_engine is None:
        # bridge_engine already knows how to find the CSV by default
        _bridge_engine = BridgeEngine()
    return _bridge_engine


# ================= Pydantic models =================


class RouteRequest(BaseModel):
    start_postcode: str = Field(..., example="LS27 0BN")
    dest_postcode: str = Field(..., example="HD5 0RL")
    vehicle_height_m: float = Field(..., gt=0, example=4.5)
    avoid_low_bridges: bool = True
    vehicle_reg: Optional[str] = Field(None, example="YX71 OXC")


class RouteGeometry(BaseModel):
    # List of [lon, lat]
    coords: List[List[float]]


class BridgeInfo(BaseModel):
    lat: float
    lon: float
    height_m: float
    distance_m: float


class RouteMetrics(BaseModel):
    distance_km: float
    duration_min: float
    bridge_risk: str
    nearest_bridge_height_m: Optional[float] = None
    nearest_bridge_distance_m: Optional[float] = None


class RouteResponse(BaseModel):
    metrics: RouteMetrics
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry] = None
    low_bridges: List[BridgeInfo] = []


# ================= DVLA vehicle lookup models =================


class VehicleLookupRequest(BaseModel):
    """Request body for DVLA lookup."""
    registration: str = Field(..., example="YX71OXC")


class VehicleDetails(BaseModel):
    """Subset of useful DVLA fields plus the raw payload."""
    registration: str
    make: Optional[str] = None
    colour: Optional[str] = None
    body_type: Optional[str] = None
    wheelplan: Optional[str] = None
    tax_status: Optional[str] = None
    mot_status: Optional[str] = None
    revenue_weight_kg: Optional[int] = None
    gross_weight_kg: Optional[int] = None
    raw: dict


# ================= DVLA helper =================


def lookup_vehicle_via_dvla(registration: str) -> Optional[dict]:
    """
    Calls the DVLA Vehicle Enquiry Service.

    Returns the parsed JSON dict if successful, otherwise None.
    """
    api_key = os.getenv("DVLA_API_KEY")
    if not api_key:
        # If key not configured, just quietly skip
        return None

    url = os.getenv(
        "DVLA_API_URL",
        "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
    )

    payload = {"registrationNumber": registration.replace(" ", "").upper()}

    try:
        resp = requests.post(
            url,
            headers={
                "x-api-key": api_key,
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=5,
        )
    except Exception:
        return None

    if resp.status_code != 200:
        return None

    try:
        return resp.json()
    except Exception:
        return None


@app.post("/api/vehicle", response_model=VehicleDetails)
def get_vehicle_details(req: VehicleLookupRequest):
    """
    Look up basic vehicle details from DVLA by registration.

    (Does NOT affect routing if DVLA is unavailable.)
    """
    data = lookup_vehicle_via_dvla(req.registration)
    if data is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "DVLA lookup unavailable "
                "(API key not set, vehicle not found, or DVLA unreachable)."
            ),
        )

    return VehicleDetails(
        registration=data.get("registrationNumber", req.registration.upper()),
        make=data.get("make"),
        colour=data.get("colour"),
        body_type=data.get("bodyType"),
        wheelplan=data.get("wheelplan"),
        tax_status=data.get("taxStatus"),
        mot_status=data.get("motStatus"),
        revenue_weight_kg=data.get("revenueWeight"),
        gross_weight_kg=data.get("grossWeight"),
        raw=data,
    )


# ================= Routing core =================


def analyse_bridges_along_route(
    coords: List[List[float]],
    vehicle_height_m: float,
) -> Tuple[str, Optional[Bridge], Optional[float], List[BridgeInfo]]:
    """
    Walk along the route polyline and use BridgeEngine to find
    nearest low bridge and overall risk.
    """
    engine = get_bridge_engine()

    # down-sample to at most ~100 segments
    step = max(1, len(coords) // 100)
    sample_points = coords[::step]
    if sample_points[-1] is not coords[-1]:
        sample_points.append(coords[-1])

    best_bridge: Optional[Bridge] = None
    best_distance: Optional[float] = None
    low_bridges: List[BridgeInfo] = []
    risk_level = "None"

    for i in range(len(sample_points) - 1):
        lon1, lat1 = sample_points[i]
        lon2, lat2 = sample_points[i + 1]

        result: BridgeCheckResult = engine.check_leg_for_bridges(
            (lat1, lon1),
            (lat2, lon2),
            vehicle_height_m=vehicle_height_m,
        )

        if result.nearest_bridge is not None and result.nearest_distance_m is not None:
            low_bridges.append(
                BridgeInfo(
                    lat=result.nearest_bridge.lat,
                    lon=result.nearest_bridge.lon,
                    height_m=result.nearest_bridge.height_m,
                    distance_m=result.nearest_distance_m,
                )
            )

            if best_distance is None or result.nearest_distance_m < best_distance:
                best_distance = result.nearest_distance_m
                best_bridge = result.nearest_bridge

        if result.has_conflict:
            risk_level = "Conflict"
        elif result.near_height_limit and risk_level != "Conflict":
            risk_level = "Near"

    return risk_level, best_bridge, best_distance, low_bridges


def make_avoid_polygon(lat: float, lon: float, radius_m: float = 250.0) -> dict:
    """
    Build a small circular-ish polygon around a bridge to tell ORS to avoid.
    """
    # rough metres-per-degree
    lat_rad = math.radians(lat)
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(lat_rad)

    dlat = radius_m / m_per_deg_lat
    dlon = radius_m / m_per_deg_lon

    ring = []
    for angle_deg in range(0, 360, 45):
        ang = math.radians(angle_deg)
        ring.append(
            [
                lon + dlon * math.cos(ang),
                lat + dlat * math.sin(ang),
            ]
        )
    # close polygon
    ring.append(ring[0])

    return {
        "type": "Polygon",
        "coordinates": [ring],
    }


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    """
    Plan a route between two postcodes for a given vehicle height.
    """
    client = get_ors_client()

    # 1. Geocode postcodes
    start_lat, start_lon = geocode_postcode(req.start_postcode)
    end_lat, end_lon = geocode_postcode(req.dest_postcode)

    coords = [(start_lon, start_lat), (end_lon, end_lat)]

    # 2. Get main HGV route from ORS
    try:
        route = client.directions(
            coordinates=coords,
            profile="driving-hgv",
            format="geojson",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting route from ORS: {e}")

    feat = route["features"][0]
    geom = feat["geometry"]["coordinates"]  # list of [lon, lat]

    props = feat.get("properties", {})
    summary = props.get("summary", {})
    distance_km = float(summary.get("distance", 0.0)) / 1000.0
    duration_min = float(summary.get("duration", 0.0)) / 60.0

    # 3. Bridge analysis
    risk_level, best_bridge, best_distance, low_bridges = analyse_bridges_along_route(
        geom,
        vehicle_height_m=req.vehicle_height_m,
    )

    nearest_height = best_bridge.height_m if best_bridge else None
    nearest_distance = best_distance

    main_geom = RouteGeometry(coords=geom)

    # 4. If conflict & avoid_low_bridges, ask ORS for alternative avoiding that bridge
    alt_geom: Optional[RouteGeometry] = None
    if req.avoid_low_bridges and risk_level == "Conflict" and best_bridge is not None:
        avoid_poly = make_avoid_polygon(best_bridge.lat, best_bridge.lon)

        try:
            alt_route = client.directions(
                coordinates=coords,
                profile="driving-hgv",
                format="geojson",
                options={"avoid_polygons": avoid_poly},
            )
            alt_feat = alt_route["features"][0]
            alt_geom_coords = alt_feat["geometry"]["coordinates"]
            alt_geom = RouteGeometry(coords=alt_geom_coords)
        except Exception:
            # If alt fetch fails, we still return main route
            alt_geom = None

    metrics = RouteMetrics(
        distance_km=distance_km,
        duration_min=duration_min,
        bridge_risk=risk_level,
        nearest_bridge_height_m=nearest_height,
        nearest_bridge_distance_m=nearest_distance,
    )

    return RouteResponse(
        metrics=metrics,
        main_route=main_geom,
        alt_route=alt_geom,
        low_bridges=low_bridges,
    )

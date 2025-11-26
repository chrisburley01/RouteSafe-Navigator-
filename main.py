# main.py
#
# RouteSafe Navigator API
# - HGV routing via OpenRouteService
# - Low-bridge checking using UK bridge CSV
# - Optional alternative route that avoids the nearest low bridge

import os
import math
from typing import List, Optional, Tuple, Dict

import pandas as pd
import openrouteservice
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# ========= Config =========

BRIDGE_CSV_PATH = "bridge_heights_clean.csv"
EARTH_RADIUS_M = 6371000.0  # metres
BRIDGE_SEARCH_RADIUS_M = 300.0  # how far from route we look for bridges
NEAR_CLEARANCE_M = 0.25        # within 25cm of vehicle height = "near limit"


# ========= Helpers =========

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in metres."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(
        dlambda / 2
    ) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_M * c


def load_bridge_data(csv_path: str) -> pd.DataFrame:
    if not os.path.exists(csv_path):
        raise RuntimeError(f"Bridge CSV not found at {csv_path}")
    df = pd.read_csv(csv_path)
    # Expect columns: lat, lon, height_m
    for col in ("lat", "lon", "height_m"):
        if col not in df.columns:
            raise RuntimeError(f"Bridge CSV missing '{col}' column")
    return df


def get_ors_client() -> openrouteservice.Client:
    api_key = os.getenv("ORS_API_KEY")
    if not api_key:
        raise RuntimeError("ORS_API_KEY environment variable not set")
    return openrouteservice.Client(key=api_key)


def geocode_postcode(client: openrouteservice.Client, text: str) -> Tuple[float, float]:
    """Geocode postcode to (lat, lon) using ORS Pelias search."""
    try:
        res = client.pelias_search(text=text, size=1)
        features = res.get("features", [])
        if not features:
            raise ValueError(f"No geocode result for '{text}'")
        coords = features[0]["geometry"]["coordinates"]  # [lon, lat]
        lon, lat = coords[0], coords[1]
        return lat, lon
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Error geocoding postcode '{text}': {e}"
        )


def get_hgv_route(
    client: openrouteservice.Client,
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
    avoid_polygon: Optional[Dict] = None,
) -> Tuple[List[List[float]], float, float]:
    """
    Call ORS directions (driving-hgv) and return:
      coords: [[lon, lat], ...]
      distance_km
      duration_min
    """
    coordinates = [(start_lon, start_lat), (end_lon, end_lat)]

    kwargs: Dict = {}
    if avoid_polygon is not None:
        kwargs["options"] = {"avoid_polygons": avoid_polygon}

    try:
        route = client.directions(
            coordinates=coordinates,
            profile="driving-hgv",
            format="geojson",
            **kwargs,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting route from ORS: {e}")

    try:
        feat = route["features"][0]
        geom_coords = feat["geometry"]["coordinates"]  # [ [lon, lat], ... ]
        seg = feat["properties"]["segments"][0]
        distance_km = seg["distance"] / 1000.0
        duration_min = seg["duration"] / 60.0
        return geom_coords, distance_km, duration_min
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error parsing ORS route response: {e}"
        )


def make_avoid_polygon(lat: float, lon: float, radius_m: float = 250.0) -> Dict:
    """
    Build a simple square polygon ~radius_m around a point for ORS avoid_polygons.
    """
    # Rough conversion: 1 degree ~ 111_000 m
    ddeg = radius_m / 111_000.0
    # Square around (lon, lat)
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [lon - ddeg, lat - ddeg],
                [lon + ddeg, lat - ddeg],
                [lon + ddeg, lat + ddeg],
                [lon - ddeg, lat + ddeg],
                [lon - ddeg, lat - ddeg],
            ]
        ],
    }


# ========= Pydantic models =========

class RouteRequest(BaseModel):
    start_postcode: str
    dest_postcode: str
    vehicle_height_m: float = Field(gt=0, description="Vehicle height in metres")
    avoid_low_bridges: bool = True
    vehicle_reg: Optional[str] = Field(
        default=None,
        description="Optional vehicle registration (currently unused, for future DVLA integration)",
    )


class RouteGeometry(BaseModel):
    coords: List[List[float]]  # [ [lon, lat], ... ]


class BridgeInfo(BaseModel):
    lat: float
    lon: float
    height_m: float
    distance_m: float


class BridgeResultModel(BaseModel):
    risk_level: str  # "Low", "Near limit", "Conflict", "Unknown"
    nearest_bridge: Optional[BridgeInfo] = None


class RouteMetrics(BaseModel):
    distance_km: float
    duration_min: float


class RouteResponse(BaseModel):
    metrics: RouteMetrics
    main_route: RouteGeometry
    alt_route: Optional[RouteGeometry] = None
    bridge_result: BridgeResultModel


# ========= FastAPI app setup =========

app = FastAPI(
    title="RouteSafe Navigator API",
    version="1.1",
    description="HGV routing with low-bridge checking for RouteSafe Navigator.",
)

# CORS – allow browser frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can restrict this to your domain later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load bridge data once at startup
try:
    BRIDGE_DF = load_bridge_data(BRIDGE_CSV_PATH)
except Exception as e:
    # We don't crash app init; but route calls will fail with a clear error.
    BRIDGE_DF = None
    print(f"WARNING: could not load bridge CSV: {e}")


# ========= Bridge analysis =========

def analyse_route_for_bridges(
    coords: List[List[float]], vehicle_height_m: float
) -> BridgeResultModel:
    """
    Scan route polyline for nearby low bridges.

    coords: [ [lon, lat], ... ]
    """
    if BRIDGE_DF is None or BRIDGE_DF.empty:
        return BridgeResultModel(risk_level="Unknown", nearest_bridge=None)

    # Sample to keep it cheap
    step = max(1, len(coords) // 120)  # at most ~120 samples
    sample_points = coords[::step]

    nearest_conflict: Optional[BridgeInfo] = None
    nearest_near_limit: Optional[BridgeInfo] = None

    for lon, lat in sample_points:
        for _, row in BRIDGE_DF.iterrows():
            b_lat = float(row["lat"])
            b_lon = float(row["lon"])
            b_h = float(row["height_m"])

            dist_m = haversine_m(lat, lon, b_lat, b_lon)
            if dist_m > BRIDGE_SEARCH_RADIUS_M:
                continue

            clearance = b_h - vehicle_height_m

            info = BridgeInfo(
                lat=b_lat,
                lon=b_lon,
                height_m=b_h,
                distance_m=dist_m,
            )

            if clearance < 0:  # vehicle too tall for this bridge
                if (nearest_conflict is None) or (dist_m < nearest_conflict.distance_m):
                    nearest_conflict = info
            elif clearance <= NEAR_CLEARANCE_M:
                if (nearest_near_limit is None) or (
                    dist_m < nearest_near_limit.distance_m
                ):
                    nearest_near_limit = info

    if nearest_conflict is not None:
        return BridgeResultModel(risk_level="Conflict", nearest_bridge=nearest_conflict)
    if nearest_near_limit is not None:
        return BridgeResultModel(
            risk_level="Near limit", nearest_bridge=nearest_near_limit
        )
    return BridgeResultModel(risk_level="Low", nearest_bridge=None)


# ========= Endpoints =========

@app.get("/")
def root():
    return {"message": "RouteSafe Navigator API"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/route", response_model=RouteResponse)
def plan_route(req: RouteRequest):
    # ORS client (checks ORS_API_KEY)
    try:
        client = get_ors_client()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Geocode postcodes
    start_lat, start_lon = geocode_postcode(client, req.start_postcode)
    end_lat, end_lon = geocode_postcode(client, req.dest_postcode)

    # Main route
    main_coords, main_dist_km, main_dur_min = get_hgv_route(
        client, start_lat, start_lon, end_lat, end_lon
    )

    bridge_result = analyse_route_for_bridges(main_coords, req.vehicle_height_m)

    alt_geom: Optional[RouteGeometry] = None

    # If we have a bridge conflict and user wants to avoid low bridges,
    # try to get an alternative that avoids a small polygon around the bridge.
    if req.avoid_low_bridges and bridge_result.risk_level == "Conflict":
        b = bridge_result.nearest_bridge
        if b is not None:
            avoid_poly = make_avoid_polygon(lat=b.lat, lon=b.lon, radius_m=250.0)
            try:
                alt_coords, alt_dist_km, alt_dur_min = get_hgv_route(
                    client,
                    start_lat,
                    start_lon,
                    end_lat,
                    end_lon,
                    avoid_polygon=avoid_poly,
                )
                alt_geom = RouteGeometry(coords=alt_coords)

                # If alt route is successfully computed, we re-assess bridge risk
                # on the alternative path and return that risk instead.
                alt_bridge_result = analyse_route_for_bridges(
                    alt_coords, req.vehicle_height_m
                )

                # Prefer the safer route's risk display
                if alt_bridge_result.risk_level in ("Low", "Near limit"):
                    bridge_result = alt_bridge_result

            except HTTPException:
                # Bubble up ORS errors for alt route as 500
                raise
            except Exception as e:
                # If alt routing fails, we still return the main route + conflict info
                print(f"Warning: could not get alt route: {e}")

    resp = RouteResponse(
        metrics=RouteMetrics(
            distance_km=main_dist_km,
            duration_min=main_dur_min,
        ),
        main_route=RouteGeometry(coords=main_coords),
        alt_route=alt_geom,
        bridge_result=bridge_result,
    )
    return resp

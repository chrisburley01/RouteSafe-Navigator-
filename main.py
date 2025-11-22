from pathlib import Path
from typing import Optional, List, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="RouteSafe Navigator API")

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Static files / SPA routes ---

assets_dir = BASE_DIR / "assets"
assets_dir.mkdir(exist_ok=True)

@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    index_path = BASE_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return FileResponse(index_path)


@app.get("/style.css", include_in_schema=False)
async def serve_css() -> FileResponse:
    css_path = BASE_DIR / "style.css"
    if not css_path.exists():
        raise HTTPException(status_code=404, detail="style.css not found")
    return FileResponse(css_path)


@app.get("/main.js", include_in_schema=False)
async def serve_js() -> FileResponse:
    js_path = BASE_DIR / "main.js"
    if not js_path.exists():
        raise HTTPException(status_code=404, detail="main.js not found")
    return FileResponse(js_path)


app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


# --- API models ---

class RouteRequest(BaseModel):
    start: str
    end: str
    vehicle_height_m: float
    avoid_low_bridges: bool = True


class BridgeRisk(BaseModel):
    level: Literal["low", "medium", "high"]
    status_text: str
    nearest_bridge_height_m: Optional[float] = None
    nearest_bridge_distance_m: Optional[float] = None


class WarningItem(BaseModel):
    level: Literal["low", "medium", "high"] = "low"
    message: str


class StepItem(BaseModel):
    instruction: str


class LineString(BaseModel):
    type: Literal["LineString"] = "LineString"
    coordinates: List[List[float]]  # [lon, lat]


class BridgeMarker(BaseModel):
    lat: float
    lon: float
    height_m: Optional[float] = None
    risk_level: Literal["low", "medium", "high"] = "low"
    message: Optional[str] = None


class RouteSummary(BaseModel):
    distance_km: float
    duration_min: float


class RouteResponse(BaseModel):
    summary: RouteSummary
    distance_km: float
    duration_min: float
    bridge_risk: BridgeRisk
    warnings: List[WarningItem] = []
    steps: List[StepItem] = []
    geometry: Optional[LineString] = None
    alt_geometry: Optional[LineString] = None
    bridge_markers: List[BridgeMarker] = []


# --- API endpoint ---

@app.post("/api/route", response_model=RouteResponse)
async def api_route(req: RouteRequest) -> RouteResponse:
    if req.vehicle_height_m <= 0:
        raise HTTPException(status_code=400, detail="Vehicle height must be > 0")

    # For now return demo; we’ll plug real ORS+BridgeEngine later.
    return build_demo_route(req.start, req.end, req.vehicle_height_m)


# --- Demo route (matches frontend expectations) ---

def build_demo_route(start: str, end: str, vehicle_height_m: float) -> RouteResponse:
    high_risk = vehicle_height_m > 4.8

    demo_line = LineString(
        coordinates=[
            [-1.602, 53.758],
            [-1.55, 53.75],
            [-1.48, 53.74],
            [-1.35, 53.73],
            [-2.25, 53.48],
        ]
    )

    alt_line: Optional[LineString] = None
    if high_risk:
        alt_line = LineString(
            coordinates=[
                [-1.602, 53.758],
                [-1.62, 53.72],
                [-1.7, 53.68],
                [-1.9, 53.58],
                [-2.25, 53.48],
            ]
        )

    bridge_markers: List[BridgeMarker] = []
    warnings: List[WarningItem] = []

    if high_risk:
        bridge_markers.append(
            BridgeMarker(
                lat=53.74,
                lon=-1.5,
                height_m=4.6,
                risk_level="high",
                message="Low bridge 4.6 m – main route diverted.",
            )
        )
        warnings.append(
            WarningItem(
                level="high",
                message="Low bridge (4.6 m) detected near Morley; main route diverted.",
            )
        )

    bridge_risk = BridgeRisk(
        level="high" if high_risk else "low",
        status_text=(
            "Low bridge on direct path; alternative offered."
            if high_risk
            else "No conflicts detected for this height."
        ),
        nearest_bridge_height_m=4.6 if high_risk else 5.2,
        nearest_bridge_distance_m=130.0,
    )

    summary = RouteSummary(distance_km=27.3, duration_min=42.0)

    steps = [
        StepItem(instruction=f"Start at {start}"),
        StepItem(instruction="Head towards M62 via A650."),
        StepItem(
            instruction=(
                "Follow HGV diversion avoiding low bridge near Morley."
                if high_risk
                else "Follow primary route through Morley."
            )
        ),
        StepItem(instruction=f"Arrive at {end}."),
    ]

    return RouteResponse(
        summary=summary,
        distance_km=summary.distance_km,
        duration_min=summary.duration_min,
        bridge_risk=bridge_risk,
        warnings=warnings,
        steps=steps,
        geometry=demo_line,
        alt_geometry=alt_line,
        bridge_markers=bridge_markers,
    )
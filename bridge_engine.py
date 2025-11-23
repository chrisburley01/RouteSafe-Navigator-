# bridge_engine.py
#
# Uses cleaned UK low bridge data (lat, lon, height_m)
# to check a route leg for height conflicts.

from dataclasses import dataclass
from typing import Optional
import math

import pandas as pd


EARTH_RADIUS_M = 6371000.0  # metres


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


class BridgeEngine:
    """
    Loads low-bridge data and checks route legs for conflicts.

    Accepts either:
      - CSV file with columns: lat, lon, height_m
      - or XLSX Excel file with the same columns

    This makes it tolerant to how the file was saved.
    """

    def __init__(
        self,
        csv_path: str = "bridge_heights_clean.csv",
        search_radius_m: float = 300.0,
        conflict_clearance_m: float = 0.0,
        near_clearance_m: float = 0.25,
    ):
        # Robust load: try CSV, then Excel, then latin1 CSV
        try:
            # Normal UTF-8 CSV
            self.df = pd.read_csv(csv_path)
        except (UnicodeDecodeError, pd.errors.ParserError, OSError):
            try:
                # Many "csv" uploads are actually .xlsx files
                self.df = pd.read_excel(csv_path)
            except Exception:
                # Last resort: try latin1 CSV
                self.df = pd.read_csv(csv_path, encoding="latin1")

        self.search_radius_m = search_radius_m
        self.conflict_clearance_m = conflict_clearance_m
        self.near_clearance_m = near_clearance_m

    # ---------------------------------------------------------------------
    # Haversine distance in metres
    # ---------------------------------------------------------------------
    def haversine(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = phi2 - phi1
        dlambda = math.radians(lon2 - lon1)

        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        )
        return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    # ---------------------------------------------------------------------
    # Check a leg from start → end for nearby low bridges
    # ---------------------------------------------------------------------
    def check_leg(self, start, end, vehicle_height_m: float) -> BridgeCheckResult:
        lat1, lon1 = start
        lat2, lon2 = end

        nearest_bridge: Optional[Bridge] = None
        nearest_distance: Optional[float] = None
        has_conflict = False
        near_limit = False

        for _, row in self.df.iterrows():
            b = Bridge(
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                height_m=float(row["height_m"]),
            )

            # For now, approximate distance as min distance to start or end
            dist1 = self.haversine(lat1, lon1, b.lat, b.lon)
            dist2 = self.haversine(lat2, lon2, b.lat, b.lon)
            d = min(dist1, dist2)

            # Track nearest bridge
            if nearest_distance is None or d < nearest_distance:
                nearest_distance = d
                nearest_bridge = b

            # Only consider bridges within search radius
            if d <= self.search_radius_m:
                # Hard conflict: vehicle too tall
                if vehicle_height_m > b.height_m - self.conflict_clearance_m:
                    has_conflict = True
                # Near limit: close to bridge height
                elif vehicle_height_m > b.height_m - self.near_clearance_m:
                    near_limit = True

        return BridgeCheckResult(
            has_conflict=has_conflict,
            near_height_limit=near_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_distance,
        )
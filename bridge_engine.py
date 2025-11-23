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

    Accepts either CSV or Excel formats.
    """

    def __init__(
        self,
        csv_path: str = "bridge_heights_clean.csv",
        search_radius_m: float = 300.0,
        conflict_clearance_m: float = 0.0,
        near_clearance_m: float = 0.25,
    ):
        """
        Load CSV or Excel safely.
        Render sometimes corrupts UTF-8 CSVs, so we fall back to Excel or Latin-1.
        """
        try:
            # Normal UTF-8 CSV
            self.df = pd.read_csv(csv_path)
        except Exception:
            try:
                # Excel (xlsx)
                self.df = pd.read_excel(csv_path)
            except Exception:
                # CSV with Latin-1 (common render fallback)
                self.df = pd.read_csv(csv_path, encoding="latin1")

        self.search_radius_m = search_radius_m
        self.conflict_clearance_m = conflict_clearance_m
        self.near_clearance_m = near_clearance_m

    # ---------------------------------------------------------------------
    # Distance calculation: haversine in metres
    # ---------------------------------------------------------------------
    def haversine(self, lat1, lon1, lat2, lon2):
        phi1, phi2 = map(math.radians, [lat1, lat2])
        dphi = phi2 - phi1
        dlambda = math.radians(lon2 - lon1)

        a = (math.sin(dphi / 2) ** 2 +
             math.cos(phi1) * math.cos(phi2) *
             math.sin(dlambda / 2) ** 2)

        return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    # ---------------------------------------------------------------------
    # Check a single route leg for low-bridge risk
    # ---------------------------------------------------------------------
    def check_leg(self, start, end, vehicle_height_m):
        lat1, lon1 = start
        lat2, lon2 = end

        nearest_bridge = None
        nearest_dist = None
        has_conflict = False
        near_limit = False

        for _, row in self.df.iterrows():
            b = Bridge(
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                height_m=float(row["height_m"])
            )

            # Distance to each end of the leg
            d1 = self.haversine(lat1, lon1, b.lat, b.lon)
            d2 = self.haversine(lat2, lon2, b.lat, b.lon)
            d = min(d1, d2)

            # Track nearest bridge
            if nearest_dist is None or d < nearest_dist:
                nearest_dist = d
                nearest_bridge = b

            # Check risk zone
            if d <= self.search_radius_m:
                # Actual conflict
                if vehicle_height_m > b.height_m - self.conflict_clearance_m:
                    has_conflict = True
                # Near limit warning
                elif vehicle_height_m > b.height_m - self.near_clearance_m:
                    near_limit = True

        return BridgeCheckResult(
            has_conflict=has_conflict,
            near_height_limit=near_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_dist,
        )
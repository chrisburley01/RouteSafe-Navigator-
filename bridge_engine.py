# bridge_engine.py
#
# Uses cleaned UK low bridge data (lat, lon, height_m)
# to check route legs for height conflicts.

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
    """

    def __init__(
        self,
        csv_path: str = "bridge_heights_clean.csv",
        search_radius_m: float = 300.0,
        conflict_clearance_m: float = 0.0,
        near_clearance_m: float = 0.25,
    ):
        self.df = pd.read_csv(csv_path)
        self.search_radius_m = search_radius_m
        self.conflict_clearance_m = conflict_clearance_m
        self.near_clearance_m = near_clearance_m

    def haversine(self, lat1, lon1, lat2, lon2):
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = phi2 - phi1
        dlambda = math.radians(lon2 - lon1)

        a = (math.sin(dphi / 2) ** 2 +
             math.cos(phi1) * math.cos(phi2) *
             math.sin(dlambda / 2) ** 2)
        return EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    def check_leg(self, start, end, vehicle_height_m: float) -> BridgeCheckResult:
        lat1, lon1 = start
        lat2, lon2 = end

        nearest_bridge = None
        nearest_distance = None
        has_conflict = False
        near_limit = False

        for _, row in self.df.iterrows():
            b = Bridge(row["lat"], row["lon"], row["height_m"])

            dist1 = self.haversine(lat1, lon1, b.lat, b.lon)
            dist2 = self.haversine(lat2, lon2, b.lat, b.lon)
            d = min(dist1, dist2)

            if nearest_distance is None or d < nearest_distance:
                nearest_distance = d
                nearest_bridge = b

            if d <= self.search_radius_m:
                if vehicle_height_m > b.height_m - self.conflict_clearance_m:
                    has_conflict = True
                elif vehicle_height_m > b.height_m - self.near_clearance_m:
                    near_limit = True

        return BridgeCheckResult(
            has_conflict=has_conflict,
            near_height_limit=near_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_distance
        )
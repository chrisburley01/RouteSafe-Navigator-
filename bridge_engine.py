# bridge_engine.py
#
# Uses cleaned Network Rail bridge data (lat, lon, height_m)
# to check a straight-line leg for low-bridge risks.

from dataclasses import dataclass
from typing import Optional, List, Tuple
from pathlib import Path
import os
import math
import pandas as pd

EARTH_RADIUS_M = 6371000.0  # metres

# Directory of this file (bridge_engine.py)
BASE_DIR = Path(__file__).resolve().parent

print("DEBUG BASE_DIR:", BASE_DIR)
try:
    print("DEBUG FILES IN BASE_DIR:", os.listdir(BASE_DIR))
except Exception as e:
    print("DEBUG ERROR listing BASE_DIR:", e)


def _find_bridge_csv() -> Path:
    """
    Try several sensible locations for bridge_heights_clean.csv and
    print what we check so we can see exactly what Render sees.
    """
    candidate_names = ["bridge_heights_clean.csv"]
    candidate_dirs = [
        BASE_DIR,
        BASE_DIR.parent,          # one level up, just in case
        Path.cwd(),               # current working dir
    ]

    for d in candidate_dirs:
        try:
            files = os.listdir(d)
            print(f"DEBUG: listing {d} -> {files}")
        except Exception as e:
            print(f"DEBUG: could not list {d}: {e}")

    for name in candidate_names:
        for d in candidate_dirs:
            p = d / name
            print(f"DEBUG: checking path {p}")
            if p.exists():
                print(f"DEBUG: FOUND CSV at {p}")
                return p

    # If we get here, nothing was found – raise a very explicit error
    msg_lines = ["bridge_heights_clean.csv not found. Looked in:"]
    for d in candidate_dirs:
        msg_lines.append(f" - {d}")
    raise FileNotFoundError("\n".join(msg_lines))


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
    Loads low-bridge data and can check a *leg* (start → end)
    for nearby bridges, using vehicle height in metres.

    Expects CSV with columns:
        lat, lon, height_m
    """

    def __init__(
        self,
        csv_path: Optional[str] = None,
        search_radius_m: float = 300.0,
        conflict_clearance_m: float = 0.0,
        near_clearance_m: float = 0.25,
    ):
        if csv_path is None:
            csv_file = _find_bridge_csv()
        else:
            csv_file = Path(csv_path)

        print("DEBUG USING CSV:", csv_file)

        # Load the cleaned CSV
        self.df = pd.read_csv(csv_file)

        self.search_radius_m = search_radius_m
        self.conflict_clearance_m = conflict_clearance_m
        self.near_clearance_m = near_clearance_m

    # --- Haversine helpers ---

    def _deg2rad(self, deg: float) -> float:
        return deg * math.pi / 180.0

    def _haversine_m(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """
        Distance between two lat/lon points in metres.
        """
        dlat = self._deg2rad(lat2 - lat1)
        dlon = self._deg2rad(lon2 - lon1)
        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(self._deg2rad(lat1))
            * math.cos(self._deg2rad(lat2))
            * math.sin(dlon / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return EARTH_RADIUS_M * c

    def _project_point_fraction(
        self, lat1: float, lon1: float, lat2: float, lon2: float, t: float
    ) -> Tuple[float, float]:
        """
        Linear interpolation of lat/lon between start and end for fraction t in [0,1].
        Good enough over short legs.
        """
        return (lat1 + (lat2 - lat1) * t, lon1 + (end_lon - lon1) * t)

    # --- Core check ---

    def check_leg_for_bridges(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        vehicle_height_m: float,
        num_samples: int = 50,
    ) -> BridgeCheckResult:
        """
        Check a straight route leg between (start_lat, start_lon) and
        (end_lat, end_lon) for low-bridge conflicts.
        """

        # Sample points along the leg
        samples: List[Tuple[float, float]] = []
        for i in range(num_samples + 1):
            t = i / num_samples
            samples.append(
                self._project_point_fraction(start_lat, start_lon, end_lat, end_lon, t)
            )

        has_conflict = False
        near_height_limit = False
        nearest_bridge: Optional[Bridge] = None
        nearest_distance_m: Optional[float] = None

        # Iterate over bridges and see if any are within search_radius_m of the leg
        for _, row in self.df.iterrows():
            b_lat = float(row["lat"])
            b_lon = float(row["lon"])
            b_height = float(row["height_m"])

            # Skip if bridge is high enough with comfortable clearance
            if b_height >= vehicle_height_m + self.near_clearance_m:
                continue

            # Check distance to each sample point; keep the minimum
            min_dist_for_bridge = None
            for (s_lat, s_lon) in samples:
                d = self._haversine_m(s_lat, s_lon, b_lat, b_lon)
                if min_dist_for_bridge is None or d < min_dist_for_bridge:
                    min_dist_for_bridge = d

            # Ignore bridges that are not near the leg at all
            if min_dist_for_bridge is None or min_dist_for_bridge > self.search_radius_m:
                continue

            # Now we know this bridge is close enough to matter
            bridge_obj = Bridge(lat=b_lat, lon=b_lon, height_m=b_height)

            # Check height conflict
            if b_height < vehicle_height_m + self.conflict_clearance_m:
                has_conflict = True

            if b_height < vehicle_height_m + self.near_clearance_m:
                near_height_limit = True

            if nearest_distance_m is None or min_dist_for_bridge < nearest_distance_m:
                nearest_distance_m = min_dist_for_bridge
                nearest_bridge = bridge_obj

        return BridgeCheckResult(
            has_conflict=has_conflict,
            near_height_limit=near_height_limit,
            nearest_bridge=nearest_bridge,
            nearest_distance_m=nearest_distance_m,
        )
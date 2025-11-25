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
    Loads low-bridge data from CSV and can sca

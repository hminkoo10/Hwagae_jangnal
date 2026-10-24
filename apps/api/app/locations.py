"""Explicit place search and coordinate-to-timezone resolution, cached server-side."""
import json
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import httpx2 as httpx
from fastapi import Depends, HTTPException, Query
from app.database import encode, now_iso

def read_location(kind, values):
    url = "https://photon.komoot.io/api/" if kind == "search" else "https://api.open-meteo.com/v1/forecast"
    params = {"q": values[0], "limit": 5} if kind == "search" else {"latitude":values[0], "longitude":values[1], "timezone":"auto", "forecast_days":1, "daily":"temperature_2m_max"}
    with httpx.Client(timeout=8, trust_env=False, follow_redirects=False) as client:
        response = client.get(url, params=params, headers={"User-Agent":"HwagaeJangnal/1.0 (https://hwagae.milky.kr)", "Accept":"application/json"})
        response.raise_for_status()
        if len(response.content) > 1024*1024:
            raise ValueError("Oversized response")
        return response.json()

def mount_location_routes(application, database, authenticated):
    application.state.location_reader = read_location
    def cached(kind, values):
        key = "location:" + kind + ":" + encode(values)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM weather_cache WHERE cache_key=?",(key,)).fetchone()
            if row and row["fetched_at"] > (datetime.now(timezone.utc)-timedelta(days=7)).isoformat():
                return json.loads(row["payload"])
            throttle_key = "location:throttle:" + kind
            throttle = db.execute("SELECT fetched_at FROM weather_cache WHERE cache_key=?", (throttle_key,)).fetchone()
            if throttle and throttle[0] > (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat():
                raise HTTPException(429,"잠시 후 위치 검색을 다시 시도하세요.")
            db.execute("INSERT INTO weather_cache VALUES (?,'{}',?) ON CONFLICT(cache_key) DO UPDATE SET fetched_at=excluded.fetched_at",(throttle_key,now_iso()))
        try:
            value = application.state.location_reader(kind, values)
            if kind == "search":
                result = []
                for item in value.get("features", [])[:5]:
                    longitude, latitude = item["geometry"]["coordinates"][:2]
                    if not all(type(n) in (float,int) and math.isfinite(n) for n in (latitude,longitude)) or not -90<=latitude<=90 or not -180<=longitude<=180:
                        continue
                    props = item.get("properties",{})
                    parts = [props.get(n) for n in ("country","state","city","district","street","housenumber","name")]
                    address = " ".join(dict.fromkeys(p for p in parts if isinstance(p,str) and p))[:300]
                    result.append({"address":address,"latitude":latitude,"longitude":longitude,"precision":"주소·건물" if props.get("housenumber") or props.get("osm_value") in ("cafe","restaurant","school","supermarket") else "검색 지점 · 위치 확인 필요"})
                result = {"results":result,"source":"Photon · © OpenStreetMap contributors"}
            else:
                tz = value["timezone"]
                ZoneInfo(tz)
                result = {"latitude":values[0],"longitude":values[1],"timezone":tz}
        except (httpx.HTTPError, KeyError, ValueError, TypeError, IndexError):
            raise HTTPException(502,"위치를 조회하지 못했어요. 잠시 후 다시 검색하거나 좌표를 직접 입력하세요.") from None
        with database.connect() as db:
            db.execute("INSERT INTO weather_cache VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",(key,encode(result),now_iso()))
        return result

    @application.get("/locations/search", tags=["locations"])
    def search(q: str = Query(min_length=2,max_length=150), user=Depends(authenticated)):
        if len(q.strip()) < 2:
            raise HTTPException(400,"주소·장소를 두 글자 이상 입력하세요.")
        return cached("search", [q.strip()])

    @application.get("/locations/resolve", tags=["locations"])
    def resolve(latitude: float = Query(ge=-90,le=90,allow_inf_nan=False), longitude: float = Query(ge=-180,le=180,allow_inf_nan=False), user=Depends(authenticated)):
        return cached("timezone",[round(latitude,6),round(longitude,6)])

"""TFT inference inputs; feature rules match startup_thon_1.ipynb cells 7–10.

Never fits preprocessing state: saved encoders, scalers and weather defaults come
from the caller. The model uses Walmart's native units (°F, inches, mph); SI input
is converted first.
"""

from __future__ import annotations

from datetime import date, timedelta
import math
from numbers import Real

import numpy as np
import pandas as pd


START_DATE = pd.Timestamp("2012-01-01")
ENCODER_DAYS = 56
HORIZON = 7
GROUP = ["store_nbr", "item_nbr"]
WEATHER_BASE = ["tavg", "tmax", "tmin", "preciptotal", "avgspeed"]
WEATHER_MISSING = [f"{name}_missing" for name in WEATHER_BASE]
WEATHER_FEATURES = [*WEATHER_BASE, *WEATHER_MISSING, "precip_trace"]


def _identifier(value: object, field: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"{field} must be a nonempty string or integer")
    text = str(value)
    if not text or text != text.strip():
        raise ValueError(f"{field} must be a nonempty identifier without outer whitespace")
    return text


def _day(value: object, field: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        result = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be YYYY-MM-DD") from exc
    if result.isoformat() != value:
        raise ValueError(f"{field} must be YYYY-MM-DD")
    return result


def calendar_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Original calendar features, anchored to the training start date."""
    out = frame.copy()
    out["time_idx"] = (out.date - START_DATE).dt.days.astype("int64")
    out["dow"] = out.date.dt.dayofweek.astype(str)
    out["month"] = out.date.dt.month.astype(str)
    out["weekend"] = (out.date.dt.dayofweek >= 5).astype(float)
    out["year_sin"] = np.sin(2 * np.pi * out.date.dt.dayofyear / 365.25)
    out["year_cos"] = np.cos(2 * np.pi * out.date.dt.dayofyear / 365.25)
    return out


def _weather_frame(
    records: object,
    units: str,
    station: str,
    origin: date,
    defaults: dict,
) -> pd.DataFrame:
    """Reindex, flag missing values, causal fill, then apply saved defaults.

    Fill runs over the whole supplied prefix before taking the last 56 days, so an
    older observation can fill the encoder's left edge; otherwise the saved training
    median applies.
    """
    if not isinstance(records, list):
        raise ValueError("model_input.history_weather must be a list")
    rows = []
    seen = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("history_weather records must be objects")
        day = _day(record.get("date"), "history_weather.date")
        if day > origin:
            raise ValueError("history_weather cannot contain observations after as_of")
        if day in seen:
            raise ValueError(f"duplicate history_weather date: {day}")
        seen.add(day)
        if "station_nbr" in record and _identifier(record["station_nbr"], "history_weather.station_nbr") != station:
            raise ValueError("history_weather station_nbr differs from model_input.station_nbr")
        rows.append({"date": pd.Timestamp(day), **{name: record.get(name) for name in WEATHER_BASE}})
    weather = pd.DataFrame(rows, columns=["date", *WEATHER_BASE])
    weather["date"] = pd.to_datetime(weather["date"])
    weather["precip_trace"] = weather.preciptotal.astype(str).str.strip().eq("T").astype(float)
    for name in WEATHER_BASE:
        # Exact notebook semantics: M, non-numeric and infinity become missing;
        # T is numeric zero, with a separate trace flag only for precipitation.
        weather[name] = pd.to_numeric(
            weather[name].astype(str).str.strip().replace({"M": np.nan, "T": "0"}),
            errors="coerce",
        )
    weather[WEATHER_BASE] = weather[WEATHER_BASE].replace([np.inf, -np.inf], np.nan)
    if units == "si":
        for name in ["tavg", "tmax", "tmin"]:
            weather[name] = weather[name] * 9 / 5 + 32
        weather["preciptotal"] = weather.preciptotal / 25.4
        weather["avgspeed"] = weather.avgspeed / 0.44704
    encoder_start = origin - timedelta(days=ENCODER_DAYS - 1)
    first = min([encoder_start, *seen])
    grid = pd.DataFrame({"date": pd.date_range(first, origin)})
    weather = grid.merge(weather, on="date", how="left", validate="one_to_one").sort_values("date")
    for name in WEATHER_BASE:
        weather[name + "_missing"] = weather[name].isna().astype(float)
    weather["precip_trace"] = weather.precip_trace.fillna(0.0)
    fill = {}
    for name in WEATHER_BASE:
        value = defaults.get(name)
        if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(float(value)):
            raise ValueError(f"saved weather default must be finite: {name}")
        fill[name] = float(value)
    # The request contains one station, equivalent to the notebook's groupby.
    weather[WEATHER_BASE] = weather[WEATHER_BASE].ffill().fillna(fill)
    weather["station_nbr"] = station
    return weather[weather.date >= pd.Timestamp(encoder_start)].reset_index(drop=True)


def _forecast_weather_frame(records: object, units: str, forecast_dates: list[date]) -> pd.DataFrame:
    """Validate explicit scenario weather; never fill missing future values.

    Forecasts carry no NOAA trace flag, so precip_trace=0 is a convention, not an
    observation.
    """
    if not isinstance(records, list) or len(records) != HORIZON:
        raise ValueError("model_input.forecast_weather must contain exactly seven days")
    rows = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("forecast_weather records must be objects")
        day = _day(record.get("date"), "forecast_weather.date")
        values = {}
        for name in WEATHER_BASE:
            value = record.get(name)
            if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(float(value)):
                raise ValueError(f"forecast_weather.{name} must be finite numeric data")
            values[name] = float(value)
        si = dict(values)
        if units == "walmart":
            for name in ("tavg", "tmax", "tmin"):
                si[name] = (si[name] - 32) * 5 / 9
            si["preciptotal"] *= 25.4
            si["avgspeed"] *= 0.44704
        if not -90 <= si["tmin"] <= si["tavg"] <= si["tmax"] <= 65:
            raise ValueError("forecast_weather temperatures must be ordered and within -90..65 Celsius")
        if not 0 <= si["preciptotal"] <= 2000 or not 0 <= si["avgspeed"] <= 150:
            raise ValueError("forecast_weather precipitation or wind speed is outside the supported range")
        if units == "si":
            for name in ("tavg", "tmax", "tmin"):
                values[name] = values[name] * 9 / 5 + 32
            values["preciptotal"] /= 25.4
            values["avgspeed"] /= 0.44704
        rows.append({"date": pd.Timestamp(day), **values,
                     **{name: 0.0 for name in WEATHER_MISSING}, "precip_trace": 0.0})
    if [row["date"].date() for row in rows] != sorted(forecast_dates):
        raise ValueError("forecast_weather dates must be D+1 through D+7 in chronological order")
    return pd.DataFrame(rows)


def prepare_context(
    context: dict,
    parameters: dict,
    defaults: dict,
    selected_series: pd.DataFrame,
) -> tuple[pd.DataFrame | None, list[dict]]:
    """Return 56 encoder + 7 decoder rows per eligible requested product.

    Missing sales are never fabricated: a series without all 56 daily observations
    through ``as_of``, or without a trained Walmart mapping, is ``insufficient_history``.
    New Korean identifiers must never be assigned an unrelated Walmart embedding.
    """
    if not isinstance(context, dict):
        raise ValueError("context must be an object")
    if context.get("schema_version") != "1":
        raise ValueError("schema_version must be '1'")
    _identifier(context.get("store_id"), "store_id")
    origin = _day(context.get("as_of"), "as_of")
    requested = context.get("dates")
    if not isinstance(requested, list) or len(requested) != HORIZON:
        raise ValueError("dates must contain the next seven dates after as_of")
    forecast_dates = [_day(value, "dates") for value in requested]
    expected = {origin + timedelta(days=i) for i in range(1, HORIZON + 1)}
    if set(forecast_dates) != expected:
        raise ValueError("dates must contain each of D+1 through D+7 exactly once")
    spec = context.get("model_input")
    if not isinstance(spec, dict):
        raise ValueError("model_input is required; see ml/examples/input-fields.json")
    if spec.get("dataset") != "walmart-stormy-weather":
        raise ValueError("model_input.dataset must be 'walmart-stormy-weather'")
    store = _identifier(spec.get("store_nbr"), "model_input.store_nbr")
    station = _identifier(spec.get("station_nbr"), "model_input.station_nbr")
    if spec.get("weather_strategy") not in {"persistence", "provided_forecast"}:
        raise ValueError("model_input.weather_strategy must be persistence or provided_forecast")
    if spec.get("weather_units") not in {"walmart", "si"}:
        raise ValueError("model_input.weather_units must be 'walmart' or 'si'")
    if "history_weather" not in spec:
        raise ValueError("model_input.history_weather is required (an empty list uses saved defaults)")
    forecast_weather = (
        _forecast_weather_frame(spec.get("forecast_weather"), spec["weather_units"], forecast_dates)
        if spec["weather_strategy"] == "provided_forecast" else None
    )
    if parameters.get("max_encoder_length") != ENCODER_DAYS or parameters.get("max_prediction_length") != HORIZON:
        raise ValueError("saved dataset must have a 56-day encoder and 7-day decoder")
    products = context.get("products")
    if not isinstance(products, list) or not products:
        raise ValueError("products must be a nonempty list")
    requested_products = []
    product_ids = set()
    item_ids = set()
    for product in products:
        if not isinstance(product, dict):
            raise ValueError("products entries must be objects")
        product_id = _identifier(product.get("id"), "products.id")
        if product_id in product_ids:
            raise ValueError(f"duplicate product id: {product_id}")
        product_ids.add(product_id)
        item_value = product.get("model_item_nbr")
        item = None if item_value is None else _identifier(item_value, "products.model_item_nbr")
        if item is not None and item in item_ids:
            raise ValueError("multiple products cannot map to the same model_item_nbr")
        item_ids.add(item)
        requested_products.append((product_id, item))
    records = context.get("sales")
    if not isinstance(records, list):
        raise ValueError("sales must be a list")
    sales = {product_id: {} for product_id in product_ids}
    seen_sales = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("sales entries must be objects")
        product_id = _identifier(record.get("product_id"), "sales.product_id")
        day = _day(record.get("date"), "sales.date")
        if day > origin:
            raise ValueError("sales cannot contain dates after as_of")
        key = (product_id, day)
        if key in seen_sales:
            raise ValueError(f"duplicate sales record: {product_id} / {day}")
        seen_sales.add(key)
        value = record.get("units_sold")
        if value is not None and (isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(float(value)) or value < 0):
            raise ValueError("units_sold must be finite and nonnegative, or null for missing")
        if value is not None and not float(value).is_integer():
            raise ValueError("units_sold must be whole-unit sales, matching this checkpoint's training data")
        if product_id in sales:
            sales[product_id][day] = value
    weather = _weather_frame(spec["history_weather"], spec["weather_units"], station, origin, defaults)
    selected = selected_series[[*GROUP, "station_nbr"]].astype(str)
    known_pairs = {(row.store_nbr, row.item_nbr): row.station_nbr for row in selected.itertuples(index=False)}
    known_stations = set(selected.loc[selected.store_nbr == store, "station_nbr"])
    if known_stations and station not in known_stations:
        raise ValueError("station_nbr does not match the saved store-to-station mapping")
    history_dates = [origin - timedelta(days=ENCODER_DAYS - 1 - i) for i in range(ENCODER_DAYS)]
    results = []
    frames = []
    for product_id, item in requested_products:
        result = {"product_id": product_id, "model_item_nbr": item,
                  "status": "insufficient_history", "reason": None, "points": []}
        if item is None:
            result["reason"] = "missing_model_item_nbr: explicit trained product mapping is required"
        elif (store, item) not in known_pairs:
            result["reason"] = "unseen_series: this store/product pair requires training before TFT inference"
        elif any(sales[product_id].get(day) is None for day in history_dates):
            count = sum(sales[product_id].get(day) is not None for day in history_dates)
            result["reason"] = f"requires 56 consecutive observed sales days through as_of; received {count}/56"
        elif history_dates[0] < START_DATE.date():
            result["reason"] = "history starts before the checkpoint's 2012-01-01 time_idx origin"
        else:
            history = pd.DataFrame({"date": pd.to_datetime(history_dates),
                                    "units": [float(sales[product_id][day]) for day in history_dates],
                                    "sales_observed": 1.0})
            history = history.merge(weather, on="date", how="left", validate="one_to_one")
            future = pd.DataFrame({"date": pd.date_range(origin + timedelta(days=1), periods=HORIZON),
                                   "units": 0.0, "sales_observed": 0.0, "station_nbr": station})
            for name in WEATHER_FEATURES:
                future[name] = (float(weather.iloc[-1][name]) if forecast_weather is None
                                else forecast_weather[name].to_numpy())
            frame = pd.concat([history, future], ignore_index=True)
            frame["store_nbr"], frame["item_nbr"] = store, item
            frame = calendar_features(frame)
            for name in ["units", "sales_observed", "weekend", "year_sin", "year_cos", *WEATHER_FEATURES]:
                frame[name] = frame[name].astype("float32")
            if not np.isfinite(frame[["units", *WEATHER_FEATURES]].to_numpy()).all():
                raise ValueError("features exceed the finite float32 range")
            frames.append(frame)
            result["status"] = "ready"
        results.append(result)
    prepared = pd.concat(frames, ignore_index=True).sort_values([*GROUP, "time_idx"]).reset_index(drop=True) if frames else None
    return prepared, results

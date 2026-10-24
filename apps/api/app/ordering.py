"""Finite-horizon, FEFO scenario comparison. These are planning assumptions, not calibrated joint quantiles."""

import math
from datetime import date, timedelta


def simulate(quantity, demand, product, stock, as_of, order_date=None):
    order_date = order_date or as_of
    if order_date < as_of:
        raise ValueError("발주 예정일은 판매 마감 기준일보다 빠를 수 없습니다.")
    arrival = order_date + timedelta(days=product["lead_days"])
    expiry = arrival + timedelta(days=product["shelf_days"] - 1)
    batches = [
        {
            "quantity": batch["quantity"],
            "expires_on": date.fromisoformat(batch["expires_on"]),
        }
        for batch in stock["batches"]
        if batch["expires_on"] > as_of.isoformat()
    ]
    waste, missed = 0.0, 0.0
    for offset, wanted in enumerate(demand, 1):
        day = as_of + timedelta(days=offset)
        for batch in batches:
            if batch["expires_on"] < day:
                waste += batch["quantity"]
                batch["quantity"] = 0
        for incoming in stock["incoming"]:
            if incoming["arrives_on"] == day.isoformat():
                batches.append(
                    {
                        "quantity": incoming["quantity"],
                        "expires_on": date.fromisoformat(incoming["expires_on"]),
                    }
                )
        if day == arrival:
            batches.append({"quantity": quantity, "expires_on": expiry})
        for batch in sorted(batches, key=lambda item: item["expires_on"]):
            sold = min(wanted, batch["quantity"])
            batch["quantity"] -= sold
            wanted -= sold
        missed += wanted
        for batch in batches:
            if batch["expires_on"] == day:
                waste += batch["quantity"]
                batch["quantity"] = 0
    # Unexpired terminal stock is carried at cost, not reported as waste.
    return {
        "waste_units": round(waste, 2),
        "missed_units": round(missed, 2),
        "ending_units": round(sum(batch["quantity"] for batch in batches), 2),
        "loss": round(
            waste * product["cost"] + missed * (product["price"] - product["cost"]), 2
        ),
    }


def recommend(product, forecast, stock, as_of, order_date=None):
    order_date = order_date or as_of
    delay = (order_date - as_of).days
    if delay < 0:
        raise ValueError("발주 예정일은 판매 마감 기준일보다 빠를 수 없습니다.")
    row = {
        "product_id": product["id"],
        "name": product["name"],
        "supplier": product["supplier"],
        "cost": product["cost"],
        "quantity": None,
        "amount": None,
        "status": "blocked",
        "current_stock": None,
        "order_date": order_date.isoformat(),
        "arrival_date": (order_date + timedelta(days=product["lead_days"])).isoformat(),
    }
    if not stock:
        return {**row, "reason": "재고를 직접 입력하면 발주량을 계산합니다."}
    if stock["measured_on"] != as_of.isoformat():
        return {**row, "reason": "판매 마감 기준일에 맞춰 재고를 다시 확인하세요."}
    if not stock["incoming_confirmed"]:
        return {**row, "reason": "입고 예정 유무를 확인하세요."}
    if any(item["arrives_on"] <= as_of.isoformat() for item in stock["incoming"]):
        return {
            **row,
            "reason": "지난 입고 예정분을 현재 재고에 반영한 뒤 다시 입력하세요.",
        }
    row["current_stock"] = sum(
        batch["quantity"]
        for batch in stock["batches"]
        if batch["expires_on"] > as_of.isoformat()
    )
    if forecast["status"] != "ready":
        return {**row, "reason": "7일 예측에 필요한 판매 기록이 부족합니다."}
    # Keep simulation anchored to measured stock. Demand before the planned
    # order still consumes existing batches and scheduled incoming deliveries.
    horizon = delay + product["lead_days"] + product["review_days"] - 1
    if horizon > len(forecast["points"]):
        return {
            **row,
            "reason": "다음 발주분 도착 전까지 필요한 기간이 7일 예측 범위를 넘습니다.",
        }
    if product["price"] <= product["cost"]:
        return {
            **row,
            "reason": "판매가가 매입 원가보다 높아야 비용 비교가 가능합니다.",
        }
    scenarios = [
        [point[key] for point in forecast["points"][:horizon]]
        for key in ("p10", "p50", "p90")
    ]
    upper = math.ceil(sum(scenarios[-1][delay + product["lead_days"] - 1 :]))
    step = max(1, math.ceil(upper / 250))
    candidates = set(range(0, upper + 1, step)) | {upper}
    for scenario in scenarios:
        unmet = simulate(0, scenario, product, stock, as_of, order_date)["missed_units"]
        for candidate in (math.floor(unmet), math.ceil(unmet)):
            candidates.add(max(0, min(upper, candidate)))
    best = None
    for quantity in sorted(candidates):
        results = [
            simulate(quantity, scenario, product, stock, as_of, order_date)
            for scenario in scenarios
        ]
        loss = sum(result["loss"] for result in results) / 3
        if best is None or loss < best[0] - 1e-7:
            best = (loss, quantity, results)
    loss, quantity, results = best
    return {
        **row,
        "status": "ready",
        "reason": None,
        "quantity": quantity,
        "amount": quantity * product["cost"],
        "horizon_days": horizon,
        "scenario_loss": round(loss),
        "scenario_results": results,
        "method": "P10·P50·P90의 3개 고정 경로를 같은 비중으로 비교한 근사 계획. 기간 분위수·품절 확률·실제 절감액이 아닙니다.",
    }

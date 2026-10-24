"""Explain fixed CPU examples and retrospective failures without running a model.

Data analysis uses the standard library. Plotting additionally needs matplotlib.
Future actuals are joined only after the three example IDs have been selected.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import csv
from datetime import date, timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import platform
import statistics
import zipfile

from ml.evaluate import exact_api_baseline


ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "ml/examples"
SELECTION = {
    "information_used": "Only the 56 observed sales days on or before as_of; no future actuals or predictions.",
    "normal": "Among series with 56 positive sales days, choose the middle coefficient of variation (population SD / mean); use the lower middle for an even count.",
    "volatile": "Among the same positive-history series excluding normal, choose the largest coefficient of variation.",
    "zero": "Among all ten series excluding the first two, choose the largest number of zero-sales history days.",
    "tie_break": "Ascending numeric store_nbr, then item_nbr.",
    "limitation": "Illustrative cases within the supplied ten-series sample; not a representative accuracy estimate.",
}
LABELS = {"normal": "일반 판매", "volatile": "변동 판매", "zero": "0판매"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")


def history_stats(values):
    mean = statistics.mean(values)
    sd = statistics.pstdev(values)
    return {"days": len(values), "total": sum(values), "mean": mean, "population_sd": sd,
            "coefficient_of_variation": sd / mean if mean else None,
            "zero_days": values.count(0), "zero_fraction": values.count(0) / len(values),
            "minimum": min(values), "maximum": max(values), "last_7_mean": statistics.mean(values[-7:])}


def numeric_key(item):
    return int(item["store_nbr"]), int(item["item_nbr"])


def choose_examples(candidates):
    """Deliberately accepts histories, not future actuals or forecast errors."""
    positive = [item for item in candidates if item["history_stats"]["zero_days"] == 0]
    if len(positive) < 2:
        raise ValueError("Need at least two fully positive 56-day histories.")
    ordered = sorted(positive, key=lambda item: (item["history_stats"]["coefficient_of_variation"], *numeric_key(item)))
    normal = ordered[(len(ordered) - 1) // 2]
    volatile = min((item for item in positive if numeric_key(item) != numeric_key(normal)),
                   key=lambda item: (-item["history_stats"]["coefficient_of_variation"], *numeric_key(item)))
    used = {numeric_key(normal), numeric_key(volatile)}
    zero = min((item for item in candidates if numeric_key(item) not in used),
               key=lambda item: (-item["history_stats"]["zero_days"], *numeric_key(item)))
    return [("normal", normal), ("volatile", volatile), ("zero", zero)]


def forecast_metrics(points, prefix=""):
    actual = [row["actual"] for row in points]
    median = [row[prefix + "p50"] for row in points]
    zeros = [row for row in points if row["actual"] == 0]
    absolute = math.fsum(abs(a - q) for a, q in zip(actual, median))
    return {"days": len(points), "actual_total": sum(actual), "p50_total": math.fsum(median),
            "MAE": absolute / len(points), "WAPE": absolute / sum(actual) if sum(actual) else None,
            "interval_coverage": sum(row[prefix + "p10"] <= row["actual"] <= row[prefix + "p90"] for row in points) / len(points),
            "above_p90_days": sum(row["actual"] > row[prefix + "p90"] for row in points),
            "below_p10_days": sum(row["actual"] < row[prefix + "p10"] for row in points),
            "zero_actual_days": len(zeros),
            "zero_day_p50_MAE": math.fsum(abs(row[prefix + "p50"]) for row in zeros) / len(zeros) if zeros else None,
            "zero_day_p50_total": math.fsum(row[prefix + "p50"] for row in zeros),
            "zero_day_positive_p50_count": sum(row[prefix + "p50"] > 0 for row in zeros)}


def checked_history(rows, product_id, as_of, days=56):
    cutoff = date.fromisoformat(as_of)
    wanted = [(cutoff - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    selected = sorted((row for row in rows if row["product_id"] == product_id), key=lambda row: row["date"])
    if [row["date"] for row in selected] != wanted:
        raise ValueError("Example requires exactly 56 observed days with no future or duplicate rows.")
    return selected


def baseline_points(baseline, product_id, dates, history):
    result = baseline({"products": [{"id": product_id}], "dates": dates, "sales": history})["products"][0]
    if result["status"] != "ready" or [row["date"] for row in result["points"]] != dates:
        raise ValueError("Selected case does not have the API baseline's required history.")
    return result["points"]


def failure_evidence(case):
    """Observed level/peak changes, kept separate from causal explanations."""
    history, points = case["history_stats"], case["points"]
    worst = max(points, key=lambda point: abs(point["actual"] - point["p50"]))
    future_mean = case["metrics"]["TFT"]["actual_total"] / 7
    recent_change = history["last_7_mean"] / history["mean"] - 1 if history["mean"] else None
    future_change = future_mean / history["last_7_mean"] - 1 if history["last_7_mean"] else None
    outside = not history["minimum"] <= worst["actual"] <= history["maximum"]
    pattern = "recent_rise_and_new_peak" if recent_change is not None and recent_change >= .1 and outside else (
        "recent_rise_but_worst_day_within_history_range" if recent_change is not None and recent_change >= .1
        else "new_peak_without_recent_average_rise")
    return {"history_56_mean": history["mean"], "history_last_7_mean": history["last_7_mean"],
            "actual_next_7_mean": future_mean, "last_7_vs_56_relative_change": recent_change,
            "next_7_vs_last_7_relative_change": future_change,
            "actual_days_above_history_mean": sum(point["actual"] > history["mean"] for point in points),
            "actual_days_above_history_maximum": sum(point["actual"] > history["maximum"] for point in points),
            "worst_day": {**worst, "absolute_p50_error": abs(worst["actual"] - worst["p50"]),
                          "actual_outside_history_range": outside},
            "descriptive_pattern": pattern,
            "pattern_rule": "Recent rise means last-7 mean >= 1.10 times history-56 mean; a new peak means the maximum-error day's actual exceeds the historical range. This describes observations, not causes."}


def sample_cases(baseline):
    manifest_path = EXAMPLES / "demo-manifest.json"
    manifest = read_json(manifest_path)
    sources, candidates = {"ml/examples/demo-manifest.json": sha(manifest_path)}, []
    for entry in manifest["samples"]:
        path = EXAMPLES / entry["input"]
        context = read_json(path)
        sources[str(path.relative_to(ROOT)).replace("\\", "/")] = sha(path)
        for product in context["products"]:
            history = checked_history(context["sales"], product["id"], context["as_of"])
            candidates.append({"store_nbr": entry["store_nbr"], "item_nbr": product["model_item_nbr"],
                               "station_nbr": entry["station_nbr"], "product_id": product["id"],
                               "name": product["name"], "as_of": context["as_of"], "dates": context["dates"],
                               "history": history, "history_stats": history_stats([row["units_sold"] for row in history]),
                               "entry": entry, "store_id": context["store_id"]})
    selected = choose_examples(candidates)
    # Selection is final before either future actuals or predicted values are read.
    actual_path = EXAMPLES / manifest["actuals_file"]
    actuals = read_json(actual_path)["stores"]
    sources[str(actual_path.relative_to(ROOT)).replace("\\", "/")] = sha(actual_path)
    results = []
    for category, candidate in selected:
        case = {key: value for key, value in candidate.items() if key != "entry"}
        expected_path = EXAMPLES / candidate["entry"]["expected_api"]
        sources[str(expected_path.relative_to(ROOT)).replace("\\", "/")] = sha(expected_path)
        predicted = next(item for item in read_json(expected_path)["products"] if item["product_id"] == case["product_id"])
        truth = [row for row in actuals[case["store_id"]] if row["product_id"] == case["product_id"]]
        if sorted(row["date"] for row in truth) != case["dates"]:
            raise ValueError("Future actuals must match exactly the seven requested dates.")
        truth = {row["date"]: row["units_sold"] for row in truth}
        reference = baseline_points(baseline, case["product_id"], case["dates"], case["history"])
        points = []
        for point, base in zip(predicted["points"], reference, strict=True):
            if point["date"] != base["date"]:
                raise ValueError("Forecast and baseline dates differ.")
            points.append({**point, "actual": truth[point["date"]],
                           **{"baseline_" + key: base[key] for key in ("p10", "p50", "p90")}})
        case.update(category=category, label=LABELS[category], points=points,
                    baseline_lookback_days=56, forecast_source="committed CPU float32 expected-api fixture; no model rerun",
                    metrics={"TFT": forecast_metrics(points), "API_baseline": forecast_metrics(points, "baseline_")})
        results.append(case)
    return {"selection": SELECTION, "candidate_history_statistics": [
                {key: item[key] for key in ("store_nbr", "item_nbr", "history_stats")} for item in candidates],
            "input_sha256": sources, "cases": results}


def verified_member(archive, member, manifest):
    content = archive.read("evaluation-data/" + member)
    entry = next(item for item in manifest["files"] if item["path"] == member)
    if hashlib.sha256(content).hexdigest() != entry["sha256"]:
        raise ValueError(f"Archive member hash differs: {member}")
    return content


def failure_cases(archive_path, baseline):
    external = read_json(ROOT / "ml/evaluation/external-data.json")
    if sha(archive_path) != external["sha256"]:
        raise ValueError("Evaluation archive hash differs from external-data.json.")
    with zipfile.ZipFile(archive_path) as archive:
        manifest = json.loads(archive.read("evaluation-data/MANIFEST.json"))
        prediction_bytes = verified_member(archive, "current/test_predictions.csv", manifest)
        sales_zip = verified_member(archive, "train.csv.zip", manifest)
    predictions = list(csv.DictReader(io.StringIO(prediction_bytes.decode("utf-8-sig"))))
    windows = defaultdict(list)
    for row in predictions:
        windows[(row["store_nbr"], row["item_nbr"], row["origin_date"])].append(row)
    observed = defaultdict(dict)
    groups = {key[:2] for key in windows}
    earliest = (min(date.fromisoformat(key[2]) for key in windows) - timedelta(days=83)).isoformat()
    with zipfile.ZipFile(io.BytesIO(sales_zip)) as archive:
        with archive.open(archive.namelist()[0]) as stream:
            for row in csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig")):
                key = row["store_nbr"], row["item_nbr"]
                if key in groups and row["date"] >= earliest:
                    if row["date"] in observed[key]:
                        raise ValueError("Duplicate raw observed sale.")
                    observed[key][row["date"]] = int(row["units"])
    eligible = []
    for (store, item, origin), rows in windows.items():
        rows = sorted(rows, key=lambda row: row["date"])
        cutoff = date.fromisoformat(origin)
        dates = [(cutoff + timedelta(days=i)).isoformat() for i in range(1, 8)]
        if [row["date"] for row in rows] != dates:
            raise ValueError("Incomplete source test window.")
        sales = observed[(store, item)]
        history_dates = [(cutoff - timedelta(days=i)).isoformat() for i in range(55, -1, -1)]
        if not all(day in sales for day in history_dates):
            continue
        history = [{"product_id": item, "date": day, "units_sold": sales[day]} for day in history_dates]
        full_history = [{"product_id": item, "date": day, "units_sold": units} for day, units in sorted(sales.items())
                        if (cutoff - timedelta(days=83)).isoformat() <= day <= origin]
        base = baseline_points(baseline, item, dates, full_history)
        points = []
        for row, reference in zip(rows, base, strict=True):
            actual = float(row["actual"])
            if actual != sales.get(row["date"]):
                raise ValueError("Source prediction actual differs from observed sales.")
            points.append({"date": row["date"], "actual": actual,
                           **{f"p{q}": float(row[f"q{q}"]) for q in (10, 50, 90)},
                           **{"baseline_" + key: reference[key] for key in ("p10", "p50", "p90")}})
        eligible.append({"store_nbr": store, "item_nbr": item, "as_of": origin, "dates": dates,
                         "history": history, "history_stats": history_stats([row["units_sold"] for row in history]),
                         "baseline_lookback_days": 84, "baseline_observed_days": len(full_history),
                         "forecast_source": "original saved GPU test_predictions.csv; not the CPU sample fixture",
                         "points": points, "metrics": {"TFT": forecast_metrics(points), "API_baseline": forecast_metrics(points, "baseline_")}})
    ordered = sorted(eligible, key=lambda case: (-case["metrics"]["TFT"]["MAE"], *numeric_key(case), case["as_of"]))
    selected, seen = [], set()
    for rank, case in enumerate(ordered, 1):
        if numeric_key(case) in seen:
            continue
        case["MAE_rank_in_strict_windows"] = rank
        case["observed_evidence"] = failure_evidence(case)
        selected.append(case)
        seen.add(numeric_key(case))
        if len(selected) == 3:
            break
    return {"archive_sha256": sha(archive_path), "eligible_windows": len(eligible),
            "eligible_rows": len(eligible) * 7,
            "selection": "Retrospective failure selection: rank the strict-56-observed test windows by seven-day TFT P50 MAE descending; take the first three distinct store/item pairs. Ties use numeric store, item, then origin date. Future errors ARE used for this failure analysis, not for the three illustrative cases.",
            "cases": selected}


def save_csv(path, cases):
    fields = ["case", "store_nbr", "item_nbr", "as_of", "baseline_lookback_days", "date", "actual", "p10", "p50", "p90", "baseline_p10", "baseline_p50", "baseline_p90"]
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        for index, case in enumerate(cases, 1):
            for point in case["points"]:
                writer.writerow({"case": case.get("category", f"failure-{index}"), **{key: case[key] for key in fields[1:5]}, **point})


def summaries(cases, failure=False):
    heading = "# 원본 테스트의 큰 실패 사례" if failure else "# 과거 이력으로 고른 세 가지 판매 사례"
    text = [heading, "", "상품명·품목 종류는 원본에 없으므로 Walmart 매장·상품 번호로만 설명합니다. 판매량 단위는 개이며 소수 예측값은 반올림하지 않았습니다. 일별 P50의 합은 비교를 위한 합산값이며 주간 합계 수요 분포의 중앙값을 뜻하지 않습니다.", ""]
    if failure:
        text += ["이 사례는 원본 테스트에서 최근 56일이 모두 관측된 243개 window를 7일 P50 MAE 내림차순으로 정렬한 뒤 서로 다른 매장·상품쌍 세 개를 골랐습니다. **미래 오차를 본 사후 실패 선택**입니다. 성능의 대표 표본이나 새로운 평가 집합이 아닙니다. 저장된 GPU 예측을 사용하며 CPU 샘플과 혼용하지 않습니다. API 기준선은 해당 기준일까지 최대 84일 관측만 받습니다.", ""]
    else:
        text += ["세 상품은 미래 실제값이나 모델 예측을 읽기 전에 56일 이력만으로 골랐습니다. 56일 모두 양수인 5상품 중 CV(모표준편차/평균)의 중앙값을 일반 판매, CV 최대를 변동 판매로 선택합니다. 전체 10상품 중 0판매일이 가장 많은 상품을 0판매 사례로 고릅니다. 동률은 매장·상품 번호 숫자 오름차순입니다. ‘일반’은 이 작은 후보 집합의 상대적 명칭이며 전체 상품 대표성을 뜻하지 않습니다.", "", "세 사례의 요일 기준선은 현재 API의 실제 함수를 **동일한 56일 입력**에 적용했습니다. 전체 평가의 API 기준선은 84일 입력이며 개선율 6.98%/10.71%는 그 집계 결과입니다. 아래 세 사례의 수치로 그 개선율을 계산하거나 일반화하지 않습니다. P10~P90은 명목 80% 예측 구간이며 7일의 관측 포함률은 보정의 증거가 아닙니다.", ""]
    for index, case in enumerate(cases, 1):
        hist, tft, base = case["history_stats"], case["metrics"]["TFT"], case["metrics"]["API_baseline"]
        title = f"실패 {index}" if failure else case["label"]
        cv = "정의 안 됨(평균 0)" if hist["coefficient_of_variation"] is None else f"{hist['coefficient_of_variation']:.4f}"
        text += [f"## {title} — Walmart 매장 {case['store_nbr']}, 상품 {case['item_nbr']}", "",
                 f"기준일 {case['as_of']}, 예측 기간 {case['dates'][0]}~{case['dates'][-1]}. 과거 56일 평균 {hist['mean']:.3f}, 모표준편차 {hist['population_sd']:.3f}, CV {cv}, 0판매 {hist['zero_days']}/56일, 범위 {hist['minimum']}~{hist['maximum']}개입니다.", "",
                 f"7일 실제 합계 {tft['actual_total']:g}개, TFT P50 합계 {tft['p50_total']:.3f}개. TFT MAE **{tft['MAE']:.3f}**, API 요일 기준선 MAE **{base['MAE']:.3f}**. 구간 포함률은 각각 {tft['interval_coverage']:.1%}, {base['interval_coverage']:.1%}입니다.", ""]
        if tft["zero_actual_days"]:
            text += [f"실제 0판매일 {tft['zero_actual_days']}일의 P50 MAE는 TFT {tft['zero_day_p50_MAE']:.3f}, 기준선 {base['zero_day_p50_MAE']:.3f}입니다. TFT는 그중 {tft['zero_day_positive_p50_count']}일에 양수 P50을 반환합니다. 전체 실측이 0이면 WAPE는 정의되지 않아 JSON에 null로 기록합니다.", ""]
        else:
            text += ["이 7일에는 실제 0판매일이 없어 0판매일 오차는 null입니다.", ""]
        if failure:
            evidence = case["observed_evidence"]
            worst = evidence["worst_day"]
            recent = evidence["last_7_vs_56_relative_change"]
            future = evidence["next_7_vs_last_7_relative_change"]
            outside = "벗어났습니다" if worst["actual_outside_history_range"] else "안에 있습니다"
            pattern = evidence["descriptive_pattern"]
            hypothesis, improvement = {
                "recent_rise_and_new_peak": (
                    "직전 7일 평균에 이미 상승이 나타났고 다음 주에는 과거 범위 밖의 고점도 생겼습니다. 모델 출력이 최근 수준 상승과 추가 고점을 충분히 따라가지 못한 가능성을 검토합니다. 이는 출력 패턴 해석이며 내부 원인이나 특정 외부 요인을 입증하지 않습니다.",
                    "검증 구간에서 최근 7일 수준과 56일 수준의 비율별 오차를 나누고 최근 수준을 따라가는 단순 기준선도 비교합니다. 상승 구간의 상단 분위수 보정은 검증 자료에서 설계하고 새 미래 홀드아웃에서 확인합니다."),
                "recent_rise_but_worst_day_within_history_range": (
                    "직전 주의 평균은 올랐지만 최대 오차일의 실제값 자체는 과거 56일 범위 안입니다. 관측되지 않았던 큰 숫자만의 문제로 설명하기 어렵고, 날짜별 높은 판매와 예측 수준의 정렬·요일 패턴 또는 horizon별 편향을 확인할 필요가 있습니다.",
                    "최대 오차일의 요일별 과거 관측과 D+7 예측 편향을 우선 확인하고, 최근 수준·요일별 기준선에 비해 낮아지는 구간을 검증 집합에서 분리합니다. 날짜 정렬과 해당일 원자료도 검토한 뒤 보정을 별도 미래 홀드아웃으로 평가합니다."),
                "new_peak_without_recent_average_rise": (
                    "직전 7일 평균에는 상승 신호가 없었지만 다음 주 실제 평균과 최대 오차일 판매가 크게 늘었습니다. 최근 평균 추세만으로 설명하기 어려운 새 변동 구간일 가능성을 검토합니다. 외부 정보가 없으므로 특정 행사나 공급 상황을 원인으로 지목할 수 없습니다.",
                    "급증일의 원자료·영업/재고 기록을 확인하고, 검증 구간에서 과거 범위 초과 사건의 빈도와 상단 분위수 포함률을 따로 점검합니다. 확인 가능한 외생 정보가 있으면 당시 이용 가능했던 정보만 추가하고 새로운 미래 홀드아웃에서 재평가합니다."),
            }[pattern]
            text += [f"- **관측 사실:** strict56 window MAE 순위 {case['MAE_rank_in_strict_windows']}위. 과거 56일 평균 {hist['mean']:.3f}개 → 직전 7일 평균 {hist['last_7_mean']:.3f}개({recent:+.1%}) → 다음 7일 실제 평균 {evidence['actual_next_7_mean']:.3f}개(직전 주 대비 {future:+.1%})입니다. 실제 {evidence['actual_days_above_history_mean']}/7일이 과거 평균보다 높고 {evidence['actual_days_above_history_maximum']}/7일이 과거 최댓값을 넘었습니다.",
                     f"- **최대 오차일:** {worst['date']}의 actual {worst['actual']:g}, P50 {worst['p50']:.3f}, P90 {worst['p90']:.3f}, 절대 P50 오차 {worst['absolute_p50_error']:.3f}개입니다. 이날 실제값은 과거 56일 범위 {hist['minimum']}~{hist['maximum']}개 {outside}. 전체 주간 실제값이 P90을 넘은 날은 {tft['above_p90_days']}일, P10보다 낮은 날은 {tft['below_p10_days']}일입니다.",
                     f"- **원인 추정:** {hypothesis} 판매 관측만으로 잠재 수요와 공급 제약을 구분할 수 없으며 프로모션·품절·날씨 효과는 단정하지 않습니다.",
                     "- **확인할 자료:** 해당 날짜의 재고·품절 기록, 판매 가격·프로모션, 영업 여부·휴점, 상품 변경 및 행사 기록, 예보 발급 시각이 있는 날씨 자료가 필요합니다.",
                     f"- **개선 방향:** {improvement} 이 실패 테스트 행에 맞춰 조정한 결과를 기존 테스트 개선으로 재보고하지 않습니다.", ""]
        else:
            text += ["이 수치는 선택한 단일 상품·단일 7일 구간의 결과입니다. 날씨 사용 여부의 인과 효과나 한국 매장의 정확도를 보여주지 않습니다.", ""]
    text += ["## 재현", "", "저장소 루트에서 `python -m ml.analyze_cases --no-plots`로 JSON·CSV·설명을 재생성합니다. 모델 실행·재학습은 없습니다. 차트까지 생성하려면 별도 문서용 환경에 `matplotlib==3.11.2`를 설치하고 `--no-plots`를 빼세요. 기존 고정 추론 환경을 변경할 필요가 없습니다. `--output-dir`로 다른 폴더에 저장할 수 있습니다.", "", "입력·현재 API 기준선 함수·분석 코드 해시는 `cases.json`과 `failure-cases.json`에 기록합니다. 원본 평가 ZIP/멤버 해시를 확인하며, 미래 actuals는 추론 입력 파일에 합치지 않습니다. 수치 비교는 JSON/CSV를 기준으로 하고 그림은 설명용입니다.", ""]
    return "\n".join(text)


def plot_cases(cases, directory):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.hashsalt": "tft-three-cases-v1"})
    figure, axes = plt.subplots(3, 1, figsize=(10.5, 11), constrained_layout=True)
    names = {"normal": "Typical relative variation", "volatile": "High relative variation", "zero": "Zero-sales history"}
    for axis, case in zip(axes, cases, strict=True):
        x = list(range(7)); points = case["points"]
        axis.fill_between(x, [p["p10"] for p in points], [p["p90"] for p in points], color="#3b82f6", alpha=.17, label="TFT P10-P90")
        axis.plot(x, [p["p50"] for p in points], color="#2563eb", linewidth=2, marker="o", markersize=4, label="TFT P50")
        axis.plot(x, [p["baseline_p50"] for p in points], color="#d97706", linestyle="--", linewidth=1.7, label="API weekday P50 (56 days)")
        axis.plot(x, [p["actual"] for p in points], color="#111827", linewidth=2, marker="s", markersize=4, label="Actual observed sales")
        axis.set_title(f"{names[case['category']]} | Walmart store {case['store_nbr']}, item {case['item_nbr']}", loc="left", weight="bold", fontsize=12)
        axis.set_xticks(x, [p["date"][5:] for p in points]); axis.set_ylabel("Units sold")
        axis.set_ylim(bottom=0)
        if case["category"] == "zero":
            axis.set_ylim(0, max(1, axis.get_ylim()[1]))
            if all(point[key] == 0 for point in points for key in ("actual", "p50", "baseline_p50")):
                axis.text(.5, .4, "Actual, TFT P50 and baseline P50 are all zero", transform=axis.transAxes,
                          ha="center", fontsize=10, color="#374151")
        axis.grid(axis="y", alpha=.2); axis.spines[["top", "right"]].set_visible(False)
        axis.legend(loc="upper left", ncol=2, fontsize=8, frameon=False)
        score = case["metrics"]
        axis.text(.99, .96, f"7-day MAE: TFT {score['TFT']['MAE']:.2f} | API {score['API_baseline']['MAE']:.2f}", transform=axis.transAxes, ha="right", va="top", fontsize=9)
    figure.suptitle("Three history-selected examples: observed sales vs forecasts", fontsize=16, weight="bold")
    figure.supxlabel("Forecast dates in 2014 | Cases are illustrative; vertical scales differ.\nCPU references, persistence weather; nominal P10-P90 range is not a guarantee.", fontsize=10)
    directory.mkdir(parents=True, exist_ok=True)
    figure.savefig(directory / "cases.png", dpi=180, metadata={"Software": "ml.analyze_cases"})
    figure.savefig(directory / "cases.svg", metadata={"Date": None, "Creator": "ml.analyze_cases"})
    plt.close(figure)
    return matplotlib.__version__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "ml/presentation")
    parser.add_argument("--archive", type=Path, default=ROOT / "ml/evaluation/tft-evaluation-data.zip")
    parser.add_argument("--no-plots", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    baseline, source = exact_api_baseline()
    source["path"] = "apps/api/app/forecasting.py"
    cases = sample_cases(baseline)
    failures = failure_cases(args.archive, baseline)
    common = {"analysis_script_sha256": sha(Path(__file__)), "api_baseline_source": source,
              "python": platform.python_version(), "sales_unit": "units sold per day", "model_executed": False}
    for filename, payload, failure in [("cases", cases, False), ("failure-cases", failures, True)]:
        write_json(args.output_dir / (filename + ".json"), {**common, **payload})
        save_csv(args.output_dir / (filename + ".csv"), payload["cases"])
        (args.output_dir / (filename + ".md")).write_text(summaries(payload["cases"], failure), encoding="utf-8", newline="\n")
    plotting = None if args.no_plots else plot_cases(cases["cases"], args.output_dir / "figures")
    print(json.dumps({"selected": [{"category": c["category"], "store": c["store_nbr"], "item": c["item_nbr"]} for c in cases["cases"]],
                      "failures": [{"store": c["store_nbr"], "item": c["item_nbr"], "as_of": c["as_of"], "MAE": c["metrics"]["TFT"]["MAE"]} for c in failures["cases"]],
                      "strict_windows": failures["eligible_windows"], "matplotlib": plotting}, indent=2))


if __name__ == "__main__":
    main()

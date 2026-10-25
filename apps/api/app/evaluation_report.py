"""Read versioned offline metrics; never train or score live merchant data."""

import csv
from datetime import date, timedelta
import hashlib
import io
import json
import math
from pathlib import Path


ML_ROOT = Path(__file__).resolve().parents[3] / "ml"
MODELS = {
    "TFT_persistence_postprocessed": "TFT · 날씨 지속 가정",
    "current_API_weekday_baseline": "평가 당시 API 요일 기준선",
    "TFT_no_weather_supplied": "날씨 제거 TFT",
}
SUBSETS = (
    (
        "full_original_test",
        "원본 테스트 전체",
        "full_original_test",
        "평가 대상 200개 매장·상품 조합의 관측된 7일 예측을 비교합니다.",
    ),
    (
        "strict_56_observed_history",
        "최근 2달 모두 관측",
        "strict_56_observed_history",
        "직전 2달 판매가 모두 관측되어 현재 추론 어댑터의 입력 조건을 충족하는 부분집합입니다.",
    ),
)


def evaluation_report():
    raw = (ML_ROOT / "evaluation/api-comparison/metrics.csv").read_bytes()
    manifest = json.loads(
        (ML_ROOT / "evaluation/api-comparison/manifest.json").read_text(
            encoding="utf-8"
        )
    )
    config = json.loads(
        (ML_ROOT / "evaluation/run_config.json").read_text(encoding="utf-8")
    )
    ablation = json.loads(
        (ML_ROOT / "ablation/completed-run.json").read_text(encoding="utf-8")
    )
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    expected = {(subset[0], model) for subset in SUBSETS for model in MODELS}
    indexed = {(row["subset"], row["model"]): row for row in rows}
    if len(rows) != len(expected) or set(indexed) != expected:
        raise ValueError("Offline metric identities are incomplete or duplicated")
    if (
        manifest["quantiles"] != [0.1, 0.5, 0.9]
        or manifest["forecast_days"] != 7
        or manifest["baseline_lookback_days"] != 84
        or config["ENCODER_DAYS"] != 56
        or config["HORIZON"] != 7
        or config["future_weather_mode"] != "persistence"
        or ablation["status"] != "trained_and_evaluated"
        or ablation["matched_reference_rows"] is not True
        or ablation["test_used_for_training"] is not False
        or ablation["seed"] != config["SEED"]
    ):
        raise ValueError("Offline evaluation protocol differs from the report")

    def number(row, key):
        value = float(row[key])
        if not math.isfinite(value) or value < 0:
            raise ValueError("Offline metric is not finite and nonnegative")
        return value

    subsets = []
    for subset_id, label, prefix, description in SUBSETS:
        n, windows, series = (
            manifest[f"{prefix}_{key}"] for key in ("rows", "windows", "series")
        )
        if (
            any(type(value) is not int or value <= 0 for value in (n, windows, series))
            or n != windows * 7
        ):
            raise ValueError("Offline evaluation counts are invalid")
        metrics = []
        for model, model_label in MODELS.items():
            row = indexed[(subset_id, model)]
            if int(row["n"]) != n or int(row["windows"]) != windows:
                raise ValueError("Models were not scored on the same row counts")
            coverage = number(row, "interval_coverage")
            if coverage > 1:
                raise ValueError("Offline interval coverage exceeds one")
            metrics.append(
                {
                    "model": model,
                    "label": model_label,
                    "mae": number(row, "MAE"),
                    "wape": number(row, "WAPE") if row["WAPE"] else None,
                    "mean_pinball": number(row, "mean_pinball_3"),
                    "coverage": coverage,
                    "interval_width": number(row, "interval_width"),
                }
            )
        subsets.append(
            {
                "id": subset_id,
                "label": label,
                "description": description,
                "n": n,
                "windows": windows,
                "series": series,
                "metrics": metrics,
            }
        )

    test_start = date.fromisoformat(config["validation_end"].split()[0]) + timedelta(
        days=1
    )
    test_end = date.fromisoformat(config["end_date"].split()[0])
    if test_start > test_end:
        raise ValueError("Offline test dates are reversed")
    return {
        "report_id": hashlib.sha256(raw).hexdigest()[:12],
        "title": "같은 평가 행에서 비교한 예측 성능",
        "dataset": "Walmart Recruiting — Sales in Stormy Weather",
        "source": "ml/evaluation/api-comparison/metrics.csv",
        "evaluation_period": {
            "start": test_start.isoformat(),
            "end": test_end.isoformat(),
        },
        "method": {
            "history_days": config["ENCODER_DAYS"],
            "baseline_lookback_days": manifest["baseline_lookback_days"],
            "forecast_days": manifest["forecast_days"],
            "quantiles": manifest["quantiles"],
            "seed": config["SEED"],
            "weather_strategy": "persistence",
            "sampling": "기준일을 7일씩 옮겨 다음 7일을 예측한 저장 결과입니다. 현재 화면에서 재학습하거나 전체 테스트를 재추론하지 않습니다.",
        },
        "subsets": subsets,
        "limitations": [
            "TFT는 최근 2달, 평가 당시 API 기준선은 최대 12주 이력을 사용합니다. 같은 평가 행의 비교이며 입력 일수가 같다는 뜻은 아닙니다. 직접 예측 체험의 기준선은 제공된 2달만 사용합니다.",
            "seed 42 한 번의 실험입니다. 날씨 포함 모델(A100·Python 3.13)과 제거 모델(RTX 5060·Python 3.11)의 환경 차이가 있어 모델 간 차이를 날씨의 순수한 인과 효과로 단정할 수 없습니다.",
            "학습 구간에서 선택한 200개 매장·상품 조합의 과거 판매 평가입니다. 실제 발급 예보, 한국 점포 성능, 품절로 놓친 수요와 매출·폐기 개선은 검증하지 않았습니다.",
        ],
    }

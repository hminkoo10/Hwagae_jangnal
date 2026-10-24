"""Only complete, finite, matched offline evidence may reach the UI."""

import csv
import io
import json
import shutil

from fastapi.testclient import TestClient
import pytest

from app import evaluation_report as report_module
from app.main import create_app


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    root = tmp_path / "ml"
    for relative in (
        "evaluation/api-comparison/metrics.csv",
        "evaluation/api-comparison/manifest.json",
        "evaluation/run_config.json",
        "ablation/completed-run.json",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(report_module.ML_ROOT / relative, target)
    monkeypatch.setattr(report_module, "ML_ROOT", root)
    return root


def test_report_is_available_without_a_model_worker(tmp_path, monkeypatch):
    monkeypatch.delenv("TFT_CHECKPOINT_PATH", raising=False)
    application = create_app(tmp_path / "evaluation.sqlite3")
    with TestClient(application) as client:
        login = client.post(
            "/auth/login",
            json={"email": "staff@hwagae.local", "password": "hwagae-demo"},
        )
        auth = {"Authorization": f"Bearer {login.json()['token']}"}
        assert (
            client.get("/model-demo", headers=auth).json()["runtime"]["status"]
            == "disabled"
        )
        response = client.get("/model-demo/evaluation", headers=auth)
    assert response.status_code == 200
    report = response.json()
    assert report["evaluation_period"] == {"start": "2014-09-06", "end": "2014-10-31"}
    assert report["method"]["history_days"] == 56
    assert report["method"]["baseline_lookback_days"] == 84
    assert report["method"]["quantiles"] == [0.1, 0.5, 0.9]
    assert [(s["n"], s["windows"], s["series"]) for s in report["subsets"]] == [
        (7973, 1139, 200),
        (1701, 243, 55),
    ]
    full = {m["model"]: m for m in report["subsets"][0]["metrics"]}
    tft = full["TFT_persistence_postprocessed"]
    baseline = full["current_API_weekday_baseline"]
    assert tft["mae"] == 5.5220910746966
    assert tft["wape"] == 0.30944357702105696
    assert tft["coverage"] == 0.8458547598143735
    assert (baseline["mae"] - tft["mae"]) / baseline["mae"] == pytest.approx(
        0.069783, abs=1e-6
    )
    assert "local_delivery_path" not in response.text
    assert "C:\\" not in response.text
    assert str(report_module.ML_ROOT) not in response.text
    assert len(report["limitations"]) == 3


@pytest.mark.parametrize(
    "corruption",
    ["nan", "infinite", "negative", "coverage", "count", "duplicate", "missing"],
)
def test_corrupt_metrics_are_rejected(evidence, corruption):
    path = evidence / "evaluation/api-comparison/metrics.csv"
    rows = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"))))
    fields = list(rows[0])
    if corruption == "duplicate":
        rows[-1] = dict(rows[0])
    elif corruption == "missing":
        rows.pop()
    else:
        key, value = {
            "nan": ("MAE", "NaN"),
            "infinite": ("WAPE", "inf"),
            "negative": ("mean_pinball_3", "-1"),
            "coverage": ("interval_coverage", "1.01"),
            "count": ("n", "7972"),
        }[corruption]
        rows[0][key] = value
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    with pytest.raises(ValueError):
        report_module.evaluation_report()


@pytest.mark.parametrize(
    "key,value",
    [("matched_reference_rows", False), ("test_used_for_training", True), ("seed", 43)],
)
def test_changed_experiment_protocol_is_rejected(evidence, key, value):
    path = evidence / "ablation/completed-run.json"
    protocol = json.loads(path.read_text(encoding="utf-8"))
    protocol[key] = value
    path.write_text(json.dumps(protocol), encoding="utf-8")
    with pytest.raises(ValueError):
        report_module.evaluation_report()

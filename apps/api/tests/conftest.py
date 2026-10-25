"""API tests opt into subprocesses explicitly; never warm local model bundles."""

from pathlib import Path

import pytest

from app.model_runtime import ModelRuntime


@pytest.fixture(autouse=True)
def disable_ambient_model_processes(monkeypatch):
    # Lifecycle tests use isolated repo roots and still exercise real processes.
    # Default app instances should not load a developer's local checkpoints.
    configuration = ModelRuntime._configuration
    project_root = Path(__file__).resolve().parents[3]

    def unit_configuration(runtime):
        if runtime._root == project_root:
            return None
        return configuration(runtime)

    monkeypatch.setattr(ModelRuntime, "_configuration", unit_configuration)


@pytest.fixture(autouse=True)
def weekday_forecasts_without_model(monkeypatch):
    # Unit tests have no TFT process; stores without a saved choice use the baseline here.
    monkeypatch.setattr("app.main.DEFAULT_FORECAST_PROVIDER", "weekday")

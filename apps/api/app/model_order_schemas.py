"""Strict personal planning inputs; model forecasts remain server-owned."""

from datetime import date
from typing import Annotated

from pydantic import Field, field_validator

from app.schemas import Inventory, OrderLine, Payload, ProductSettings

Version = Annotated[int, Field(strict=True, ge=0, le=2_147_483_647)]


class PlanningItem(ProductSettings):
    product_id: str = Field(min_length=1, max_length=80)
    stock: Inventory | None

    @field_validator("stock", mode="before")
    @classmethod
    def require_explicit_confirmation(cls, value):
        # Literal[True] alone also accepts integer 1; require a real JSON boolean.
        if isinstance(value, dict) and value.get("incoming_confirmed") is not True:
            raise ValueError("입고 예정 유무를 명시적으로 확인하세요.")
        return value


class PlanningUpdate(Payload):
    revision: Version
    items: list[PlanningItem] = Field(min_length=1, max_length=50)


class ModelRecommendationRequest(Payload):
    forecast_id: str = Field(min_length=1, max_length=80)
    revision: Version
    order_date: date | None = None


class ModelOrderUpdate(Payload):
    version: Version
    lines: list[OrderLine] = Field(min_length=1, max_length=50)


class ModelOrderConfirm(Payload):
    version: Version

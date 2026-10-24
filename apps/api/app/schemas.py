"""API boundary validation, shared with the model adapter."""

from datetime import date
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Count = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(Payload):
    email: str = Field(max_length=200)
    password: str = Field(min_length=1, max_length=200)


class Sale(Payload):
    date: date
    product_id: str = Field(min_length=1, max_length=80)
    units_sold: Count


class SalesBatch(Payload):
    rows: list[Sale] = Field(min_length=1, max_length=10000)


class ProductSettings(Payload):
    price: Count
    cost: Count
    lead_days: int = Field(strict=True, ge=1, le=30)
    shelf_days: int = Field(strict=True, ge=1, le=365)
    review_days: int = Field(strict=True, ge=1, le=7)


class ForecastSettings(Payload):
    provider: Literal["weekday", "merchant_tft"]


class StoreInput(Payload):
    name: str = Field(min_length=1, max_length=80)
    city: str = Field(min_length=1, max_length=80)
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    timezone: str = Field(default="Asia/Seoul", min_length=1, max_length=80)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("매장 시간대는 유효한 IANA 이름으로 입력하세요.") from None
        return value

    @field_validator("name", "city")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("공백만 입력할 수 없습니다.")
        return value.strip()


class ProductInput(ProductSettings):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=40)
    supplier: str = Field(min_length=1, max_length=80)

    @field_validator("name", "category", "supplier")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("공백만 입력할 수 없습니다.")
        return value.strip()


class StockBatch(Payload):
    quantity: Count
    expires_on: date


class Incoming(StockBatch):
    arrives_on: date

    @model_validator(mode="after")
    def check_dates(self):
        if self.expires_on < self.arrives_on:
            raise ValueError("입고일보다 만료일이 빠릅니다.")
        return self


class Inventory(Payload):
    batches: list[StockBatch] = Field(max_length=100)
    incoming: list[Incoming] = Field(default_factory=list, max_length=100)
    incoming_confirmed: Literal[True]


class RecommendationRequest(Payload):
    forecast_id: str
    order_date: date | None = None


class OrderLine(Payload):
    product_id: str
    # An order can cover seven days of demand, each capped at 1,000,000 units.
    quantity: int = Field(strict=True, ge=0, le=7_000_000)


class OrderRequest(Payload):
    recommendation_id: str
    lines: list[OrderLine] = Field(min_length=1, max_length=50)


class Point(Payload):
    date: date
    p10: float = Field(ge=0, le=1_000_000, allow_inf_nan=False)
    p50: float = Field(ge=0, le=1_000_000, allow_inf_nan=False)
    p90: float = Field(ge=0, le=1_000_000, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered_quantiles(self):
        if not self.p10 <= self.p50 <= self.p90:
            raise ValueError("분위수 순서가 잘못되었습니다.")
        return self

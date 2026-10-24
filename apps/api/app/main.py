"""Minimal API entry point for local development."""

import os
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="Hwagae Jangnal API",
    description="초기 개발 환경입니다. 발주 및 예측 API는 아직 구현하지 않았습니다.",
    version="0.1.0",
)

origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000"
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["hwagae-jangnal-api"] = "hwagae-jangnal-api"
    version: str = "0.1.0"


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    """Confirm that the API process is responding; no external services are checked."""
    return HealthResponse()

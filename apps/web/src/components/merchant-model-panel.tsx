"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type MerchantForecastSettings } from "@/lib/api";
import styles from "./merchant-model-panel.module.css";

export function MerchantModelPanel({
  token,
  storeId,
  asOf,
  today,
  weatherMode,
  busy,
  onSessionExpired,
  onAvailableFrom,
}: {
  token: string;
  storeId: string;
  asOf: string;
  today: string;
  weatherMode?: string;
  busy: boolean;
  onSessionExpired: () => void;
  onAvailableFrom?: (date: string) => void;
}) {
  const [settings, setSettings] = useState<MerchantForecastSettings | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<MerchantForecastSettings>(
      `/stores/${storeId}/forecast-settings`,
      token,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setSettings(value);
        onAvailableFrom?.(value.history_available_from ?? "");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setError(
          error instanceof Error
            ? error.message
            : "예측 정보를 확인하지 못했어요.",
        );
        if (error instanceof ApiError && error.status === 401)
          onSessionExpired();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, storeId, reload, onSessionExpired, onAvailableFrom]);

  const historical = !!asOf && asOf < today;
  const weatherLabel =
    weatherMode === "live_forecast"
      ? "앞으로 7일 날씨 사용"
      : weatherMode === "historical_reanalysis"
        ? "과거 날씨 자료 사용"
        : weatherMode === "recent_weather"
          ? "최근 날씨를 대입한 예측"
          : "날씨 자료 확인 중";
  const modelLabel =
    settings?.model_kind === "walmart"
      ? "Walmart 자료로 배운 AI · 시험 중"
      : settings?.model_kind === "dimigo_store"
        ? "디미고 매점 판매로 배운 AI"
        : "날씨 반영 AI · 시험 중";
  return (
    <details
      className={styles.panel}
      aria-label="매장 예측 모델"
      aria-busy={loading}
    >
      <summary className={styles.eyebrow}>판매량을 예상하는 방법</summary>
      <div className={styles.heading}>
        <h2>
          {historical
            ? "과거 판매·날씨로 7일을 돌아봐요"
            : "실제 날씨로, 다음 7일을 예측해요"}
        </h2>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="text-button"
            disabled={loading || busy}
            onClick={() => setReload((value) => value + 1)}
          >
            다시 확인
          </button>
        </div>
      )}
      {settings ? (
        <>
          <div className={styles.badges}>
            <span className={styles.blue}>{weatherLabel}</span>
            <span className={styles.amber}>{modelLabel}</span>
            <span
              className={
                settings.runtime.status === "ready"
                  ? styles.green
                  : styles.amber
              }
            >
              {settings.runtime.status === "ready"
                ? "예측 준비 완료"
                : "연결 상태 확인 필요"}
            </span>
          </div>
          <p className={styles.description}>
            최근 {settings.requirements.history_days}일 판매와{" "}
            {settings.requirements.horizon_days}일{" "}
            {historical ? "날씨 기록" : "날씨 예보"}로 상품별 판매를 예측해요.
          </p>
          {settings.history_available_from && settings.history_available_to && (
            <p className={styles.note}>
              이 기간의 날짜를 골라 예측할 수 있어요:{" "}
              {settings.history_available_from} ~{" "}
              {settings.history_available_to}. 고른 날짜까지의 판매 기록을
              사용해요.
            </p>
          )}
          {settings.runtime.status !== "ready" && (
            <div className={styles.runtime} role="status">
              <span>{settings.runtime.message}</span>
              <button
                className="text-button"
                disabled={loading || busy}
                onClick={() => setReload((value) => value + 1)}
              >
                상태 새로고침
              </button>
            </div>
          )}
          {settings.data_note && (
            <details className={styles.dataGuide}>
              <summary>사용한 자료 자세히 보기</summary>
              <p className={styles.note}>{settings.data_note}</p>
            </details>
          )}
        </>
      ) : loading ? (
        <p className={styles.description}>예측 정보를 확인하고 있어요…</p>
      ) : null}
    </details>
  );
}

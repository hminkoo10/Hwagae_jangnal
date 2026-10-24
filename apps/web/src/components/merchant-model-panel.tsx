"use client";

import { Select } from "./controls";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type MerchantForecastSettings } from "@/lib/api";
import styles from "./merchant-model-panel.module.css";

export function MerchantModelPanel({
  token,
  storeId,
  asOf,
  today,
  weatherMode,
  owner,
  busy,
  onChanged,
  onBusyChange,
  onSessionExpired,
}: {
  token: string;
  storeId: string;
  asOf: string;
  today: string;
  weatherMode?: string;
  owner: boolean;
  busy: boolean;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
  onSessionExpired: () => void;
}) {
  const [settings, setSettings] = useState<MerchantForecastSettings | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
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
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setError(
          error instanceof Error
            ? error.message
            : "모델 설정을 확인하지 못했어요.",
        );
        if (error instanceof ApiError && error.status === 401)
          onSessionExpired();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, storeId, reload, onSessionExpired]);

  async function change(provider: MerchantForecastSettings["provider"]) {
    if (!settings || provider === settings.provider || busy || saving) return;
    const controller = new AbortController();
    mutation.current = controller;
    setSaving(true);
    onBusyChange(true);
    setError("");
    try {
      const result = await api<MerchantForecastSettings>(
        `/stores/${storeId}/forecast-settings`,
        token,
        {
          method: "PUT",
          signal: controller.signal,
          body: JSON.stringify({ provider }),
        },
      );
      if (controller.signal.aborted) return;
      setSettings(result);
      onChanged();
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(
        error instanceof Error ? error.message : "모델을 변경하지 못했어요.",
      );
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
    } finally {
      if (!controller.signal.aborted) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  }

  const tft = settings?.provider === "merchant_tft";
  const historical = !!asOf && asOf < today;
  const weatherLabel =
    weatherMode === "live_forecast"
      ? "앞으로 7일 날씨 사용"
      : weatherMode === "historical_reanalysis"
        ? "과거 날씨 자료 사용"
        : weatherMode === "recent_weather"
          ? "최근 날씨를 대입한 예측"
          : "날씨 자료 확인 중";
  return (
    <details
      className={styles.panel}
      aria-label="매장 예측 모델"
      aria-busy={loading || saving}
    >
      <summary className={styles.eyebrow}>판매량을 예상하는 방법</summary>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>우리 매장 판매 예측</span>
          <h2>
            {tft
              ? historical
                ? "과거 판매·날씨로 7일을 돌아봐요"
                : "실제 날씨로, 다음 7일을 예측해요"
              : "판매 기록으로 내일을 준비해요"}
          </h2>
        </div>
        <label className={styles.selector}>
          예측 방식
          <Select
            aria-label="매장 예측 모델"
            value={settings?.provider ?? "weekday"}
            disabled={!settings || !owner || busy || loading || saving}
            onChange={(event) =>
              void change(
                event.target.value as MerchantForecastSettings["provider"],
              )
            }
          >
            <option value="weekday">요일별 판매 흐름</option>
            <option value="merchant_tft">날씨 반영 AI</option>
          </Select>
        </label>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="text-button"
            disabled={loading || saving || busy}
            onClick={() => setReload((value) => value + 1)}
          >
            설정 다시 확인
          </button>
        </div>
      )}
      {settings ? (
        <>
          <div className={styles.badges}>
            <span className={tft ? styles.blue : styles.neutral}>
              {tft ? weatherLabel : "날씨 미반영"}
            </span>
            {tft && (
              <span className={styles.amber}>
                {settings.model_kind === "walmart"
                  ? "Walmart 판매 자료로 배운 AI · 시험 적용 중"
                  : "가상 판매 자료로 배운 AI · 정확도 확인 중"}
              </span>
            )}
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
            {settings.requirements.history_days}일 판매 기록을 상품별로
            확인해요.{" "}
            {tft
              ? "실제 매장의 판매 정확도는 아직 검증하지 않았어요."
              : "같은 요일의 판매 흐름을 기준으로 계산해요."}
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
                disabled={loading || saving || busy}
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
          {!owner && (
            <p className={styles.note}>예측 방식은 점주가 변경할 수 있어요.</p>
          )}
        </>
      ) : loading ? (
        <p className={styles.description}>모델 연결을 확인하고 있어요…</p>
      ) : null}
    </details>
  );
}

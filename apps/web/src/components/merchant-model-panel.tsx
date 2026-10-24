"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type MerchantForecastSettings,
  type Store,
} from "@/lib/api";
import { Icon, Modal } from "./ui";
import styles from "./merchant-model-panel.module.css";

export function MerchantModelPanel({
  token,
  storeId,
  owner,
  busy,
  onChanged,
  onBusyChange,
  onSessionExpired,
}: {
  token: string;
  storeId: string;
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
  return (
    <section
      className={styles.panel}
      aria-label="매장 예측 모델"
      aria-busy={loading || saving}
    >
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>우리 매장 예측 모델</span>
          <h2>
            {tft
              ? "실제 날씨로, 다음 7일을 예측해요"
              : "판매 기록으로 내일을 준비해요"}
          </h2>
        </div>
        <label className={styles.selector}>
          예측 방식
          <select
            aria-label="매장 예측 모델"
            value={settings?.provider ?? "weekday"}
            disabled={!settings || !owner || busy || loading || saving}
            onChange={(event) =>
              void change(
                event.target.value as MerchantForecastSettings["provider"],
              )
            }
          >
            <option value="weekday">요일 기준선</option>
            <option value="merchant_tft">날씨 반영 TFT · 실험</option>
          </select>
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
              {tft ? "실제 7일 예보 입력" : "날씨 미반영"}
            </span>
            {tft && (
              <span className={styles.amber}>합성 자료 학습 · 실험 모델</span>
            )}
            <span
              className={
                settings.runtime.status === "ready"
                  ? styles.green
                  : styles.amber
              }
            >
              {settings.runtime.status === "ready"
                ? "모델 준비됨"
                : "모델 준비 확인 필요"}
            </span>
          </div>
          <p className={styles.description}>
            {settings.requirements.history_days}일 판매 기록을 상품별로
            확인해요.{" "}
            {tft
              ? "실제 매장의 판매 정확도는 아직 검증하지 않았어요."
              : "같은 요일의 판매 흐름을 기준으로 계산해요."}
          </p>
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
              <summary>데이터 안내</summary>
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
    </section>
  );
}

const locations = {
  seoul: { city: "서울", latitude: "37.5665", longitude: "126.9780" },
  busan: { city: "부산", latitude: "35.1796", longitude: "129.0756" },
  gwangju: { city: "광주", latitude: "35.1595", longitude: "126.8526" },
};

export function TestWeatherStoreModal({
  token,
  onSaved,
  onClose,
  onSessionExpired,
}: {
  token: string;
  onSaved: (store: Store) => Promise<void>;
  onClose: () => void;
  onSessionExpired: () => void;
}) {
  const [preset, setPreset] = useState("seoul");
  const [name, setName] = useState("서울 날씨 테스트 매장");
  const [location, setLocation] = useState(locations.seoul);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Store | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const store =
        created ??
        (await api<Store>("/stores/test-weather", token, {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            name: name.trim(),
            city: location.city.trim(),
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
          }),
        }));
      if (controller.signal.aborted) return;
      setCreated(store);
      await onSaved(store);
      if (!controller.signal.aborted) onClose();
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(
        error instanceof Error
          ? error.message
          : "테스트 매장을 만들지 못했어요.",
      );
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <Modal
      title="실시간 TFT 테스트 매장 만들기"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        <p className={styles.description}>
          지역을 고르면 5개 상품과 56일 판매 기록을 준비해요. 선택한 위치의 실제
          예보로 예측하고, 재고를 바꿔 발주량까지 확인하세요.
        </p>
        <div className={styles.badges}>
          <span className={styles.neutral}>가상 판매·재고</span>
          <span className={styles.blue}>실제 날씨 예보</span>
          <span className={styles.amber}>합성 학습 TFT</span>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <fieldset className={styles.fields} disabled={busy || !!created}>
          <label>
            날씨를 확인할 지역
            <select
              value={preset}
              onChange={(event) => {
                const value = event.target.value;
                setPreset(value);
                if (value !== "custom") {
                  const next = locations[value as keyof typeof locations];
                  setLocation(next);
                  setName(`${next.city} 날씨 테스트 매장`);
                }
              }}
            >
              <option value="seoul">서울</option>
              <option value="busan">부산</option>
              <option value="gwangju">광주</option>
              <option value="custom">직접 위치 입력</option>
            </select>
          </label>
          <label>
            테스트 매장명
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {preset === "custom" && (
            <label>
              지역 이름
              <input
                required
                maxLength={80}
                value={location.city}
                onChange={(event) =>
                  setLocation({ ...location, city: event.target.value })
                }
              />
            </label>
          )}
          <div className="form-grid">
            <label>
              위도
              <input
                type="number"
                step="any"
                min="-90"
                max="90"
                required
                readOnly={preset !== "custom"}
                value={location.latitude}
                onChange={(event) =>
                  setLocation({ ...location, latitude: event.target.value })
                }
              />
            </label>
            <label>
              경도
              <input
                type="number"
                step="any"
                min="-180"
                max="180"
                required
                readOnly={preset !== "custom"}
                value={location.longitude}
                onChange={(event) =>
                  setLocation({ ...location, longitude: event.target.value })
                }
              />
            </label>
          </div>
        </fieldset>
        <p className={styles.note}>
          시연용 상품·판매·재고가 있는 새 매장을 만들어요. 실제 업체로 주문이
          전송되지는 않아요.
        </p>
        <button
          className="button primary"
          disabled={busy || !name.trim() || !location.city.trim()}
        >
          <Icon name="forecast" size={17} />
          {busy
            ? "테스트 매장 준비 중…"
            : created
              ? "생성한 매장 열기"
              : "만들고 7일 예측 보기"}
        </button>
      </form>
    </Modal>
  );
}

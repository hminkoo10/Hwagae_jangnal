"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  shortDate,
  units,
  type ModelDemoForecast,
  type ModelDemoStatus,
  type ProductForecast,
} from "@/lib/api";
import { Icon } from "./ui";
import styles from "./model-demo.module.css";

const statusLabels: Record<ModelDemoStatus["runtime"]["status"], string> = {
  disabled: "체험 준비 전",
  starting: "모델을 불러오는 중",
  ready: "추론 준비 완료",
  unavailable: "모델 연결 확인 필요",
};

function dateRange(dates: string[]) {
  return dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "—";
}

function ComparisonChart({
  forecast,
  baseline,
}: {
  forecast: ProductForecast;
  baseline?: ProductForecast;
}) {
  const points = forecast.points;
  if (!points.length) return null;
  const baselineByDate = new Map(
    baseline?.points.map((point) => [point.date, point.p50]) ?? [],
  );
  const max =
    Math.max(
      1,
      ...points.map((point) => point.p90),
      ...baselineByDate.values(),
    ) * 1.15;
  const x = (index: number) =>
    47 + (index * 560) / Math.max(points.length - 1, 1);
  const y = (value: number) => 198 - (value / max) * 158;
  const path = (key: "p10" | "p50" | "p90") =>
    points
      .map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`)
      .join(" ");
  const band =
    path("p90") +
    [...points]
      .reverse()
      .map(
        (point, index) => ` L${x(points.length - 1 - index)},${y(point.p10)}`,
      )
      .join("") +
    " Z";
  const hasBaseline = points.every((point) => baselineByDate.has(point.date));
  const baselinePath = hasBaseline
    ? points
        .map(
          (point, index) =>
            `${index ? "L" : "M"}${x(index)},${y(baselineByDate.get(point.date)!)}`,
        )
        .join(" ")
    : null;
  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox="0 0 650 240"
        role="img"
        aria-label={`${forecast.name}, TFT의 7일 P10~P90 범위와 P50, 요일 기준선 P50 비교. 정확한 수량은 아래 표에 있습니다.`}
      >
        {[0, 1, 2, 3].map((level) => (
          <g key={level}>
            <line
              x1="47"
              x2="607"
              y1={y((max * level) / 3)}
              y2={y((max * level) / 3)}
              className={styles.gridLine}
            />
            <text
              x="36"
              y={y((max * level) / 3) + 4}
              textAnchor="end"
              className={styles.chartText}
            >
              {units((max * level) / 3)}
            </text>
          </g>
        ))}
        <path d={band} className={styles.band} />
        {baselinePath && (
          <path d={baselinePath} className={styles.baselineLine} />
        )}
        <path d={path("p50")} className={styles.modelLine} />
        {points.map((point, index) => (
          <g key={point.date}>
            <circle
              cx={x(index)}
              cy={y(point.p50)}
              r="3.5"
              className={styles.chartPoint}
            >
              <title>
                {point.date} TFT P50 {units(point.p50)}개
              </title>
            </circle>
            <text
              x={x(index)}
              y="226"
              textAnchor="middle"
              className={styles.chartText}
            >
              {shortDate(point.date)}
            </text>
          </g>
        ))}
      </svg>
      <div className={styles.legend}>
        <span>
          <i className={styles.modelKey} />
          TFT P50
        </span>
        <span>
          <i className={styles.bandKey} />
          TFT P10~P90
        </span>
        {hasBaseline && (
          <span>
            <i className={styles.baselineKey} />
            요일 기준선 P50
          </span>
        )}
      </div>
    </div>
  );
}

export function ModelDemo({
  token,
  onSessionExpired,
}: {
  token: string;
  onSessionExpired: () => void;
}) {
  const [metadata, setMetadata] = useState<ModelDemoStatus | null>(null);
  const [result, setResult] = useState<ModelDemoForecast | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  const checkStatus = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    setRunning(false);
    setResult(null);
    setError("");
    try {
      const next = await api<ModelDemoStatus>("/model-demo", token, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setMetadata(next);
      setSelectedId((current) =>
        next.sample.products.some((product) => product.id === current)
          ? current
          : (next.sample.products[0]?.id ?? ""),
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setMetadata(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "모델 상태를 확인하지 못했어요.",
      );
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }, [token, onSessionExpired]);

  useEffect(() => {
    void checkStatus();
    return () => request.current?.abort();
  }, [checkStatus]);

  async function runForecast() {
    if (checking || running || metadata?.runtime.status !== "ready") return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRunning(true);
    setResult(null);
    setError("");
    try {
      const next = await api<ModelDemoForecast>("/model-demo/forecast", token, {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResult(next);
      setSelectedId((current) =>
        next.products.some((product) => product.product_id === current)
          ? current
          : (next.products[0]?.product_id ?? ""),
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error ? cause.message : "모델 추론에 실패했어요.",
      );
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  const sample = metadata?.sample;
  const selected = result?.products.find(
    (product) => product.product_id === selectedId,
  );
  const baseline = result?.baseline.products.find(
    (product) => product.product_id === selectedId,
  );
  const ready = metadata?.runtime.status === "ready";

  return (
    <div className={styles.page}>
      <section className={styles.introduction}>
        <div className={styles.introCopy}>
          <span className={styles.eyebrow}>TFT · 56일 기록 → 7일 예측</span>
          <h2>학습한 모델이 직접 예측해요</h2>
          <p>
            Walmart의 과거 판매·날씨 표본으로 TFT 신경망을 실행하고, 같은 판매
            기록으로 만든 요일 기준선과 나란히 확인하세요.
          </p>
        </div>
        <div className={styles.historyBadge}>
          <Icon name="forecast" size={24} />
          <strong>과거 데이터 재현</strong>
          <span>현재 매장과 분리된 체험</span>
        </div>
      </section>

      <section className={styles.runPanel} aria-label="TFT 실행 상태">
        <div className={styles.runtimeCopy}>
          <span
            className={`${styles.runtimeStatus} ${ready && !checking ? styles.ready : ""}`}
          >
            <i />
            {checking
              ? "상태 확인 중"
              : metadata
                ? statusLabels[metadata.runtime.status]
                : "상태 확인 필요"}
          </span>
          <p role="status" aria-live="polite">
            {running
              ? "학습된 TFT로 계산하고 있어요. 첫 실행은 모델을 읽는 시간이 필요할 수 있어요."
              : (metadata?.runtime.message ??
                "모델 실행 상태를 확인하고 있어요.")}
          </p>
        </div>
        <div className={styles.runActions}>
          <button
            className="button secondary"
            disabled={checking || running}
            onClick={() => void checkStatus()}
          >
            <Icon name="refresh" size={16} />
            상태 다시 확인
          </button>
          <button
            className="button primary"
            disabled={!ready || checking || running}
            onClick={() => void runForecast()}
          >
            {running ? (
              <span className="loading-spinner" />
            ) : (
              <Icon name="forecast" size={17} />
            )}
            {running
              ? "모델 계산 중…"
              : result
                ? "TFT 다시 실행"
                : "TFT 예측 실행"}
          </button>
        </div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          {error} 상태를 다시 확인한 후 실행해주세요.
        </div>
      )}

      {sample && (
        <>
          <section className={styles.sampleGrid} aria-label="공개 데이터 표본">
            <article>
              <span>예측 기준일</span>
              <strong>{sample.as_of}</strong>
              <small>이 날짜까지의 기록만 사용</small>
            </article>
            <article>
              <span>입력 판매 기록</span>
              <strong>
                {sample.history_days}일 · {sample.product_count}개 상품
              </strong>
              <small>
                {sample.history_start} ~ {sample.history_end}
              </small>
            </article>
            <article>
              <span>예측 대상 기간</span>
              <strong>{sample.dates.length}일</strong>
              <small>{dateRange(sample.dates)}</small>
            </article>
          </section>
          <div className={styles.sourceNote}>
            <Icon name="cloud" size={19} />
            <div>
              <strong>마지막 관측 날씨가 7일간 이어진다는 가정이에요.</strong>
              <p>{sample.note}</p>
              <small>
                {sample.title} · {sample.source}
              </small>
            </div>
          </div>
        </>
      )}

      {!result && !running && (
        <section className={styles.placeholder}>
          <span className={styles.placeholderIcon}>
            <Icon name="forecast" size={30} />
          </span>
          <h3>
            {error
              ? "예측 결과를 불러오지 못했어요"
              : "준비되면 모델을 실행해보세요"}
          </h3>
          <p>
            실행 결과의 P10·P50·P90과 요일 기준선을 표시해요.
            <br />
            실제 판매 정답을 포함하지 않아 정확도 지표는 제공하지 않아요.
          </p>
        </section>
      )}

      {running && (
        <div className={styles.pending} role="status">
          <span className="loading-spinner" />
          과거 56일의 기록에서 다음 7일의 판매 흐름을 계산하고 있어요.
        </div>
      )}

      {result && (
        <section className={styles.result} aria-label="TFT 실행 결과">
          <div className={styles.resultHeading}>
            <div>
              <span className={styles.eyebrow}>실제 모델 실행 결과</span>
              <h2>상품별 7일 예측 비교</h2>
              <p>
                {dateRange(result.dates)} · 기준일 {result.as_of}
              </p>
            </div>
            <label className={styles.productPicker}>
              상품 선택
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {result.products.map((product) => (
                  <option key={product.product_id} value={product.product_id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selected?.points.length ? (
            <>
              <ComparisonChart forecast={selected} baseline={baseline} />
              <div className={styles.comparisonNote}>
                파란색은 TFT, 점선은 요일 기준선의 예측이에요. 두 예측의 차이는
                성능 우열이나 오차를 뜻하지 않아요.
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <caption>
                    {selected.name} · 날짜별 판매량 예측 (단위: 개)
                  </caption>
                  <thead>
                    <tr>
                      <th>판매일</th>
                      <th className="number">TFT P10</th>
                      <th className="number">TFT P50</th>
                      <th className="number">TFT P90</th>
                      <th className="number">요일 기준선 P50</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.points.map((point) => {
                      const comparison = baseline?.points.find(
                        (item) => item.date === point.date,
                      );
                      return (
                        <tr key={point.date}>
                          <td>{point.date}</td>
                          <td className="number">{units(point.p10)}</td>
                          <td className={`number ${styles.centralValue}`}>
                            {units(point.p50)}
                          </td>
                          <td className="number">{units(point.p90)}</td>
                          <td className="number">
                            {comparison ? units(comparison.p50) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className={styles.placeholder}>
              <h3>이 상품의 예측을 만들 수 없어요</h3>
              <p>
                {selected?.reason ??
                  "표본의 판매 기록과 상품 연결을 확인해주세요."}
              </p>
            </div>
          )}

          <div className={styles.resultMeta}>
            <span>
              모델 {result.model.name} · {result.model.version}
            </span>
            <span>
              처리 시간{" "}
              {(result.elapsed_ms / 1000).toLocaleString("ko-KR", {
                maximumFractionDigits: 2,
              })}
              초
            </span>
            <span>
              실행{" "}
              {new Date(result.created_at).toLocaleString("ko-KR", {
                timeZone: "Asia/Seoul",
              })}
            </span>
          </div>
          <div className={styles.resultNote}>
            <p>{result.provenance}</p>
            <p>{result.note}</p>
            <p>
              P10~P90은 모델이 예측한 범위이며 정확도를 보장하지 않아요. 이 과거
              표본 결과는 현재 매장의 발주 계산에 사용하지 않아요.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

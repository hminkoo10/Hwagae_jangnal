"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ModelEvaluation } from "@/lib/api";
import { Icon } from "./ui";
import styles from "./model-evaluation.module.css";

const format = (value: number, digits = 2) =>
  value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
const percent = (value: number) => `${format(value * 100)}%`;

function reduction(model?: number, reference?: number) {
  if (model === undefined || reference === undefined || reference <= 0)
    return "—";
  const change = (1 - model / reference) * 100;
  if (change === 0) return "동일";
  return `${format(Math.abs(change))}% ${change > 0 ? "감소" : "증가"}`;
}

export function ModelEvaluationPanel({
  token,
  onSessionExpired,
}: {
  token: string;
  onSessionExpired: () => void;
}) {
  const [report, setReport] = useState<ModelEvaluation | null>(null);
  const [selectedId, setSelectedId] = useState("full_original_test");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setReport(null);
    setError("");
    try {
      const next = await api<ModelEvaluation>("/model-demo/evaluation", token, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setReport(next);
      setSelectedId((current) =>
        next.subsets.some((subset) => subset.id === current)
          ? current
          : (next.subsets[0]?.id ?? ""),
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "평가 결과를 불러오지 못했어요.",
      );
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token, onSessionExpired]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  const subset = report?.subsets.find((item) => item.id === selectedId);
  const tft = subset?.metrics.find(
    (item) => item.model === "TFT_persistence_postprocessed",
  );
  const baseline = subset?.metrics.find(
    (item) => item.model === "current_API_weekday_baseline",
  );
  const noWeather = subset?.metrics.find(
    (item) => item.model === "TFT_no_weather_supplied",
  );

  return (
    <section className={styles.panel} aria-label="오프라인 모델 평가">
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>
            저장된 테스트 결과 · 오프라인 평가
          </span>
          <h2>{report?.title ?? "같은 판매 기록으로 성능을 비교해요"}</h2>
          <p>
            이미 관측된 실제 판매량과 비교한 평가예요. ‘직접 예측’ 버튼의 실행
            결과와는 별도로 조회해요.
          </p>
        </div>
        {report && <span className={styles.badge}>단일 seed 비교</span>}
      </div>

      {loading && (
        <div className={styles.loading} role="status">
          <span className="loading-spinner" />
          평가 기록을 불러오고 있어요.
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="button secondary" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            평가 다시 불러오기
          </button>
        </div>
      )}

      {report && subset && (
        <>
          <div className={styles.subsetBar}>
            <label>
              평가 대상
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {report.subsets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {format(item.n, 0)}행
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.counts}>
              <span>
                <strong>{format(subset.n, 0)}</strong> 상품·일 관측
              </span>
              <span>
                <strong>{format(subset.windows, 0)}</strong> 예측 구간
              </span>
              <span>
                <strong>{format(subset.series, 0)}</strong> 매장·상품 조합
              </span>
            </div>
          </div>
          <p className={styles.subsetDescription}>{subset.description}</p>

          <div className={styles.summary}>
            <article>
              <span>TFT 평균 절대오차 · MAE</span>
              <strong>{tft ? `${format(tft.mae)}개` : "—"}</strong>
              <small>상품·일별 P50과 실제 판매량의 차이</small>
            </article>
            <article className={styles.primaryMetric}>
              <span>API 요일 기준선 대비 MAE</span>
              <strong>{reduction(tft?.mae, baseline?.mae)}</strong>
              <small>동일 평가 행의 오차를 상대 비교</small>
            </article>
            <article>
              <span>날씨 제거 TFT 대비 MAE</span>
              <strong>{reduction(tft?.mae, noWeather?.mae)}</strong>
              <small>단일 실행 간 차이 · 날씨의 인과 효과 아님</small>
            </article>
          </div>

          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption>{subset.label} · 세 모델의 동일 행 비교</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col" className="number">
                    MAE ↓<small>개 / P50</small>
                  </th>
                  <th scope="col" className="number">
                    WAPE ↓<small>전체 판매량 대비</small>
                  </th>
                  <th scope="col" className="number">
                    Pinball ↓<small>P10·P50·P90 평균</small>
                  </th>
                  <th scope="col" className="number">
                    구간 포함률<small>P10~P90 · 명목 80%</small>
                  </th>
                  <th scope="col" className="number">
                    평균 구간 폭<small>P90−P10 · 개</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                {subset.metrics.map((metric) => (
                  <tr
                    key={metric.model}
                    className={
                      metric.model === "TFT_persistence_postprocessed"
                        ? styles.tftRow
                        : undefined
                    }
                  >
                    <th scope="row">{metric.label}</th>
                    <td className="number">{format(metric.mae, 4)}</td>
                    <td className="number">
                      {metric.wape === null ? "—" : percent(metric.wape)}
                    </td>
                    <td className="number">{format(metric.mean_pinball, 4)}</td>
                    <td className="number">{percent(metric.coverage)}</td>
                    <td className="number">
                      {format(metric.interval_width, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.metricNote}>
            ↓ 지표는 작을수록 오차가 적어요. 포함률은 실제 판매량이 P10~P90 안에
            든 비율로, 구간 폭과 함께 봐야 해요. 80%를 넘는다는 이유만으로 더
            좋은 예측이라고 판단하지 않아요.
          </p>

          <div className={styles.notes}>
            <p>
              <strong>평가 조건</strong> {report.evaluation_period.start} ~{" "}
              {report.evaluation_period.end} · 최근 {report.method.history_days}
              일로 {report.method.forecast_days}일 예측 · seed{" "}
              {report.method.seed}. 미래 날씨는 마지막 관측값이 이어진다고
              가정해요. {report.method.sampling}
            </p>
            <p>
              <strong>해석 범위</strong> {report.limitations.join(" ")}
            </p>
            <p>
              <strong>출처</strong> {report.dataset} · {report.source} · 보고서{" "}
              {report.report_id}
            </p>
          </div>
        </>
      )}
      {report && !subset && (
        <p className={styles.metricNote}>표시할 평가 집합이 없어요.</p>
      )}
    </section>
  );
}

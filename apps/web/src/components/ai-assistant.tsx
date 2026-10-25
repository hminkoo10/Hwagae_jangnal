"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

export type AiRun = {
  text: string;
  connection: { name: string; model: string };
  fallback_used: boolean;
};
export type AiAccess = {
  token: string;
  storeId: string;
  onExpired?: () => void;
};

export function useAiRequest<T extends AiRun>({
  token,
  storeId,
  onExpired,
}: AiAccess) {
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => () => request.current?.abort(), [token, storeId]);
  async function run(endpoint: string, body?: unknown) {
    if (lock.current) return null;
    lock.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const next = await api<T>(`/stores/${storeId}/ai/${endpoint}`, token, {
        method: "POST",
        signal: controller.signal,
        timeoutMs: 80000,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (controller.signal.aborted) return null;
      setResult(next);
      return next;
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(
          e instanceof Error
            ? e.message
            : "내용을 정리하지 못했어요. 다시 시도해주세요.",
        );
        if (e instanceof ApiError && e.status === 401) onExpired?.();
      }
      return null;
    } finally {
      if (request.current === controller) {
        lock.current = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  function clear() {
    request.current?.abort();
    request.current = null;
    lock.current = false;
    setResult(null);
    setError("");
    setBusy(false);
  }
  return { result, busy, error, run, clear };
}

export function AiError({ error }: { error: string }) {
  return error ? (
    <p className="error-banner" role="alert">
      {error}
    </p>
  ) : null;
}

export function AiAnswer({
  result,
  copy = false,
}: {
  result: AiRun;
  copy?: boolean;
}) {
  const [notice, setNotice] = useState("");
  return (
    <div className="assistant-answer" role="status">
      <p className="assistant-text">{result.text}</p>
      <div className="assistant-answer-foot">
        <small>
          {result.connection.name}
          {result.fallback_used ? " · 다음 순위로 연결했어요" : ""}
        </small>
        {copy && (
          <button
            type="button"
            className="text-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.text);
                setNotice("복사했어요.");
              } catch {
                setNotice("내용을 길게 누르거나 드래그해서 복사해주세요.");
              }
            }}
          >
            문구 복사
          </button>
        )}
      </div>
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}

export const ASSISTANT_TASKS = {
  overview: {
    task: "briefing",
    title: "먼저 할 일을 정리해드려요",
    action: "할 일 정리",
    description: "판매·재고·예측을 함께 살펴봐요.",
  },
  forecast: {
    task: "forecast",
    title: "이번 예측, 어떻게 읽으면 될까요?",
    action: "예측 쉽게 읽기",
    description: "판매 예상과 날씨를 짧게 풀어드려요.",
  },
  inventory: {
    task: "inventory",
    title: "먼저 확인할 재고를 찾아요",
    action: "재고 점검",
    description: "확인 날짜와 유통기한, 입고 예정을 살펴봐요.",
  },
  sales: {
    task: "sales",
    title: "판매 흐름을 살펴봐요",
    action: "판매 흐름 정리",
    description: "최근 2주와 그 전 2주를 비교해요.",
  },
  products: {
    task: "products",
    title: "상품 설정을 함께 확인해요",
    action: "상품 설정 점검",
    description: "가격·원가·유통기한에서 확인할 부분을 짚어드려요.",
  },
} as const;

export function AiAssistant({
  tab,
  asOf,
  forecastId,
  disabled,
  onSetup,
  ...access
}: AiAccess & {
  tab: keyof typeof ASSISTANT_TASKS;
  asOf: string;
  forecastId?: string;
  disabled?: boolean;
  onSetup: () => void;
}) {
  const [question, setQuestion] = useState("");
  const assistant = useAiRequest<AiRun>(access);
  const info = ASSISTANT_TASKS[tab];
  const ask = (query?: string) =>
    assistant.run("help", {
      task: query ? "question" : info.task,
      as_of: asOf,
      forecast_id: forecastId ?? null,
      ...(query ? { question: query } : {}),
    });
  return (
    <section
      className="panel assistant-panel"
      aria-busy={assistant.busy}
      aria-label={info.title}
    >
      <div className="panel-heading">
        <div>
          <h3>{info.title}</h3>
          <p>{info.description}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || assistant.busy}
          onClick={() => void ask()}
        >
          {assistant.busy ? "기록을 살펴보는 중…" : info.action}
        </button>
      </div>
      <AiError error={assistant.error} />
      {assistant.result && <AiAnswer result={assistant.result} />}
      <details className="assistant-question">
        <summary>매장에 물어보기</summary>
        <label>
          궁금한 점
          <textarea
            value={question}
            maxLength={1200}
            rows={2}
            placeholder="예: 유통기한 때문에 먼저 확인할 상품이 있어?"
            disabled={assistant.busy || disabled}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={assistant.busy || disabled || !question.trim()}
          onClick={() => void ask(question.trim())}
        >
          물어보기
        </button>
      </details>
      <div className="assistant-foot">
        <small>
          선택한 기준일 {asOf}의 기록으로 답해요. 필요한 내용은 한 번 더
          확인해주세요.
        </small>
        <button
          type="button"
          className="text-button"
          disabled={assistant.busy}
          onClick={onSetup}
        >
          도우미 연결 관리
        </button>
      </div>
    </section>
  );
}

export function AiOrderMessage({
  orderId,
  ...access
}: AiAccess & { orderId: string }) {
  const assistant = useAiRequest<AiRun>(access);
  return (
    <section className="assistant-order" aria-busy={assistant.busy}>
      <div className="panel-heading">
        <div>
          <h3>공급사에 전달할 문구</h3>
          <p>저장한 수량으로 만들어요. 복사한 뒤 확인하고 전달해주세요.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={assistant.busy}
          onClick={() => void assistant.run(`order-message/${orderId}`)}
        >
          {assistant.busy ? "문구 만드는 중…" : "전달 문구 만들기"}
        </button>
      </div>
      <AiError error={assistant.error} />
      {assistant.result && <AiAnswer result={assistant.result} copy />}
    </section>
  );
}

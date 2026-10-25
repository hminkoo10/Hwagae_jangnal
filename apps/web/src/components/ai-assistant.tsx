"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { AiAnswer, AiThinking } from "./ai-answer";

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

const AI_UNAVAILABLE = "AI가 지금 답하지 못했어요. 잠시 후 다시 시도해주세요.";

// Store checks (4xx) explain what to fix; connection trouble stays a plain retry.
function aiErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500)
    return error.message;
  return AI_UNAVAILABLE;
}

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
        setError(aiErrorMessage(e));
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
    <p className="assistant-error" role="alert">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" />
        <path d="M10 6v4.6M10 13.6v.1" />
      </svg>
      <span>{error}</span>
    </p>
  ) : null;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z" />
      <path d="M18.5 14.5c.25 1.7 1.1 2.6 2.8 2.8-1.7.25-2.55 1.1-2.8 2.8-.25-1.7-1.1-2.55-2.8-2.8 1.7-.25 2.55-1.1 2.8-2.8z" />
    </svg>
  );
}

function dayLabel(value: string) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[1])}월 ${Number(match[2])}일` : value;
}

// Supplier text is copied as-is, so it keeps its own line breaks.
function AiMessage({ text }: { text: string }) {
  const [notice, setNotice] = useState("");
  return (
    <div className="assistant-message">
      <p className="assistant-message-text">{text}</p>
      <div className="assistant-message-foot">
        <small role="status">{notice}</small>
        <button
          type="button"
          className="button secondary assistant-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setNotice("복사했어요.");
            } catch {
              setNotice("내용을 길게 누르거나 드래그해서 복사해주세요.");
            }
          }}
        >
          문구 복사
        </button>
      </div>
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
  ...access
}: AiAccess & {
  tab: keyof typeof ASSISTANT_TASKS;
  asOf: string;
  forecastId?: string;
  disabled?: boolean;
  /** Not used: the service operator manages the AI connection for every store. */
  onSetup?: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState(false);
  const assistant = useAiRequest<AiRun>(access);
  const info = ASSISTANT_TASKS[tab];
  const inputId = useId();
  const ask = (query?: string) => {
    setAsked(Boolean(query));
    return assistant.run("help", {
      task: query ? "question" : info.task,
      as_of: asOf,
      forecast_id: forecastId ?? null,
      ...(query ? { question: query } : {}),
    });
  };
  const canAsk = !assistant.busy && !disabled && question.trim().length > 0;
  return (
    <section
      className="panel assistant-panel assistant-chat"
      aria-busy={assistant.busy}
      aria-label={info.title}
    >
      <div className="assistant-head">
        <div className="assistant-head-copy">
          <span className="assistant-eyebrow">
            <SparkIcon />
            AI 도우미
          </span>
          <h3>{info.title}</h3>
          <p>{info.description}</p>
        </div>
        <button
          type="button"
          className="button assistant-run"
          disabled={disabled || assistant.busy}
          onClick={() => void ask()}
        >
          {info.action}
        </button>
      </div>
      {assistant.busy && (
        <AiThinking
          label={asked ? "답변을 정리하고 있어요" : "매장 기록을 살펴보고 있어요"}
        />
      )}
      <AiError error={assistant.error} />
      {assistant.result && <AiAnswer text={assistant.result.text} />}
      <div className="assistant-ask">
        <label htmlFor={inputId} className="assistant-ask-label">
          매장에 물어보기
        </label>
        <div className="assistant-ask-box">
          <textarea
            id={inputId}
            className="assistant-ask-input"
            value={question}
            maxLength={1200}
            rows={2}
            placeholder="예: 유통기한 때문에 먼저 확인할 상품이 있어?"
            disabled={assistant.busy || disabled}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            type="button"
            className="button primary assistant-send"
            disabled={!canAsk}
            onClick={() => void ask(question.trim())}
          >
            물어보기
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
            </svg>
          </button>
        </div>
      </div>
      <p className="assistant-foot">
        <time dateTime={asOf}>{dayLabel(asOf)}</time> 기록으로 답해요. 중요한
        내용은 한 번 더 확인해주세요.
      </p>
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
      <div className="assistant-head">
        <div className="assistant-head-copy">
          <h3>공급사에 전달할 문구</h3>
          <p>저장한 수량으로 만들어요. 복사한 뒤 확인하고 전달해주세요.</p>
        </div>
        <button
          type="button"
          className="button assistant-run"
          disabled={assistant.busy}
          onClick={() => void assistant.run(`order-message/${orderId}`)}
        >
          전달 문구 만들기
        </button>
      </div>
      {assistant.busy && <AiThinking label="전달 문구를 만들고 있어요" />}
      <AiError error={assistant.error} />
      {assistant.result && <AiMessage text={assistant.result.text} />}
    </section>
  );
}

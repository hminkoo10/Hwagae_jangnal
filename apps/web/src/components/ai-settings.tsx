"use client";

import { Select } from "./controls";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { explainOrder } from "@/lib/ai-explanations";
import { Modal } from "./ui";
import { AiAnswer, AiOutput, AiThinking } from "./ai-answer";
import { protocolForAddress, type AiProtocol } from "@/lib/ai-provider";
import styles from "./operator-ai.module.css";

type Connection = {
  id: string;
  name: string;
  gateway: string;
  model: string;
  protocol: AiProtocol;
  reasoning_effort: string;
  enabled: boolean;
  key_set: boolean;
};
type Settings = { revision: number; connections: Connection[] };
type Draft = Omit<Connection, "id" | "key_set"> & {
  id?: string;
  api_key?: string;
};
type Run = {
  text: string;
  connection: { name: string; model: string };
  fallback_used: boolean;
  attempts: { id: string; name: string; status: string }[];
};
const efforts = [
  ["default", "모델 기본값"],
  ["none", "추론 없음"],
  ["minimal", "최소"],
  ["low", "낮음"],
  ["medium", "보통"],
  ["high", "높음"],
  ["xhigh", "매우 높음"],
  ["max", "최대"],
];
const labels: Record<string, string> = {
  ok: "응답 성공",
  timeout: "시간 초과",
  authentication: "키·권한 확인",
  rate_limit: "한도·호출 제한",
  provider: "공급사 오류",
  request: "모델·요청 설정 확인",
  network: "연결 실패",
  blocked_address: "공개 HTTPS 주소 필요",
  credential: "저장 키 확인",
  invalid_response: "응답 형식 오류",
};
const services: Record<AiProtocol, string> = {
  chat_completions: "OpenAI 호환",
  responses: "OpenAI Responses",
  anthropic: "Claude (Anthropic)",
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 완료하지 못했어요.";

function Result({ result }: { result: Run }) {
  return (
    <div className={`${styles.result} ai-test-result`} role="status">
      <strong>
        {result.fallback_used ? "다음 순서 연결이 답했어요" : "AI가 답했어요"}
      </strong>
      <p className={styles.answer}>{result.text}</p>
      <p className={styles.meta}>
        답한 연결: {result.connection.name} · {result.connection.model}
      </p>
      <ol>
        {result.attempts.map((a) => (
          <li key={a.id}>
            {a.name} · {labels[a.status] ?? "연결 확인 필요"}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SetupSteps({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <section className={styles.guide} aria-label="처음 연결 순서">
      <strong>이 순서대로 넣어주세요</strong>
      <ol className={styles.steps}>
        <li>
          <strong>서비스 고르기</strong>
          <span>OpenAI 호환, OpenAI Responses, Claude 중에서 골라요.</span>
        </li>
        <li>
          <strong>주소와 API 키 넣기</strong>
          <span>AI 서비스에서 받은 기본 주소와 키를 붙여넣어요.</span>
        </li>
        <li>
          <strong>모델 고르기</strong>
          <span>‘모델 찾기’를 누르고 목록에서 골라요.</span>
        </li>
        <li>
          <strong>저장하고 응답 확인</strong>
          <span>저장한 뒤 ‘응답 확인’으로 답이 오는지 봐요.</span>
        </li>
      </ol>
      <button
        type="button"
        className="button primary"
        disabled={disabled}
        onClick={onStart}
      >
        첫 연결 추가하기
      </button>
      <p>매장에서 따로 넣었던 키는 더 이상 쓰지 않아요. 여기서 한 번만 넣어주세요.</p>
    </section>
  );
}

function ConnectionModal({
  connection,
  defaultName,
  token,
  onSave,
  onClose,
  onExpired,
}: {
  connection: Connection | null;
  defaultName: string;
  token: string;
  onSave: (draft: Draft) => Promise<void>;
  onClose: () => void;
  onExpired: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    connection
      ? {
          id: connection.id,
          name: connection.name,
          gateway: connection.gateway,
          model: connection.model,
          protocol: protocolForAddress(connection.gateway, connection.protocol),
          reasoning_effort: connection.reasoning_effort,
          enabled: connection.enabled,
        }
      : {
          name: defaultName,
          gateway: "",
          model: "",
          protocol: "chat_completions",
          reasoning_effort: "default",
          enabled: true,
        },
  );
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [manual, setManual] = useState(!!connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const keyRequired =
    !connection || !connection.key_set || draft.gateway !== connection.gateway;
  async function fetchModels() {
    if (busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ models: string[] }>(
        "/platform/ai/models",
        token,
        {
          method: "POST",
          signal: request.signal,
          body: JSON.stringify({
            gateway: draft.gateway,
            protocol: protocolForAddress(draft.gateway, draft.protocol),
            ...(key ? { api_key: key } : {}),
            connection_id: connection?.id ?? null,
          }),
        },
      );
      if (request.signal.aborted) return;
      setModels(result.models);
      if (!result.models.length) {
        setManual(true);
        setError(
          "모델 목록이 비어 있어요. 서비스에서 안내받은 모델 이름을 직접 넣어주세요.",
        );
        return;
      }
      setManual(false);
      if (!result.models.includes(draft.model))
        setDraft((d) => ({ ...d, model: result.models[0] }));
    } catch (e) {
      if (request.signal.aborted) return;
      setError(message(e));
      if (e instanceof ApiError && e.status === 401) onExpired();
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <Modal
      title={connection ? "연결 수정" : "AI 연결 추가"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave({ ...draft, ...(key ? { api_key: key } : {}) });
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <fieldset className="ai-setup-step">
          <legend>1. 서비스와 키 넣기</legend>
          <label>
            연결할 서비스
            <Select
              aria-label="연결할 AI 서비스"
              value={draft.protocol}
              disabled={busy}
              onChange={(e) => {
                const protocol = e.target.value as AiProtocol;
                setDraft({
                  ...draft,
                  protocol,
                  model: "",
                  reasoning_effort: "default",
                });
                setModels([]);
                setManual(false);
              }}
            >
              <option value="chat_completions">OpenAI 호환 서비스</option>
              <option value="responses">OpenAI Responses 서비스</option>
              <option value="anthropic">Claude (Anthropic)</option>
            </Select>
          </label>
          <label>
            서비스 주소
            <input
              type="url"
              value={draft.gateway}
              maxLength={500}
              required
              disabled={busy}
              onChange={(e) => {
                const gateway = e.target.value;
                const protocol = protocolForAddress(gateway, draft.protocol);
                setDraft({
                  ...draft,
                  gateway,
                  protocol,
                  model: "",
                  reasoning_effort:
                    protocol !== draft.protocol
                      ? "default"
                      : draft.reasoning_effort,
                });
                setModels([]);
                setManual(false);
              }}
              placeholder={
                draft.protocol === "anthropic"
                  ? "https://api.anthropic.com"
                  : "https://gateway.example/v1"
              }
            />
          </label>
          <p className="helper">
            {draft.protocol === "anthropic"
              ? "Claude는 https://api.anthropic.com 을 넣으면 돼요."
              : "서비스에서 받은 기본 주소예요. 끝에 /v1 까지 넣어주세요."}
          </p>
          <label>
            API 키
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={key}
              disabled={busy}
              required={keyRequired}
              onChange={(e) => {
                setKey(e.target.value);
                setModels([]);
                if (draft.model) setManual(true);
              }}
              placeholder={keyRequired ? "API 키 붙여넣기" : "바꿀 때만 입력"}
            />
          </label>
          <p className="helper">
            {keyRequired
              ? "저장하면 암호화해 보관하고, 다시 보여주지 않아요."
              : "저장된 키를 그대로 써요. 주소를 바꾸면 키도 다시 넣어주세요."}
          </p>
        </fieldset>
        <fieldset className="ai-setup-step">
          <legend>2. 모델 고르기</legend>
          <div className="split-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !draft.gateway || (!key && keyRequired)}
              onClick={() => void fetchModels()}
            >
              {busy ? "찾는 중…" : "모델 찾기"}
            </button>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={manual}
                disabled={busy}
                onChange={(e) => setManual(e.target.checked)}
              />
              직접 입력
            </label>
          </div>
          <label>
            사용할 모델
            {manual ? (
              <input
                value={draft.model}
                maxLength={200}
                required
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="서비스에서 안내받은 모델 이름"
              />
            ) : (
              <Select
                value={draft.model}
                required
                disabled={busy || !models.length}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              >
                <option value="" disabled>
                  ‘모델 찾기’를 먼저 눌러주세요
                </option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </label>
        </fieldset>
        <details className="ai-advanced">
          <summary>고급 설정</summary>
          <label>
            추론 강도
            <Select
              value={draft.reasoning_effort}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, reasoning_effort: e.target.value })
              }
            >
              {efforts
                .filter(
                  ([value]) =>
                    draft.protocol !== "anthropic" ||
                    !["none", "minimal"].includes(value),
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </Select>
          </label>
          <p className="helper">잘 모르겠다면 ‘모델 기본값’을 그대로 두세요.</p>
        </details>
        <fieldset className="ai-setup-step">
          <legend>3. 이름 붙이고 저장하기</legend>
          <label>
            연결 이름
            <input
              value={draft.name}
              maxLength={60}
              required
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="예: 기본 AI"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            이 연결 사용
          </label>
          <button
            className="button primary"
            disabled={busy || !draft.model.trim()}
          >
            {busy ? "저장 중…" : "저장하기"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}

/** The one AI connection chain every store uses. Service operators only. */
export function AiSettings({
  token,
  onExpired,
  onChanged,
}: {
  token: string;
  onExpired: () => void;
  onChanged?: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [result, setResult] = useState<Run | null>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const c = new AbortController();
    setSettings(null);
    setError("");
    api<Settings>("/platform/ai/settings", token, { signal: c.signal })
      .then((s) => {
        if (!c.signal.aborted) setSettings(s);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(message(e));
          if (e instanceof ApiError && e.status === 401) onExpired();
        }
      });
    return () => c.abort();
  }, [token, reload, onExpired]);
  async function save(connections: (Connection | Draft)[]) {
    if (!settings || busy) throw new Error("설정을 불러온 뒤 다시 시도하세요.");
    const c = new AbortController();
    mutation.current = c;
    setBusy(true);
    setError("");
    try {
      const payload = connections.map((item) => {
        const { key_set: _keySet, ...connection } = item as Connection & Draft;
        return connection;
      });
      const saved = await api<Settings>("/platform/ai/settings", token, {
        method: "PUT",
        signal: c.signal,
        body: JSON.stringify({
          revision: settings.revision,
          connections: payload,
        }),
      });
      if (c.signal.aborted) return;
      setSettings(saved);
      onChanged?.();
      setResult(null);
      setEditing(null);
      setRemoving(null);
    } catch (e) {
      if (c.signal.aborted) return;
      setError(message(e));
      if (e instanceof ApiError && e.status === 401) onExpired();
      throw e;
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  function change(connections: Connection[]) {
    void save(connections).catch(() => {});
  }
  async function test() {
    if (busy) return;
    const c = new AbortController();
    mutation.current = c;
    setBusy(true);
    setTesting(true);
    setError("");
    setResult(null);
    try {
      const data = await api<Run>("/platform/ai/test", token, {
        method: "POST",
        signal: c.signal,
        timeoutMs: 80000,
      });
      if (!c.signal.aborted) setResult(data);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(message(e));
        if (e instanceof ApiError && e.status === 401) onExpired();
      }
    } finally {
      if (!c.signal.aborted) {
        setBusy(false);
        setTesting(false);
      }
    }
  }
  const connections = settings?.connections ?? [];
  const active = connections.filter((c) => c.enabled);
  const ready = active.some((c) => c.key_set);
  return (
    <>
      <section className="panel ai-settings">
        <div className={styles.heading}>
          <div>
            {settings && (
              <span
                className={`${styles.status} ${ready ? styles.ready : styles.waiting} ai-status${ready ? " is-ready" : ""}`}
              >
                {ready
                  ? "모든 매장에서 쓰는 중"
                  : "연결 전 · 매장에서 AI를 쓸 수 없어요"}
              </span>
            )}
            <h2>모든 매장이 함께 쓰는 AI</h2>
            <p>매장 도우미 · 발주 이유 · 메모 정리에 이 연결을 써요.</p>
          </div>
          {connections.length > 0 && (
            <button
              type="button"
              className="button primary"
              disabled={busy || connections.length >= 8}
              onClick={() => setEditing("new")}
            >
              + 예비 연결 추가
            </button>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setReload((n) => n + 1)}
            >
              설정 새로고침
            </button>
          </div>
        )}
        {!settings && !error && (
          <p className={styles.note} role="status">
            AI 설정을 불러오고 있어요…
          </p>
        )}
        {settings && connections.length === 0 && (
          <SetupSteps disabled={busy} onStart={() => setEditing("new")} />
        )}
        {connections.length > 0 && (
          <div className={styles.chain}>
            <div>
              <span>사용 순서</span>
              <strong>
                {active.length
                  ? active.map((c) => c.name).join(" → ")
                  : "켜진 연결이 없어요"}
              </strong>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !active.length}
              onClick={() => void test()}
            >
              {testing ? "답을 기다리는 중…" : "응답 확인"}
            </button>
          </div>
        )}
        {result && <Result result={result} />}
        {connections.length > 0 && (
          <ol className={styles.list}>
            {connections.map((c, i) => (
              <li
                key={c.id}
                className="ai-connection"
                style={{ "--ai-delay": `${Math.min(i, 7) * 90}ms` } as CSSProperties}
              >
                <div className={styles.cardHead}>
                  <div>
                    <span className={`pill ${c.enabled ? "mint" : "neutral"}`}>
                      {c.enabled
                        ? `${active.findIndex((a) => a.id === c.id) + 1}순위`
                        : "꺼짐"}
                    </span>
                    <h3>{c.name}</h3>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      disabled={busy}
                      onChange={(e) =>
                        change(
                          connections.map((item) =>
                            item.id === c.id
                              ? { ...item, enabled: e.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    사용
                  </label>
                </div>
                <p className={styles.model}>
                  {c.model} ·{" "}
                  {efforts.find(([v]) => v === c.reasoning_effort)?.[1] ??
                    "모델 기본값"}
                </p>
                <p className={styles.meta}>
                  {services[c.protocol] ?? services.chat_completions} ·{" "}
                  {c.gateway} ·{" "}
                  {c.key_set ? (
                    "키 저장됨"
                  ) : (
                    <span className={styles.keyMissing}>키를 다시 넣어주세요</span>
                  )}
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || i === 0}
                    aria-label={`${c.name} 순서 올리기`}
                    onClick={() => {
                      const next = [...connections];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      change(next);
                    }}
                  >
                    ↑ 위로
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || i === connections.length - 1}
                    aria-label={`${c.name} 순서 내리기`}
                    onClick={() => {
                      const next = [...connections];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      change(next);
                    }}
                  >
                    ↓ 아래로
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={() => setEditing(c)}
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setRemoving(c);
                    }}
                  >
                    삭제
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {connections.length > 0 && (
          <p className={styles.note}>
            1순위가 답하지 못하면 다음 순서로 자동으로 넘어가요. 최대 8개까지
            등록할 수 있어요.
          </p>
        )}
        <details className={styles.more}>
          <summary>자동 전환·요금 안내</summary>
          <ul>
            <li>외부에서 접속할 수 있는 HTTPS 주소만 연결할 수 있어요.</li>
            <li>
              호출 제한·키 오류·시간 초과·잘못된 응답이면 다음 연결로 넘어가요.
              설정은 바꾸지 않아요.
            </li>
            <li>
              요청 한 번에 최대 약 70초를 기다려요. 시간이 지난 요청도 요금이
              나갈 수 있어요.
            </li>
            <li>응답 확인과 매장의 AI 요청 모두 사용 요금이 생길 수 있어요.</li>
            <li>
              매장의 상품·재고·입고·날씨 요약과 메모 내용이 이 서비스로
              전달돼요.
            </li>
          </ul>
        </details>
      </section>
      {editing && settings && (
        <ConnectionModal
          connection={editing === "new" ? null : editing}
          defaultName={connections.length ? "예비 AI" : "기본 AI"}
          token={token}
          onExpired={onExpired}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const next =
              editing === "new"
                ? [...connections, draft]
                : connections.map((c) => (c.id === draft.id ? draft : c));
            await save(next);
          }}
        />
      )}
      {removing && settings && (
        <Modal
          title="연결 삭제"
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="stack">
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            <p>‘{removing.name}’ 연결을 지울까요? 저장한 API 키도 함께 지워져요.</p>
            {removing.enabled && active.length === 1 && (
              <p className="helper">지우면 모든 매장에서 AI를 쓸 수 없어요.</p>
            )}
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() =>
                change(connections.filter((c) => c.id !== removing.id))
              }
            >
              {busy ? "지우는 중…" : "삭제하기"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

const explainFailed = "AI가 지금 답하지 못했어요. 잠시 후 다시 시도해주세요.";

export function AiExplanation({
  token,
  storeId,
  recommendationId,
  onExpired,
}: {
  token: string;
  storeId: string;
  recommendationId: string;
  onExpired: () => void;
}) {
  const [result, setResult] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    setResult(null);
    const pending = explainOrder(token, storeId, recommendationId);
    pending
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((e) => {
        if (cancelled) return;
        // 409 carries a plain reason (plan changed / not set up yet); every
        // other failure gets one calm message with no connection details.
        setError(
          e instanceof ApiError && e.status === 409 ? e.message : explainFailed,
        );
        if (e instanceof ApiError && e.status === 401) onExpired();
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, storeId, recommendationId, onExpired, retry]);
  return (
    <section className="ai-explanation">
      <div className="panel-heading">
        <div>
          <h3>이번 발주, 이렇게 잡았어요</h3>
          <p>처음 추천한 수량 기준이에요.</p>
        </div>
        {error && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            다시 시도
          </button>
        )}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {(busy || result) && (
        <AiOutput>
          {busy && (
            <AiThinking
              label="재고와 입고를 확인하고 있어요"
              steps={["날씨와 예측을 확인하고 있어요", "발주 이유를 정리하고 있어요"]}
            />
          )}
          {result && <AiAnswer text={result.text} />}
        </AiOutput>
      )}
    </section>
  );
}

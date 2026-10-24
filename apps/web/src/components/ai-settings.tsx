"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "./ui";

type Connection = {
  id: string;
  name: string;
  gateway: string;
  model: string;
  protocol: "chat_completions" | "responses";
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
const message = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 완료하지 못했어요.";

function Result({ result }: { result: Run }) {
  return (
    <div className="ai-result" role="status">
      <strong>
        {result.fallback_used ? "다음 순위 AI로 전환했어요" : "AI가 응답했어요"}
      </strong>
      <p className="ai-output">{result.text}</p>
      <p className="helper">
        사용 연결: {result.connection.name} · {result.connection.model}
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

function ConnectionModal({
  connection,
  token,
  storeId,
  onSave,
  onClose,
  onExpired,
}: {
  connection: Connection | null;
  token: string;
  storeId: string;
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
          protocol: connection.protocol,
          reasoning_effort: connection.reasoning_effort,
          enabled: connection.enabled,
        }
      : {
          name: "",
          gateway: "",
          model: "",
          protocol: "chat_completions",
          reasoning_effort: "default",
          enabled: true,
        },
  );
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [manual, setManual] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function fetchModels() {
    if (busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ models: string[] }>(
        `/stores/${storeId}/ai/models`,
        token,
        {
          method: "POST",
          signal: request.signal,
          body: JSON.stringify({
            gateway: draft.gateway,
            ...(key ? { api_key: key } : {}),
            connection_id: connection?.id ?? null,
          }),
        },
      );
      if (request.signal.aborted) return;
      setModels(result.models);
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
      title={connection ? "AI 연결 수정" : "AI 연결 추가"}
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
        <label>
          연결 이름
          <input
            value={draft.name}
            maxLength={60}
            required
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="예: 기본 AI / 예비 AI"
          />
        </label>
        <label>
          게이트웨이 기본 주소
          <input
            type="url"
            value={draft.gateway}
            maxLength={500}
            required
            disabled={busy}
            onChange={(e) => {
              setDraft({ ...draft, gateway: e.target.value });
              setModels([]);
              setManual(true);
            }}
            placeholder="https://gateway.example/v1"
          />
        </label>
        <label>
          API 키
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            disabled={busy}
            required={!connection || draft.gateway !== connection.gateway}
            onChange={(e) => {
              setKey(e.target.value);
              setModels([]);
              setManual(true);
            }}
            placeholder={connection ? "변경할 때만 입력" : "API 키 입력"}
          />
        </label>
        <p className="helper">
          키는 서버에 암호화해 보관해요. 게이트웨이 주소를 바꾸면 키를 다시
          입력하세요.
        </p>
        <label>
          API 형식
          <select
            value={draft.protocol}
            disabled={busy}
            onChange={(e) =>
              setDraft({
                ...draft,
                protocol: e.target.value as Connection["protocol"],
              })
            }
          >
            <option value="chat_completions">
              OpenAI 호환 · Chat Completions
            </option>
            <option value="responses">OpenAI 호환 · Responses</option>
          </select>
        </label>
        <div className="split-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !draft.gateway || (!key && !connection)}
            onClick={() => void fetchModels()}
          >
            {busy ? "처리 중…" : "모델 목록 불러오기"}
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={manual}
              disabled={busy || !models.length}
              onChange={(e) => setManual(e.target.checked)}
            />
            모델 ID 직접 입력
          </label>
        </div>
        <label>
          사용 모델
          {manual ? (
            <input
              value={draft.model}
              maxLength={200}
              required
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="게이트웨이의 모델 ID"
            />
          ) : (
            <select
              value={draft.model}
              required
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          추론 강도
          <select
            value={draft.reasoning_effort}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, reasoning_effort: e.target.value })
            }
          >
            {efforts.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="helper">
          지원 강도는 모델마다 달라요. 기본값은 강도를 지정하지 않아요. 지원하지
          않는 강도는 연결 테스트에서 확인할 수 있어요.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          이 연결 사용
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? "저장 중…" : "연결 저장"}
        </button>
      </form>
    </Modal>
  );
}

export function AiSettings({
  token,
  storeId,
  onExpired,
}: {
  token: string;
  storeId: string;
  onExpired: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    api<Settings>(`/stores/${storeId}/ai/settings`, token, { signal: c.signal })
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
  }, [token, storeId, reload, onExpired]);
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
      const saved = await api<Settings>(
        `/stores/${storeId}/ai/settings`,
        token,
        {
          method: "PUT",
          signal: c.signal,
          body: JSON.stringify({
            revision: settings.revision,
            connections: payload,
          }),
        },
      );
      if (c.signal.aborted) return;
      setSettings(saved);
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
    setError("");
    setResult(null);
    try {
      const data = await api<Run>(`/stores/${storeId}/ai/test`, token, {
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
      if (!c.signal.aborted) setBusy(false);
    }
  }
  const active = settings?.connections.filter((c) => c.enabled) ?? [];
  return (
    <>
      <section className="panel ai-settings">
        <div className="panel-heading">
          <div>
            <h2>우리 매장 AI 연결</h2>
            <p>
              사용 중인 연결을 위에서부터 순서대로 호출해요. 실패하면 다음
              연결로 전환해요.
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || !settings || settings.connections.length >= 8}
            onClick={() => setEditing("new")}
          >
            + AI 연결 추가
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setReload((n) => n + 1)}
            >
              설정 새로고침
            </button>
          </div>
        )}
        <div className="ai-chain">
          <strong>현재 사용 순서</strong>
          <p>
            {active.length
              ? active.map((c) => c.name).join(" → ")
              : "사용할 AI 연결을 선택하세요."}
          </p>
          <button
            className="button secondary"
            disabled={busy || !active.length}
            onClick={() => void test()}
          >
            {busy ? "처리 중…" : "사용 순서대로 연결 테스트"}
          </button>
        </div>
        {result && <Result result={result} />}
        {!settings && !error && <p role="status">AI 설정을 불러오고 있어요…</p>}
        {settings?.connections.length === 0 && (
          <p className="empty-description">
            게이트웨이 주소와 API 키를 등록해 첫 AI를 연결하세요.
          </p>
        )}
        <ol className="ai-connections">
          {settings?.connections.map((c, i) => (
            <li key={c.id}>
              <div className="ai-card-heading">
                <div>
                  <span className={`pill ${c.enabled ? "mint" : "neutral"}`}>
                    {c.enabled
                      ? `${active.findIndex((a) => a.id === c.id) + 1}순위`
                      : "사용 안 함"}
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
                        settings.connections.map((item) =>
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
              <p>
                <strong>{c.model}</strong> ·{" "}
                {efforts.find(([v]) => v === c.reasoning_effort)?.[1]}
              </p>
              <p className="helper ai-gateway-url">
                {c.gateway} ·{" "}
                {c.protocol === "responses" ? "Responses" : "Chat Completions"}{" "}
                · 키 암호화 보관
              </p>
              <div className="ai-card-actions">
                <button
                  className="button secondary small"
                  disabled={busy || i === 0}
                  aria-label={`${c.name} 우선순위 올리기`}
                  onClick={() => {
                    const next = [...settings.connections];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    change(next);
                  }}
                >
                  ↑ 위로
                </button>
                <button
                  className="button secondary small"
                  disabled={busy || i === settings.connections.length - 1}
                  aria-label={`${c.name} 우선순위 내리기`}
                  onClick={() => {
                    const next = [...settings.connections];
                    [next[i], next[i + 1]] = [next[i + 1], next[i]];
                    change(next);
                  }}
                >
                  ↓ 아래로
                </button>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => setEditing(c)}
                >
                  수정
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRemoving(c)}
                >
                  삭제
                </button>
              </div>
            </li>
          ))}
        </ol>
        <p className="helper">
          최대 8개 연결을 등록할 수 있어요. 설정은 이 매장 점주만 변경해요. 연결
          테스트·발주 설명은 선택한 게이트웨이에 요청하며 사용 요금이 발생할 수
          있어요.
        </p>
        <details>
          <summary>연결 방식·자동 전환 안내</summary>
          <p className="helper">
            공개 HTTPS 주소의 OpenAI 호환 API를 지원해요. 모델 목록이 제공되지
            않으면 모델 ID를 직접 입력하세요. 호출 제한·인증 실패·시간
            초과·잘못된 응답이면 다음 사용 중인 연결로 넘어가요. 추론 강도
            오류도 다음 연결로 전환하며 설정을 임의로 바꾸지 않아요. 요청 한
            번의 전체 대기는 최대 약 70초예요. 시간 초과된 요청도 공급사에서
            처리·과금될 수 있어요. 발주 설명에는 상품·재고·입고·날씨 요약이 사용
            중인 게이트웨이에 전달돼요.
          </p>
        </details>
      </section>
      {editing && settings && (
        <ConnectionModal
          connection={editing === "new" ? null : editing}
          token={token}
          storeId={storeId}
          onExpired={onExpired}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const next =
              editing === "new"
                ? [...settings.connections, draft]
                : settings.connections.map((c) =>
                    c.id === draft.id ? draft : c,
                  );
            await save(next);
          }}
        />
      )}
      {removing && settings && (
        <Modal
          title="AI 연결 삭제"
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <p>{removing.name} 연결과 저장한 API 키를 삭제할까요?</p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              change(settings.connections.filter((c) => c.id !== removing.id))
            }
          >
            연결 삭제
          </button>
        </Modal>
      )}
    </>
  );
}

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
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function explain() {
    if (busy) return;
    const c = new AbortController();
    request.current = c;
    setBusy(true);
    setError("");
    try {
      const data = await api<Run>(
        `/stores/${storeId}/ai/explain/${recommendationId}`,
        token,
        { method: "POST", signal: c.signal, timeoutMs: 80000 },
      );
      if (!c.signal.aborted) setResult(data);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(message(e));
        if (e instanceof ApiError && e.status === 401) onExpired();
      }
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="ai-explanation">
      <div className="panel-heading">
        <div>
          <h3>이 수량을 추천한 이유</h3>
          <p>
            선택한 AI가 계산 당시 재고·입고·날씨를 설명해요. 수량 수정 전 추천
            기준이에요.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void explain()}
        >
          {busy ? "AI가 설명 중…" : "AI 설명 보기"}
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {result && <Result result={result} />}
    </section>
  );
}

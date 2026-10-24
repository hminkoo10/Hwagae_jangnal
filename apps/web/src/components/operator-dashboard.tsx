"use client";
import { useEffect, useState } from "react";
import { api, ApiError, addCalendarDays, type User } from "@/lib/api";
import { Modal } from "./ui";
import { DateField, Select } from "./controls";

type Contract = {
  id: string;
  email: string;
  merchant_name: string;
  starts_on: string;
  ends_on: string;
  status: "active" | "suspended";
  enabled: boolean;
  user_id: string | null;
  access_status: string;
  stores: {
    id: string;
    name: string;
    city: string;
    last_sales_date: string | null;
    product_count: number;
  }[];
};
type Overview = {
  contracts: Contract[];
  existing_merchants: { id: string; name: string; email: string }[];
  counts: { stores: number; products: number; sales: number; orders: number };
  today: string;
};
type Invite = { token: string; expires_at: string };
const statuses: Record<string, string> = {
  active: "이용 중",
  invited: "가입 대기",
  scheduled: "계약 시작 전",
  expired: "계약 만료",
  suspended: "이용 중지",
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 완료하지 못했어요.";

export function OperatorDashboard({
  token,
  user,
  onLogout,
  onExpired,
}: {
  token: string;
  user: User;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState<{
    email: string;
    name: string;
  } | null>(null);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const c = new AbortController();
    api<Overview>("/admin/overview", token, { signal: c.signal })
      .then((value) => {
        if (!c.signal.aborted) {
          setData(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setError(message(e));
          if (e instanceof ApiError && e.status === 401) onExpired();
        }
      });
    return () => c.abort();
  }, [token, reload, onExpired]);
  async function action(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
      setReload((n) => n + 1);
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status === 401) onExpired();
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const contracts =
    data?.contracts.filter(
      (c) =>
        (filter === "all" || c.access_status === filter) &&
        `${c.email} ${c.merchant_name} ${c.stores.map((s) => s.name).join(" ")}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    ) ?? [];
  const inviteUrl = invite
    ? `https://hwagae.milky.kr/#invite=${encodeURIComponent(invite.token)}`
    : "";
  return (
    <div className="operator-shell">
      <header className="operator-bar">
        <div className="brand">
          <strong>
            화개장날<span>.</span>
          </strong>
          <span className="pill mint">서비스 운영</span>
        </div>
        <div className="account-actions">
          <span>
            {user.name} · {user.email}
          </span>
          <button className="button secondary" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </header>
      <main className="operator-main">
        <div className="operator-toolbar">
          <div>
            <p className="overline">MERCHANT OPERATIONS</p>
            <h1>점주와 매장 관리</h1>
            <p>계약부터 가입, 매장 이용 현황까지 한곳에서 관리하세요.</p>
          </div>
          <button
            className="button primary"
            disabled={!data || busy}
            onClick={() => setCreating({ email: "", name: "" })}
          >
            + 계약 등록 · 점주 초대
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              type="button"
              className="text-button"
              onClick={() => setReload((n) => n + 1)}
            >
              다시 확인
            </button>
          </div>
        )}
        {notice && (
          <p className="success-banner" role="status">
            {notice}
          </p>
        )}
        {!data && !error && <p role="status">운영 현황을 불러오고 있어요…</p>}
        {data && (
          <>
            <div className="stat-grid">
              {[
                [
                  "이용 중 점주",
                  data.contracts.filter((c) => c.access_status === "active")
                    .length,
                ],
                [
                  "가입 대기",
                  data.contracts.filter((c) => c.access_status === "invited")
                    .length,
                ],
                ["전체 매장", data.counts.stores],
                ["저장된 발주 계획", data.counts.orders],
              ].map(([label, count]) => (
                <article className="stat-card" key={label}>
                  <span>{label}</span>
                  <strong>{count}</strong>
                </article>
              ))}
            </div>
            <section className="panel">
              <div className="operator-toolbar">
                <h2>계약 · 계정</h2>
                <div className="table-tools">
                  <input
                    aria-label="점주·이메일·매장 검색"
                    placeholder="점주·이메일·매장 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <Select
                    aria-label="계약 상태"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">모든 상태</option>
                    {Object.entries(statuses).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="operator-grid">
                {contracts.map((c) => (
                  <article key={c.id} className="panel operator-contract">
                    <div className="panel-heading">
                      <h2>{c.merchant_name}</h2>
                      <span
                        className={`pill ${c.access_status === "active" ? "mint" : "neutral"}`}
                      >
                        {statuses[c.access_status]}
                      </span>
                    </div>
                    <p>{c.email}</p>
                    <dl>
                      <dt>계약 기간</dt>
                      <dd>
                        {c.starts_on} ~ {c.ends_on}
                      </dd>
                      <dt>등록 매장</dt>
                      <dd>{c.stores.length}개</dd>
                      <dt>계정 상태</dt>
                      <dd>
                        {!c.user_id
                          ? "초대 후 가입 대기"
                          : c.enabled
                            ? "사용 허용"
                            : "사용 중지"}
                      </dd>
                    </dl>
                    <ul className="operator-stores">
                      {c.stores.map((s) => (
                        <li key={s.id}>
                          <strong>{s.name}</strong>
                          <p className="helper">
                            {s.city}
                            <br />
                            상품 {s.product_count}개 · 마지막 판매 기록{" "}
                            {s.last_sales_date ?? "없음"}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <div className="split-actions">
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setEditing(c)}
                      >
                        계약·계정 관리
                      </button>
                      {!c.user_id && (
                        <button
                          className="button secondary"
                          disabled={
                            busy ||
                            c.status !== "active" ||
                            c.ends_on < data.today
                          }
                          onClick={() =>
                            void action(async () => {
                              setInvite(
                                await api<Invite>(
                                  `/admin/contracts/${c.id}/invite`,
                                  token,
                                  { method: "POST" },
                                ),
                              );
                            }).catch(() => {})
                          }
                        >
                          초대 링크 재발급
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!contracts.length && (
                <p className="empty-description">
                  조건에 맞는 계약이 없어요. 계약을 등록하면 점주를 초대할 수
                  있어요.
                </p>
              )}
            </section>
            {!!data.existing_merchants.length && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>기존 점주 계정</h2>
                    <p>
                      기존 계정과 자료는 유지돼요. 계약을 연결하면 기간·상태에
                      따라 이용을 관리해요.
                    </p>
                  </div>
                </div>
                <div className="operator-grid">
                  {data.existing_merchants.map((m) => (
                    <div className="panel" key={m.id}>
                      <strong>{m.name}</strong>
                      <p>{m.email}</p>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          setCreating({ email: m.email, name: m.name })
                        }
                      >
                        계약 연결
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {creating && data && (
        <ContractModal
          key={creating.email}
          initial={creating}
          today={data.today}
          busy={busy}
          onClose={() => {
            if (!busy) setCreating(null);
          }}
          onSave={async (payload) => {
            await action(async () => {
              const result = await api<{
                invite: Invite | null;
                existing_account: boolean;
              }>("/admin/contracts", token, {
                method: "POST",
                body: JSON.stringify(payload),
              });
              setCreating(null);
              setInvite(result.invite);
              setNotice(
                result.existing_account
                  ? "기존 점주 계정에 계약을 연결했어요. 비밀번호와 매장 자료는 유지돼요."
                  : "계약을 등록했어요. 초대 링크를 점주에게 전달하세요.",
              );
            });
          }}
        />
      )}
      {editing && (
        <EditContract
          key={editing.id}
          contract={editing}
          busy={busy}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
          onSave={async (payload) => {
            await action(async () => {
              await api(`/admin/contracts/${editing.id}`, token, {
                method: "PATCH",
                body: JSON.stringify(payload),
              });
              setEditing(null);
              setNotice("계약·계정 설정을 반영했어요.");
            });
          }}
        />
      )}
      {invite && (
        <Modal title="점주 초대 링크" onClose={() => setInvite(null)}>
          <div className="stack">
            <p>
              이 링크로 점주가 직접 비밀번호를 설정해요. 1회 사용 가능하며
              재발급하면 이전 링크는 만료돼요.
            </p>
            <label>
              초대 링크
              <textarea
                className="invite-link"
                value={inviteUrl}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="helper">
              유효 기한: {new Date(invite.expires_at).toLocaleString("ko-KR")}
            </p>
            <button
              className="button primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(inviteUrl);
                  setNotice("초대 링크를 복사했어요.");
                } catch {
                  setNotice("링크를 길게 눌러 직접 복사하세요.");
                }
              }}
            >
              링크 복사
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ContractModal({
  initial,
  today,
  busy,
  onClose,
  onSave,
}: {
  initial: { email: string; name: string };
  today: string;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: unknown) => Promise<void>;
}) {
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addCalendarDays(today, 365));
  const [error, setError] = useState("");
  return (
    <Modal title="계약 등록 · 점주 초대" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget);
          try {
            await onSave({
              email: fields.get("email"),
              merchant_name: fields.get("name"),
              starts_on: start,
              ends_on: end,
            });
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <label>
          점주 이름
          <input
            required
            name="name"
            defaultValue={initial.name}
            maxLength={80}
            disabled={busy}
          />
        </label>
        <label>
          로그인 이메일
          <input
            required
            type="email"
            name="email"
            defaultValue={initial.email}
            maxLength={200}
            disabled={busy}
          />
        </label>
        <div className="form-grid">
          <label>
            계약 시작일
            <DateField
              required
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            계약 종료일
            <DateField
              required
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        <p className="helper">
          새 점주는 초대 링크로 가입해요. 기존 계정의 이메일을 입력하면 해당
          계정에 계약을 연결해요. 계약 시작 전·만료·중지 상태에서는 이용할 수
          없어요.
        </p>
        <button className="button primary" disabled={busy}>
          {busy ? "등록 중…" : "계약 등록"}
        </button>
      </form>
    </Modal>
  );
}
function EditContract({
  contract: c,
  busy,
  onClose,
  onSave,
}: {
  contract: Contract;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: unknown) => Promise<void>;
}) {
  const [start, setStart] = useState(c.starts_on);
  const [end, setEnd] = useState(c.ends_on);
  const [status, setStatus] = useState(c.status);
  const [enabled, setEnabled] = useState(c.enabled);
  const [error, setError] = useState("");
  return (
    <Modal title={`${c.merchant_name} · 계약 관리`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSave({ starts_on: start, ends_on: end, status, enabled });
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <p>{c.email}</p>
        <div className="form-grid">
          <label>
            계약 시작일
            <DateField
              required
              value={start}
              max={end}
              disabled={busy}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            계약 종료일
            <DateField
              required
              value={end}
              min={start}
              disabled={busy}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <label>
          계약 상태
          <Select
            value={status}
            disabled={busy}
            onChange={(e) => setStatus(e.target.value as Contract["status"])}
          >
            <option value="active">계약 유지</option>
            <option value="suspended">이용 중지</option>
          </Select>
        </label>
        {c.user_id && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            계정 사용 허용
          </label>
        )}
        <p className="helper">
          중지하면 현재 로그인도 해제돼요. 해당 점주 매장의 직원 접근도
          차단돼요. 저장된 판매·재고·발주 자료는 유지해요.
        </p>
        <button className="button primary" disabled={busy}>
          {busy ? "저장 중…" : "변경 저장"}
        </button>
      </form>
    </Modal>
  );
}

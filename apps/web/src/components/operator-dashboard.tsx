"use client";
import { useEffect, useState } from "react";
import { api, ApiError, addCalendarDays, type User } from "@/lib/api";
import { CountUp, Icon, Modal } from "./ui";
import { DateField, Select } from "./controls";
import { AiSettings } from "./ai-settings";
import styles from "./operator-ai.module.css";
import {
  MerchantManagementTable,
  selectMerchantRows,
  merchantStatuses,
  type Contract,
  type ExistingMerchant,
  type MerchantRow,
} from "./operator-merchant-table";

type Overview = {
  contracts: Contract[];
  existing_merchants: ExistingMerchant[];
  counts: { stores: number; products: number; sales: number; orders: number };
  today: string;
};
type Invite = { token: string; expires_at: string };
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
  const [sort, setSort] = useState("name");
  const [creating, setCreating] = useState<{
    email: string;
    name: string;
  } | null>(null);
  const [editing, setEditing] = useState<Contract | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [deleting, setDeleting] = useState<MerchantRow | null>(null);
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const [view, setView] = useState<"merchants" | "ai">("merchants");
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [aiReload, setAiReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    api<{ connections: { enabled: boolean; key_set: boolean }[] }>(
      "/platform/ai/settings",
      token,
      { signal: c.signal },
    )
      .then((value) => {
        if (!c.signal.aborted)
          setAiReady(value.connections.some((x) => x.enabled && x.key_set));
      })
      // The AI tab shows its own load error; this only drives the reminder.
      .catch(() => {});
    return () => c.abort();
  }, [token, aiReload]);
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
  const rows = data
    ? selectMerchantRows(
        data.contracts,
        data.existing_merchants,
        query,
        filter,
        sort,
      )
    : [];
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
        <nav className={styles.tabs} aria-label="운영 메뉴">
          <button
            type="button"
            className={styles.tab}
            aria-current={view === "merchants" ? "page" : undefined}
            onClick={() => setView("merchants")}
          >
            점주 관리
          </button>
          <button
            type="button"
            className={styles.tab}
            aria-current={view === "ai" ? "page" : undefined}
            onClick={() => setView("ai")}
          >
            AI 연결
            {aiReady === false && <span className={styles.tabBadge}>필요</span>}
          </button>
        </nav>
        {view === "ai" && (
          <>
            <div className="operator-toolbar">
              <div>
                <h1>AI 연결</h1>
                <p>한 번 설정하면 모든 매장에 바로 적용돼요.</p>
              </div>
            </div>
            <AiSettings
              token={token}
              onExpired={onExpired}
              onChanged={() => setAiReload((n) => n + 1)}
            />
          </>
        )}
        {view === "merchants" && (
          <>
            <div className="operator-toolbar">
              <div>
                <h1>점주 관리</h1>
                <p>계약과 매장을 한곳에서 관리해요.</p>
              </div>
              <button
                className="button primary"
                disabled={!data || busy}
                onClick={() => setCreating({ email: "", name: "" })}
              >
                + 점주 초대
              </button>
            </div>
            {aiReady === false && (
              <div className={styles.banner} role="status">
                <span>AI 연결 전이라 매장에서 AI를 쓸 수 없어요.</span>
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => setView("ai")}
                >
                  AI 연결하기
                </button>
              </div>
            )}
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
                        .length + data.existing_merchants.length,
                    ],
                    [
                      "초대 대기",
                      data.contracts.filter((c) => c.access_status === "invited")
                        .length,
                    ],
                    ["전체 매장", data.counts.stores],
                    ["발주 계획", data.counts.orders],
                  ].map(([label, count]) => (
                    <article className="stat-card" key={label}>
                      <span>{label}</span>
                      <strong>
                        <CountUp value={Number(count)} />
                      </strong>
                    </article>
                  ))}
                </div>
                <section className="panel">
                  <div className="operator-list-toolbar">
                    <div>
                      <h2>
                        점주 목록{" "}
                        <span className="count-label">{rows.length}명</span>
                      </h2>
                      <p className="helper">이름을 누르면 매장을 볼 수 있어요.</p>
                    </div>
                    <div
                      className="merchant-filters"
                      role="search"
                      aria-label="점주 찾기"
                    >
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
                        {Object.entries(merchantStatuses).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                      <Select
                        aria-label="점주 정렬"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="name">이름순</option>
                        <option value="expiry">종료일순</option>
                        <option value="sales">최근 판매순</option>
                      </Select>
                      {(query || filter !== "all" || sort !== "name") && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setQuery("");
                            setFilter("all");
                            setSort("name");
                          }}
                        >
                          초기화
                        </button>
                      )}
                    </div>
                  </div>
                  <MerchantManagementTable
                    rows={rows}
                    busy={busy}
                    today={data.today}
                    onManage={setEditing}
                    onConnect={(m) => setCreating({ email: m.email, name: m.name })}
                    onDelete={setDeleting}
                    onInvite={(c) => {
                      void action(async () => {
                        setInvite(
                          await api<Invite>(
                            `/admin/contracts/${c.id}/invite`,
                            token,
                            { method: "POST" },
                          ),
                        );
                      }).catch(() => {});
                    }}
                  />
                </section>
              </>
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
      {deleting && (
        <DeleteMerchant
          key={deleting.id}
          row={deleting}
          busy={busy}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
          onDelete={async () => {
            await action(async () => {
              const result = await api<{ deleted_stores: number }>(
                deleting.contract
                  ? `/admin/contracts/${deleting.contract.id}/delete`
                  : `/admin/merchants/${deleting.existing!.id}/delete`,
                token,
                { method: "POST" },
              );
              setDeleting(null);
              setToast(
                result.deleted_stores
                  ? `점주와 매장 ${result.deleted_stores}곳을 삭제했어요.`
                  : "점주를 삭제했어요.",
              );
            });
          }}
        />
      )}
      {toast && (
        <div key={toast} className="toast" role="status">
          <Icon name="check" />
          {toast}
          <button
            type="button"
            className="icon-button"
            aria-label="알림 닫기"
            onClick={() => setToast("")}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
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
function DeleteMerchant({
  row,
  busy,
  onClose,
  onDelete,
}: {
  row: MerchantRow;
  busy: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const confirmed =
    typed.trim().toLocaleLowerCase() === row.email.toLocaleLowerCase();
  const joined = !!row.existing || !!row.contract?.user_id;
  return (
    <Modal title={`${row.name} · 점주 삭제`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!confirmed) return;
          try {
            await onDelete();
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
        <p>삭제하면 되돌릴 수 없어요. 아래 자료가 모두 지워져요.</p>
        <ul className="helper merchant-delete-list">
          {row.stores.length > 0 && (
            <li>
              매장 {row.stores.length}곳(
              {row.stores.map((s) => s.name).join(", ")})과 그 매장의
              상품·판매·재고·예측·발주 기록
            </li>
          )}
          {row.stores.length > 0 && (
            <li>이 매장들의 직원 소속과 직원 초대. 직원 계정은 남아요.</li>
          )}
          {row.contract && <li>계약과 초대 링크</li>}
          {joined && (
            <li>
              점주 로그인 정보, 이름·이메일, 시연 발주 기록. 같은 이메일로 다시
              계약할 수 있어요.
            </li>
          )}
        </ul>
        <label>
          확인을 위해 {row.email} 이메일을 입력하세요.
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <button className="button danger" disabled={busy || !confirmed}>
          {busy ? "삭제 중…" : "점주 삭제"}
        </button>
      </form>
    </Modal>
  );
}

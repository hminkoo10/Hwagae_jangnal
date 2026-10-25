"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { api, ApiError, type StaffPermission } from "@/lib/api";
import { ResponsiveTable } from "./controls";
import { Empty, Icon, Modal } from "./ui";

type StaffRow = {
  kind: "member" | "invite";
  id: string;
  name: string;
  email: string;
  status: "invited" | "active" | "suspended";
  permissions: StaffPermission[];
  joined_at: string | null;
  expires_at?: string;
  expired?: boolean;
};
type StaffList = {
  staff: StaffRow[];
  permissions: { key: StaffPermission; label: string; default: boolean }[];
};
type Invite = { token: string; expires_at: string };
const statusPill = {
  invited: ["초대 대기", "amber"],
  active: ["사용 중", "mint"],
  suspended: ["사용 중지", "neutral"],
} as const;
const message = (e: unknown) =>
  e instanceof Error ? e.message : "요청을 완료하지 못했어요.";
const day = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("ko-KR") : "—";
// 앱에서 만든 링크도 직원이 웹에서 열 수 있게 서비스 주소를 쓴다.
const inviteUrl = (token: string) =>
  `${Capacitor.isNativePlatform() ? "https://hwagae.milky.kr" : window.location.origin}/#staff-invite=${encodeURIComponent(token)}`;

/** 점주 전용. 권한은 서버에서도 검사한다. */
export function StaffManagement({
  token,
  storeId,
  storeName,
  onNotice,
  onExpired,
}: {
  token: string;
  storeId: string;
  storeName: string;
  onNotice: (text: string) => void;
  onExpired: () => void;
}) {
  const [data, setData] = useState<StaffList | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [granted, setGranted] = useState<StaffPermission[] | null>(null);
  const [invite, setInvite] = useState<(Invite & { email: string }) | null>(
    null,
  );
  const [confirming, setConfirming] = useState<StaffRow | null>(null);
  const selected =
    granted ??
    data?.permissions.filter((item) => item.default).map((item) => item.key) ??
    [];

  useEffect(() => {
    const c = new AbortController();
    api<StaffList>(`/stores/${storeId}/staff`, token, { signal: c.signal })
      .then((value) => {
        if (!c.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        setError(message(e));
        if (e instanceof ApiError && e.status === 401) onExpired();
      });
    return () => c.abort();
  }, [token, storeId, reload, onExpired]);

  async function action(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status === 401) onExpired();
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }
  const path = (row: StaffRow) =>
    `/stores/${storeId}/staff/${row.kind === "member" ? "members" : "invites"}/${row.id}`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get("email"));
    void action(async () => {
      const result = await api<{
        existing_account: boolean;
        invite: Invite | null;
      }>(`/stores/${storeId}/staff`, token, {
        method: "POST",
        body: JSON.stringify({
          name: fields.get("name"),
          email,
          permissions: selected,
        }),
      });
      form.reset();
      setGranted(null);
      if (result.invite) setInvite({ ...result.invite, email });
      else
        onNotice(
          "이미 가입한 계정이라 바로 직원으로 추가했어요. 쓰던 비밀번호로 로그인하면 돼요.",
        );
    });
  }

  function toggle(row: StaffRow, key: StaffPermission, on: boolean) {
    const permissions = on
      ? [...row.permissions, key]
      : row.permissions.filter((item) => item !== key);
    void action(async () => {
      await api(path(row), token, {
        method: "PATCH",
        body: JSON.stringify({ permissions }),
      });
      onNotice(`${row.name}님이 할 수 있는 일을 바꿨어요.`);
    });
  }

  function setStatus(row: StaffRow, status: "active" | "suspended") {
    void action(async () => {
      await api(path(row), token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      onNotice(
        status === "suspended"
          ? `${row.name}님의 사용을 중지했어요. 이 매장에 들어올 수 없어요.`
          : `${row.name}님이 다시 이 매장을 쓸 수 있어요.`,
      );
    });
  }

  function reissue(row: StaffRow) {
    void action(async () => {
      const result = await api<Invite>(`${path(row)}/reissue`, token, {
        method: "POST",
      });
      setInvite({ ...result, email: row.email });
    });
  }

  function remove(row: StaffRow) {
    setConfirming(null);
    void action(async () => {
      await api(
        `${path(row)}/${row.kind === "member" ? "remove" : "cancel"}`,
        token,
        { method: "POST" },
      );
      onNotice(
        row.kind === "member"
          ? `${row.name}님을 매장에서 제외했어요. 작성한 발주안은 남아 있어요.`
          : "초대를 취소했어요. 보낸 링크는 더 이상 쓸 수 없어요.",
      );
    });
  }

  const link = invite ? inviteUrl(invite.token) : "";
  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>직원 초대</h2>
            <p>
              {storeName}에서 함께 일할 직원을 초대해요. 링크는 7일 동안 한
              번만 쓸 수 있어요.
            </p>
          </div>
          <Icon name="staff" />
        </div>
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            <label>
              이름
              <input name="name" maxLength={40} required disabled={busy} />
            </label>
            <label>
              이메일
              <input
                name="email"
                type="email"
                maxLength={200}
                autoComplete="off"
                required
                disabled={busy}
              />
            </label>
          </div>
          <fieldset className="staff-permissions">
            <legend>할 수 있는 일</legend>
            {data?.permissions.map((item) => (
              <label key={item.key} className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(item.key)}
                  disabled={busy}
                  onChange={(e) =>
                    setGranted(
                      e.target.checked
                        ? [...selected, item.key]
                        : selected.filter((key) => key !== item.key),
                    )
                  }
                />
                {item.label}
              </label>
            ))}
          </fieldset>
          <p className="helper">
            이미 가입한 이메일이면 링크 없이 바로 추가돼요. 매장 설정·초기 자료
            업로드·예측 설정·직원 관리는 점주만 할 수 있어요.
          </p>
          <button className="button primary align-end" disabled={busy || !data}>
            {busy ? "처리 중…" : "초대하기"}
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              직원 목록
              <span className="count-label">{data?.staff.length ?? 0}</span>
            </h2>
            <p>체크를 바꾸면 바로 반영돼요.</p>
          </div>
        </div>
        {!data ? (
          <p role="status">직원 목록을 불러오고 있어요…</p>
        ) : !data.staff.length ? (
          <Empty title="아직 함께하는 직원이 없어요">
            위에서 이름과 이메일로 초대해보세요.
          </Empty>
        ) : (
          <div className="table-scroll">
            <ResponsiveTable className="staff-table">
              <thead>
                <tr>
                  <th>직원</th>
                  <th>상태</th>
                  <th>합류일</th>
                  <th>할 수 있는 일</th>
                  <th className="number">관리</th>
                </tr>
              </thead>
              <tbody>
                {data.staff.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td>
                      <strong>{row.name}</strong>
                      <small>{row.email}</small>
                    </td>
                    <td>
                      <span className={`pill ${statusPill[row.status][1]}`}>
                        {statusPill[row.status][0]}
                      </span>
                      {row.kind === "invite" && (
                        <small>
                          {row.expired
                            ? "링크가 만료됐어요. 다시 발급해주세요."
                            : `${day(row.expires_at)}까지 유효`}
                        </small>
                      )}
                    </td>
                    <td>{day(row.joined_at)}</td>
                    <td>
                      <div className="staff-permissions">
                        {data.permissions.map((item) => (
                          <label key={item.key} className="checkbox">
                            <input
                              type="checkbox"
                              aria-label={`${row.name} ${item.label}`}
                              checked={row.permissions.includes(item.key)}
                              disabled={busy}
                              onChange={(e) =>
                                toggle(row, item.key, e.target.checked)
                              }
                            />
                            {item.label}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="number">
                      <div className="row-actions">
                        {row.kind === "invite" ? (
                          <button
                            className="button table-button"
                            disabled={busy}
                            onClick={() => reissue(row)}
                          >
                            링크 다시 발급
                          </button>
                        ) : (
                          <button
                            className="button table-button"
                            disabled={busy}
                            onClick={() =>
                              setStatus(
                                row,
                                row.status === "active" ? "suspended" : "active",
                              )
                            }
                          >
                            {row.status === "active" ? "사용 중지" : "다시 사용"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => setConfirming(row)}
                        >
                          {row.kind === "invite" ? "초대 취소" : "매장에서 제외"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}
      </section>
      {invite && (
        <Modal title="직원 초대 링크" onClose={() => setInvite(null)}>
          <div className="stack">
            <p>
              {invite.email}님에게 이 링크를 전달해주세요. 직원이 직접
              비밀번호를 정해요. 한 번만 쓸 수 있고, 다시 발급하면 이전 링크는
              만료돼요. 이메일은 자동으로 보내지 않아요.
            </p>
            <label>
              초대 링크
              <textarea
                className="invite-link"
                value={link}
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
                  await navigator.clipboard.writeText(link);
                  onNotice("초대 링크를 복사했어요.");
                } catch {
                  onNotice("링크를 길게 눌러 직접 복사해주세요.");
                }
              }}
            >
              링크 복사
            </button>
          </div>
        </Modal>
      )}
      {confirming && (
        <Modal
          title={confirming.kind === "invite" ? "초대 취소" : "매장에서 제외"}
          onClose={() => setConfirming(null)}
        >
          <div className="stack">
            <p>
              {confirming.kind === "invite"
                ? `${confirming.name}님에게 보낸 초대 링크를 더 이상 쓸 수 없게 해요.`
                : `${confirming.name}님은 이 매장에 더 이상 들어올 수 없어요. 계정과 작성한 발주안은 남아 있어요.`}
            </p>
            <div className="split-actions">
              <button
                className="button secondary"
                onClick={() => setConfirming(null)}
              >
                그대로 두기
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => remove(confirming)}
              >
                {confirming.kind === "invite" ? "초대 취소" : "제외하기"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

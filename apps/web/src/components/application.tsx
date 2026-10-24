"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import Workspace from "./workspace";

export default function Application() {
  const [invite, setInvite] = useState<string | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(
      "invite",
    );
    if (token) {
      setInvite(token);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);
  return invite ? (
    <AcceptInvitation
      token={invite}
      onDone={(signedUp = false) => {
        if (signedUp) {
          const previous = sessionStorage.getItem("hwagae-session");
          sessionStorage.removeItem("hwagae-session");
          if (previous)
            void api("/auth/logout", previous, { method: "POST" }).catch(
              () => {},
            );
        }
        setInvite(null);
      }}
    />
  ) : (
    <Workspace />
  );
}
function AcceptInvitation({
  token,
  onDone,
}: {
  token: string;
  onDone: (signedUp?: boolean) => void;
}) {
  const [info, setInfo] = useState<{
    email: string;
    merchant_name: string;
    starts_on: string;
    ends_on: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    api<typeof info>("/auth/invitations/inspect", "", {
      method: "POST",
      body: JSON.stringify({ token }),
      signal: c.signal,
    })
      .then((v) => {
        if (!c.signal.aborted) setInfo(v);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : "초대 링크를 확인하지 못했어요.",
          );
      });
    return () => c.abort();
  }, [token]);
  return (
    <main className="invite-page">
      <section className="panel">
        <div className="brand">
          <strong>
            화개장날<span>.</span>
          </strong>
        </div>
        <h1>{done ? "가입이 완료됐어요" : "우리 매장 운영을 시작해요"}</h1>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {done ? (
          <>
            <p>{info?.email}로 로그인해 매장 위치와 상품을 등록하세요.</p>
            <button className="button primary" onClick={() => onDone(true)}>
              로그인으로 이동
            </button>
          </>
        ) : info ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              if (fields.get("password") !== fields.get("confirm")) {
                setError("비밀번호가 일치하지 않아요.");
                return;
              }
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                await api("/auth/invitations/accept", "", {
                  method: "POST",
                  body: JSON.stringify({
                    token,
                    password: fields.get("password"),
                  }),
                });
                setDone(true);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "가입을 완료하지 못했어요.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              <strong>{info.merchant_name}</strong>님을 초대했어요.
              <br />
              {info.email}
              <br />
              계약 기간: {info.starts_on} ~ {info.ends_on}
            </p>
            <label>
              새 비밀번호
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                required
                disabled={busy}
              />
            </label>
            <label>
              비밀번호 확인
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                required
                disabled={busy}
              />
            </label>
            <p className="helper">
              12자 이상으로 설정하세요. 운영자는 이 비밀번호를 볼 수 없어요.
            </p>
            <button className="button primary" disabled={busy}>
              {busy ? "가입 중…" : "비밀번호 설정 · 가입 완료"}
            </button>
          </form>
        ) : !error ? (
          <p role="status">초대를 확인하고 있어요…</p>
        ) : (
          <button className="button secondary" onClick={() => onDone()}>
            로그인으로 이동
          </button>
        )}
      </section>
    </main>
  );
}

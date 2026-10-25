"use client";
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { api } from "@/lib/api";
import {
  androidInviteIntent,
  appInviteUrl,
  inviteFromHash,
  mobilePlatform,
  webInviteUrl,
  type Invite,
  type InviteKind,
} from "@/lib/invite-link";
import Workspace from "./workspace";

export default function Application() {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [appLink, setAppLink] = useState("");
  useEffect(() => {
    // 앱이 초대 링크로 열리면 NativeShell이 주소에 #invite=를 넣는다.
    const read = () => readInvite();
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  function readInvite() {
    // 점주 초대는 #invite=, 직원 초대는 #staff-invite=. 읽은 뒤 주소에서 지운다.
    const found = inviteFromHash(window.location.hash);
    if (!found) return;
    setInvite(found);
    const stayOnWeb = new URLSearchParams(window.location.search).has("noapp");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    // 휴대폰·태블릿 브라우저에서는 앱으로 넘긴다. 앱이 없으면 이 웹 가입 화면이 남는다.
    if (Capacitor.isNativePlatform()) return;
    const platform = mobilePlatform(navigator.userAgent, navigator.maxTouchPoints);
    const link =
      platform === "android"
        ? androidInviteIntent(found, webInviteUrl(window.location.origin, found))
        : platform === "ios"
          ? appInviteUrl(found)
          : "";
    setAppLink(link);
    if (link && !stayOnWeb) window.location.href = link;
  }
  return invite ? (
    <AcceptInvitation
      token={invite.token}
      kind={invite.kind}
      appLink={appLink}
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
  kind,
  appLink,
  onDone,
}: {
  token: string;
  kind: InviteKind;
  appLink: string;
  onDone: (signedUp?: boolean) => void;
}) {
  const [info, setInfo] = useState<{
    email: string;
    merchant_name?: string;
    starts_on?: string;
    ends_on?: string;
    name?: string;
    store_name?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const base =
    kind === "staff" ? "/auth/staff-invitations" : "/auth/invitations";
  useEffect(() => {
    const c = new AbortController();
    api<typeof info>(`${base}/inspect`, "", {
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
  }, [token, base]);
  return (
    <main className="invite-page">
      <section className="panel">
        <div className="brand">
          <strong>
            화개장날<span>.</span>
          </strong>
        </div>
        <h1>
          {done
            ? "가입이 완료됐어요"
            : kind === "staff"
              ? "매장에 함께해요"
              : "우리 매장 운영을 시작해요"}
        </h1>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {appLink && !done && (
          <p className="helper">
            화개장날 앱이 있으면 앱에서 가입할 수 있어요.{" "}
            <a className="text-button" href={appLink}>
              앱에서 열기
            </a>
          </p>
        )}
        {done ? (
          <>
            <p>
              {kind === "staff"
                ? `${info?.email}로 로그인하면 ${info?.store_name} 화면이 열려요.`
                : `${info?.email}로 로그인해 매장 위치와 상품을 등록하세요.`}
            </p>
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
                await api(`${base}/accept`, "", {
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
            {kind === "staff" ? (
              <p>
                <strong>{info.store_name}</strong>에서 <strong>{info.name}</strong>
                님을 직원으로 초대했어요.
                <br />
                {info.email}
              </p>
            ) : (
              <p>
                <strong>{info.merchant_name}</strong>님을 초대했어요.
                <br />
                {info.email}
                <br />
                계약 기간: {info.starts_on} ~ {info.ends_on}
              </p>
            )}
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
              12자 이상으로 설정하세요.{" "}
              {kind === "staff" ? "점주" : "운영자"}는 이 비밀번호를 볼 수 없어요.
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

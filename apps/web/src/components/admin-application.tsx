"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { api, ApiError, type User } from "@/lib/api";
import { BrandLogo } from "./brand-logo";
import { OperatorDashboard } from "./operator-dashboard";

// 매장 화면과 같은 세션을 써서, 예전에 /에서 로그인한 운영자도 그대로 이어서 쓴다.
const SESSION = "hwagae-session";

/** /admin: 서비스 운영자만 로그인한다. 점주·직원 계정은 매장 화면으로 안내한다. */
export default function AdminApplication() {
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState("");
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION);
    setToken("");
    setUser(null);
  }, []);
  const logout = () => {
    void api("/auth/logout", token, { method: "POST" })
      .catch(() => {})
      .finally(clearSession);
  };

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION);
    if (!stored) {
      setRestoring(false);
      return;
    }
    const c = new AbortController();
    api<User>("/auth/me", stored, { signal: c.signal })
      .then((account) => {
        if (c.signal.aborted) return;
        setUser(account);
        setToken(stored);
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401)
          sessionStorage.removeItem(SESSION);
        else
          setRestoreError(
            e instanceof Error ? e.message : "로그인 상태를 확인하지 못했어요.",
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setRestoring(false);
      });
    return () => c.abort();
  }, []);

  if (restoring)
    return (
      <main className="boot-screen">
        <span className="loading-spinner" />
        로그인 상태를 확인하고 있어요.
      </main>
    );
  if (!user)
    return (
      <AdminLogin
        initialError={restoreError}
        onLogin={(value, account) => {
          sessionStorage.setItem(SESSION, value);
          setToken(value);
          setUser(account);
        }}
      />
    );
  if (user.platform_role !== "operator")
    return (
      <main className="boot-screen">
        <section className="connection-retry" role="alert">
          <h1>점주·직원 계정이에요</h1>
          <p>관리자 페이지는 서비스 운영자만 쓸 수 있어요.</p>
          <div className="split-actions">
            <Link href="/" className="button primary">
              매장 화면으로 이동
            </Link>
            <button className="button secondary" onClick={logout}>
              운영자 계정으로 로그인
            </button>
          </div>
        </section>
      </main>
    );
  return (
    <OperatorDashboard
      token={token}
      user={user}
      onExpired={clearSession}
      onLogout={logout}
    />
  );
}

function AdminLogin({
  initialError,
  onLogin,
}: {
  initialError: string;
  onLogin: (token: string, user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [storeAccount, setStoreAccount] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setStoreAccount(false);
    try {
      const result = await api<{ token: string; user: User }>(
        "/auth/login",
        "",
        {
          method: "POST",
          body: JSON.stringify({
            email: fields.get("email"),
            password: fields.get("password"),
          }),
        },
      );
      // 점주·직원 세션은 여기서 쓰지 않으므로 저장하지 않고 바로 닫는다.
      if (result.user.platform_role !== "operator") {
        void api("/auth/logout", result.token, { method: "POST" }).catch(
          () => {},
        );
        setStoreAccount(true);
        return;
      }
      onLogin(result.token, result.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했어요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="invite-page admin-login">
      <section className="panel">
        <div className="brand">
          <span className="brand-icon brand-logo">
            <BrandLogo />
          </span>
          <strong>
            화개장날<span>.</span>
          </strong>
        </div>
        <span className="pill mint">서비스 운영자</span>
        <h1>운영자 로그인</h1>
        <p className="muted">계약·점주·AI 연결을 관리하는 운영자 전용 화면이에요.</p>
        <form className="stack" onSubmit={submit}>
          {storeAccount && (
            <div className="error-banner" role="alert">
              <span>
                점주·직원 계정은 여기서 로그인할 수 없어요.{" "}
                <Link href="/" className="text-button">
                  매장 화면에서 로그인
                </Link>
              </span>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <label>
            이메일
            <input
              name="email"
              type="email"
              autoComplete="username"
              maxLength={200}
              required
              disabled={busy}
            />
          </label>
          <label>
            비밀번호
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={200}
              required
              disabled={busy}
            />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? "확인 중…" : "로그인"}
          </button>
        </form>
      </section>
    </main>
  );
}

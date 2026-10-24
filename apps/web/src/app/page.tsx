"use client";

import { useState } from "react";

const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "");

export default function Home() {
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");

  async function checkApi() {
    setStatus("checking");
    try {
      const response = await fetch(`${apiBaseUrl}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Health check failed");
      const result = await response.json();
      if (result.status !== "ok" || result.service !== "hwagae-jangnal-api") {
        throw new Error("Unexpected API response");
      }
      setStatus("ok");
    } catch {
      setStatus("error");
    }
  }

  const message = {
    idle: "버튼을 눌러 웹과 API의 연결을 확인하세요.",
    checking: "API 응답을 확인하고 있어요.",
    ok: "API 연결 정상. 웹과 서버가 연결됐어요.",
    error: "API에 연결하지 못했어요. 서버 실행과 환경 변수를 확인하세요.",
  }[status];

  return (
    <main>
      <p className="eyebrow">TEAM 화개장터 · DEVELOPMENT</p>
      <h1>화개장날</h1>
      <p className="intro">웹·API·모델을 연결할 기본 개발 환경입니다.</p>

      <section className="connection" aria-labelledby="connection-title">
        <span className="badge">LOCAL SETUP</span>
        <h2 id="connection-title">개발 환경 연결 확인</h2>
        <p role="status" aria-live="polite">{message}</p>
        <div className="actions">
          <button onClick={checkApi} disabled={status === "checking"}>
            {status === "checking" ? "확인 중…" : "API 연결 확인"}
          </button>
          <a href={`${apiBaseUrl}/docs`} target="_blank" rel="noreferrer">
            API 문서 열기 ↗
          </a>
        </div>
      </section>

      <section className="workspaces" aria-label="개발 작업 영역">
        <article><h2>웹</h2><p>Next.js · TypeScript</p><code>apps/web/</code></article>
        <article><h2>API</h2><p>FastAPI · Python 3.14</p><code>apps/api/</code></article>
        <article><h2>모델</h2><p>Colab 학습 코드 작업 공간</p><code>ml/</code></article>
      </section>
      <p className="note">초기 환경만 구성된 상태입니다. 발주 추천·데이터 업로드·모델 학습은 이후 구현합니다.</p>
    </main>
  );
}

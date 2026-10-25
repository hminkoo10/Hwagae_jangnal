"use client";

import { ResponsiveTable } from "./controls";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Product, type Stock, won } from "@/lib/api";
import { Icon } from "./ui";

type Preview = {
  product_count: number;
  sales_count: number;
  inventory_count: number;
  first_date: string;
  last_date: string;
  measured_on: string;
  products: Product[];
  inventory: Record<string, Pick<Stock, "batches" | "incoming">>;
  model: string;
};

export function InitialData({
  token,
  storeId,
  onSaved,
  onSessionExpired,
}: {
  token: string;
  storeId: string;
  onSaved: (message: string) => void;
  onSessionExpired: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function upload(save: boolean) {
    if (!file || lock.current) return;
    lock.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      if (save) body.append("confirmed", String(confirmed));
      const result = await api<Preview>(
        `/stores/${storeId}/initial-data${save ? "" : "/preview"}`,
        token,
        { method: "POST", body, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (save) onSaved("자료를 저장했어요. 7일 판매 예측을 준비할게요.");
      else {
        setPreview(result);
        setConfirmed(false);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : "자료를 가져오지 못했어요.");
      if (e instanceof ApiError && e.status === 401) onSessionExpired();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const step = preview ? 3 : file ? 2 : 1;
  return (
    <section
      className="panel onboarding-panel"
      aria-label="매장 자료 가져오기"
      aria-busy={busy}
    >
      <div className="panel-heading">
        <div>
          <span className="pill mint">처음 시작하기</span>
          <h2>매장 자료 올리기</h2>
          <p>엑셀 파일 하나면 판매 예측과 발주를 바로 시작해요.</p>
        </div>
        <Icon name="upload" size={28} />
      </div>
      <ol className="onboarding-steps">
        {["엑셀 파일 고르기", "내용 확인", "저장하고 시작"].map(
          (label, index) => (
            <li
              key={label}
              className={index + 1 < step ? "done" : undefined}
              aria-current={index + 1 === step ? "step" : undefined}
            >
              {label}
              {index + 1 < step && <Icon name="check" size={14} />}
            </li>
          ),
        )}
      </ol>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <label className="file-zone">
        <Icon name="upload" size={26} />
        <strong>{file?.name ?? "엑셀 파일 고르기"}</strong>
        <span>‘상품’·‘판매’·‘재고’ 시트가 있는 XLSX · 최대 5MB</span>
        <input
          aria-label="매장 자료 엑셀"
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setConfirmed(false);
            setError("");
          }}
        />
      </label>
      {!preview && (
        <button
          className="button primary"
          disabled={!file || busy}
          onClick={() => void upload(false)}
        >
          {busy ? "파일 확인 중…" : "내용 확인하기"}
        </button>
      )}
      {preview && (
        <div className="stack">
          <p>
            상품 <strong>{preview.product_count}개</strong> · 판매 기록{" "}
            <strong>{preview.sales_count.toLocaleString()}건</strong> · 재고{" "}
            <strong>{preview.inventory_count}개 상품</strong>
            <br />
            판매 기간{" "}
            <strong>
              {preview.first_date} ~ {preview.last_date}
            </strong>{" "}
            · 재고 기준일 <strong>{preview.measured_on}</strong>
          </p>
          <div className="table-scroll">
            <ResponsiveTable>
              <thead>
                <tr>
                  <th>상품</th>
                  <th>공급사</th>
                  <th className="number">판매가</th>
                  <th className="number">매입 원가</th>
                  <th>현재 재고 · 판매 가능일</th>
                  <th>입고 예정</th>
                </tr>
              </thead>
              <tbody>
                {preview.products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>{p.id}</small>
                    </td>
                    <td>{p.supplier}</td>
                    <td className="number">{won(p.price)}</td>
                    <td className="number">{won(p.cost)}</td>
                    <td>
                      {preview.inventory[p.id].batches.map((b, i) => (
                        <div key={i}>
                          {b.quantity}개 <small>{b.expires_on}까지</small>
                        </div>
                      ))}
                    </td>
                    <td>
                      {preview.inventory[p.id].incoming.length
                        ? preview.inventory[p.id].incoming.map((b, i) => (
                            <div key={i}>
                              {b.arrives_on} · {b.quantity}개{" "}
                              <small>{b.expires_on}까지 판매</small>
                            </div>
                          ))
                        : "없음"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            재고와 입고 예정이 맞아요. 이 수량으로 저장할게요.
          </label>
          <button
            className="button primary"
            disabled={!confirmed || busy}
            onClick={() => void upload(true)}
          >
            {busy ? "저장 중…" : "저장하고 시작하기"}
          </button>
        </div>
      )}
      <p className="helper">
        이후 판매 기록은 ‘판매 기록’ 메뉴에서 더할 수 있어요.
      </p>
    </section>
  );
}

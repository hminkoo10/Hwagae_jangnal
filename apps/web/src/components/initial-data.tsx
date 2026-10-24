"use client";

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
      if (save)
        onSaved(
          "상품·판매·재고를 저장했어요. 날씨를 반영해 판매 예측을 준비해요.",
        );
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
  return (
    <section
      className="panel onboarding-panel"
      aria-label="매장 자료 가져오기"
      aria-busy={busy}
    >
      <div className="panel-heading">
        <div>
          <span className="pill mint">처음 시작하기</span>
          <h2>우리 매장 자료를 가져오세요</h2>
          <p>상품·판매·재고가 담긴 엑셀 파일 하나로 시작할 수 있어요.</p>
        </div>
        <Icon name="upload" size={28} />
      </div>
      <ol className="onboarding-steps">
        <li>매장 등록</li>
        <li aria-current="step">자료 확인·저장</li>
        <li>판매 예측·발주</li>
      </ol>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <label className="file-zone">
        <strong>{file?.name ?? "엑셀 파일 선택"}</strong>
        <span>상품 / 판매 / 재고 시트 · XLSX · 최대 5MB</span>
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
          <div className="import-summary">
            <div>
              <span>상품</span>
              <strong>{preview.product_count}개</strong>
            </div>
            <div>
              <span>판매 기록</span>
              <strong>{preview.sales_count.toLocaleString()}건</strong>
            </div>
            <div>
              <span>재고 확인</span>
              <strong>{preview.inventory_count}개 상품</strong>
            </div>
          </div>
          <p>
            판매 기간{" "}
            <strong>
              {preview.first_date} ~ {preview.last_date}
            </strong>{" "}
            · 재고 기준일 <strong>{preview.measured_on}</strong>
          </p>
          <div className="table-scroll">
            <table>
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
            </table>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            현재 재고와 입고 예정 목록을 확인했어요. 파일의 수량으로 저장해요.
          </label>
          <button
            className="button primary"
            disabled={!confirmed || busy}
            onClick={() => void upload(true)}
          >
            {busy ? "저장 중…" : "확인한 자료 저장"}
          </button>
        </div>
      )}
      <p className="helper">
        기존 기록을 덮어쓰지 않아요. 상품을 등록한 뒤에는 판매 기록 메뉴에서
        일별 자료를 추가하세요.
      </p>
    </section>
  );
}

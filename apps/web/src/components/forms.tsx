"use client";

import { useState, type FormEvent } from "react";
import {
  api,
  saveBlob,
  units,
  type Preview,
  type Product,
  type SalesData,
  type Stock,
} from "@/lib/api";
import { Empty, Icon, Modal } from "./ui";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "요청에 실패했어요.";
type Common = {
  token: string;
  storeId: string;
  onSaved: (message: string) => void;
};

export function SalesPanel({
  token,
  storeId,
  products,
  sales,
  today,
  onSaved,
}: Common & { products: Product[]; sales: SalesData; today: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const body = new FormData();
      body.append("file", file);
      setPreview(
        await api<Preview>(`/stores/${storeId}/sales/preview`, token, {
          method: "POST",
          body,
        }),
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function save(rows: Preview["rows"]) {
    setBusy(true);
    setError("");
    try {
      await api(`/stores/${storeId}/sales`, token, {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
      setPreview(null);
      setFile(null);
      onSaved(`${rows.length}개 판매 기록을 저장했어요.`);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void save([
      {
        date: String(fields.get("date")),
        product_id: String(fields.get("product_id")),
        units_sold: Number(fields.get("units_sold")),
      },
    ]);
  }

  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="two-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>파일로 한 번에 입력</h2>
              <p>저장 전 내용을 확인할 수 있어요.</p>
            </div>
            <Icon name="upload" />
          </div>
          <form onSubmit={inspect} className="stack">
            <label className="file-zone">
              <Icon name="upload" size={30} />
              <strong>판매 기록 파일 선택</strong>
              <span>CSV · XLSX / 최대 5MB · 10,000행</span>
              <input
                aria-label="판매 기록 파일"
                type="file"
                accept=".csv,.xlsx"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setError("");
                }}
              />
            </label>
            <div className="split-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await saveBlob(
                      new Blob(
                        [
                          `\uFEFFdate,product_id,units_sold\r\n${today},${products[0]?.id ?? "P001"},10\r\n`,
                        ],
                        { type: "text/csv;charset=utf-8" },
                      ),
                      "hwagae-sales-template.csv",
                    );
                  } catch (error) {
                    setError(message(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                CSV 양식 다운로드 ↓
              </button>
              <button className="button primary" disabled={!file || busy}>
                {busy ? "처리 중…" : "미리보기"}
              </button>
            </div>
          </form>
          <p className="helper">
            필수 열: date, product_id, units_sold. 같은 날짜·상품은 자동으로
            덮어쓰지 않아요.
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>직접 입력</h2>
              <p>상품별 하루 판매 개수를 입력하세요.</p>
            </div>
            <Icon name="sales" />
          </div>
          <form className="stack" onSubmit={manual}>
            <div className="form-grid">
              <label>
                판매일
                <input
                  name="date"
                  type="date"
                  defaultValue={today}
                  max={today}
                  required
                />
              </label>
              <label>
                상품
                <select name="product_id" required>
                  {products.map((product) => (
                    <option value={product.id} key={product.id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              판매 개수
              <input
                name="units_sold"
                type="number"
                min="0"
                max="1000000"
                step="1"
                placeholder="예: 25"
                required
              />
            </label>
            <button
              className="button primary align-end"
              disabled={busy || !products.length}
            >
              판매 기록 저장
            </button>
          </form>
        </section>
      </div>
      {preview && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>가져오기 미리보기</h2>
              <p>
                {preview.rows.length}개 해석 · 오류 {preview.errors.length}개 ·
                아직 저장하지 않았어요.
              </p>
            </div>
            <button
              className="button primary"
              disabled={!preview.can_save || busy}
              onClick={() => void save(preview.rows)}
            >
              확인 후 저장
            </button>
          </div>
          {preview.errors.length > 0 && (
            <div className="error-list" role="alert">
              {preview.errors.slice(0, 20).map((error, index) => (
                <p key={index}>
                  {error.row}행 — {error.message}
                </p>
              ))}
              {preview.errors.length > 20 && (
                <p>외 {preview.errors.length - 20}개 오류</p>
              )}
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>판매일</th>
                  <th>상품코드</th>
                  <th className="number">판매 개수</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 10).map((row, index) => (
                  <tr key={index}>
                    <td>{row.date}</td>
                    <td>{row.product_id}</td>
                    <td className="number">{units(row.units_sold)}개</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 10 && (
            <p className="helper">처음 10개 기록을 표시하고 있어요.</p>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>최근 판매 기록</h2>
            <p>
              전체 {sales.summary.count.toLocaleString()}개 ·{" "}
              {sales.summary.first_date ?? "—"} ~{" "}
              {sales.summary.last_date ?? "—"}
            </p>
          </div>
          <span className="pill">최근 50개</span>
        </div>
        {!sales.rows.length ? (
          <Empty title="첫 판매 기록을 입력해보세요">
            상품 등록 후 파일 또는 직접 입력을 이용할 수 있어요.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>판매일</th>
                  <th>상품</th>
                  <th>자료 구분</th>
                  <th className="number">판매 개수</th>
                </tr>
              </thead>
              <tbody>
                {sales.rows.map((row) => (
                  <tr key={`${row.date}-${row.product_id}`}>
                    <td>{row.date}</td>
                    <td>
                      {row.name}
                      <small>{row.product_id}</small>
                    </td>
                    <td>
                      <span
                        className={`pill ${row.source === "synthetic_demo" ? "neutral" : "mint"}`}
                      >
                        {row.source === "synthetic_demo"
                          ? "가상 샘플"
                          : "사용자 입력"}
                      </span>
                    </td>
                    <td className="number">{units(row.units_sold)}개</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

type BatchFields = { quantity: string; expires_on: string };
type IncomingFields = BatchFields & { arrives_on: string };

export function InventoryModal({
  token,
  storeId,
  product,
  stock,
  today,
  onSaved,
  onClose,
}: Common & {
  product: Product;
  stock?: Stock;
  today: string;
  onClose: () => void;
}) {
  const [batches, setBatches] = useState<BatchFields[]>(
    stock?.batches.map((row) => ({
      ...row,
      quantity: String(row.quantity),
    })) ?? [{ quantity: "", expires_on: "" }],
  );
  const [incoming, setIncoming] = useState<IncomingFields[]>(
    stock?.incoming.map((row) => ({
      ...row,
      quantity: String(row.quantity),
    })) ?? [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [zero, setZero] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nextDate = new Date(`${today}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const earliestArrival = nextDate.toISOString().slice(0, 10);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!zero && !batches.length)
        throw new Error("재고를 입력하거나 재고 0개를 선택하세요.");
      const body = {
        batches: zero
          ? []
          : batches
              .filter((row) => Number(row.quantity) > 0)
              .map((row) => ({
                quantity: Number(row.quantity),
                expires_on: row.expires_on,
              })),
        incoming: incoming.map((row) => ({
          ...row,
          quantity: Number(row.quantity),
        })),
        incoming_confirmed: confirmed,
      };
      await api(`/stores/${storeId}/inventory/${product.id}`, token, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      onSaved(`${product.name} 재고를 확인했어요.`);
      onClose();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="재고 확인" onClose={onClose}>
      <p className="modal-description">
        {product.name} · {product.id}
        <br />
        오늘({today}) 마감 기준 수량을 입력하세요. 만료일 당일까지 판매
        가능하며, 이후 재고는 제외해요.
      </p>
      <form onSubmit={submit} className="stack">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={zero}
            onChange={(event) => setZero(event.target.checked)}
          />
          실사 결과 현재 재고가 0개예요
        </label>
        {!zero && (
          <>
            <div className="section-label">현재 재고 · 만료일별로 입력</div>
            {batches.map((batch, index) => (
              <div className="batch-row" key={index}>
                <label>
                  수량(개)
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="1"
                    required
                    value={batch.quantity}
                    onChange={(event) =>
                      setBatches(
                        batches.map((row, i) =>
                          i === index
                            ? { ...row, quantity: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  판매 가능 마지막 날
                  <input
                    type="date"
                    required={Number(batch.quantity) > 0}
                    value={batch.expires_on}
                    onChange={(event) =>
                      setBatches(
                        batches.map((row, i) =>
                          i === index
                            ? { ...row, expires_on: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${index + 1}번째 재고 삭제`}
                  onClick={() =>
                    setBatches(batches.filter((_, i) => i !== index))
                  }
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setBatches([...batches, { quantity: "", expires_on: "" }])
              }
            >
              + 다른 만료일 재고 추가
            </button>
          </>
        )}
        <div className="section-label">입고 예정 {incoming.length}건</div>
        {incoming.map((batch, index) => (
          <div className="incoming-row" key={index}>
            <label>
              수량(개)
              <input
                type="number"
                min="1"
                max="1000000"
                step="1"
                required
                value={batch.quantity}
                onChange={(event) =>
                  setIncoming(
                    incoming.map((row, i) =>
                      i === index
                        ? { ...row, quantity: event.target.value }
                        : row,
                    ),
                  )
                }
              />
            </label>
            <label>
              입고일
              <input
                type="date"
                min={earliestArrival}
                required
                value={batch.arrives_on}
                onChange={(event) =>
                  setIncoming(
                    incoming.map((row, i) =>
                      i === index
                        ? { ...row, arrives_on: event.target.value }
                        : row,
                    ),
                  )
                }
              />
            </label>
            <label>
              만료일
              <input
                type="date"
                min={batch.arrives_on}
                required
                value={batch.expires_on}
                onChange={(event) =>
                  setIncoming(
                    incoming.map((row, i) =>
                      i === index
                        ? { ...row, expires_on: event.target.value }
                        : row,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`${index + 1}번째 입고 예정 삭제`}
              onClick={() =>
                setIncoming(incoming.filter((_, i) => i !== index))
              }
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setIncoming([
              ...incoming,
              { quantity: "", arrives_on: "", expires_on: "" },
            ])
          }
        >
          + 예정된 입고 추가
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          입고 예정 목록을 확인했어요. 목록이 비어 있으면 예정 입고가 없어요.
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? "저장 중…" : "재고 확인 · 저장"}
        </button>
      </form>
    </Modal>
  );
}

export function ProductModal({
  token,
  storeId,
  product,
  onSaved,
  onClose,
}: Common & { product?: Product; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    const settings = Object.fromEntries(
      ["price", "cost", "lead_days", "shelf_days", "review_days"].map((key) => [
        key,
        Number(fields.get(key)),
      ]),
    );
    try {
      const body = product
        ? settings
        : {
            ...settings,
            ...Object.fromEntries(
              ["id", "name", "category", "supplier"].map((key) => [
                key,
                String(fields.get(key)).trim(),
              ]),
            ),
          };
      await api(
        `/stores/${storeId}/products${product ? "/" + product.id : ""}`,
        token,
        { method: product ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      onSaved(
        product
          ? "상품 설정을 저장했어요. 예측과 발주안을 새로 확인해주세요."
          : "상품을 등록했어요.",
      );
      onClose();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={product ? "상품 설정" : "상품 등록"} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {product ? (
          <p className="modal-description">
            {product.name} · {product.id}
          </p>
        ) : (
          <div className="form-grid">
            {[
              ["id", "상품코드", "P001"],
              ["name", "상품명", "햄치즈 샌드위치"],
              ["category", "분류", "간편식"],
              ["supplier", "공급사", "화개푸드"],
            ].map(([key, label, placeholder]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  placeholder={placeholder}
                  maxLength={key === "id" ? 40 : key === "category" ? 40 : 80}
                  pattern={key === "id" ? "[A-Za-z0-9_-]+" : undefined}
                  required
                />
              </label>
            ))}
          </div>
        )}
        <div className="form-grid">
          {[
            { key: "price", label: "판매가(원)", min: 0, max: 1000000 },
            { key: "cost", label: "개당 매입 원가(원)", min: 0, max: 1000000 },
            {
              key: "lead_days",
              label: "발주 후 입고까지(일)",
              min: 1,
              max: 30,
            },
            {
              key: "shelf_days",
              label: "입고일부터 판매 가능 기간(일)",
              min: 1,
              max: 365,
            },
            { key: "review_days", label: "다음 발주까지(일)", min: 1, max: 7 },
          ].map(({ key, label, min, max }) => (
            <label key={key}>
              {label}
              <input
                name={key}
                type="number"
                min={min}
                max={max}
                step="1"
                required
                defaultValue={
                  product
                    ? product[key as keyof Product]
                    : key.includes("days")
                      ? 1
                      : undefined
                }
              />
            </label>
          ))}
        </div>
        <p className="helper">
          입고는 해당 날짜 시작, 만료는 해당 날짜 마감 기준이에요. 필요한 수요가
          7일을 넘으면 발주 계산을 보류해요.
        </p>
        <button className="button primary" disabled={busy}>
          {busy ? "저장 중…" : "상품 저장"}
        </button>
      </form>
    </Modal>
  );
}

export function StoreModal({
  token,
  onSaved,
  onClose,
}: {
  token: string;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    try {
      const result = await api<{ id: string }>("/stores", token, {
        method: "POST",
        body: JSON.stringify({
          name: fields.get("name"),
          city: fields.get("city"),
          latitude: Number(fields.get("latitude")),
          longitude: Number(fields.get("longitude")),
        }),
      });
      onSaved(result.id);
      onClose();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="매장 추가" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <label>
          매장명
          <input name="name" maxLength={80} required />
        </label>
        <label>
          지역 이름
          <input
            name="city"
            placeholder="예: 광주 동명동"
            maxLength={80}
            required
          />
        </label>
        <div className="form-grid">
          <label>
            위도
            <input
              name="latitude"
              type="number"
              step="any"
              min="-90"
              max="90"
              placeholder="35.1477"
              required
            />
          </label>
          <label>
            경도
            <input
              name="longitude"
              type="number"
              step="any"
              min="-180"
              max="180"
              placeholder="126.9256"
              required
            />
          </label>
        </div>
        <p className="helper">
          현재 국내 매장용으로 날짜를 한국 시간에 맞춰 계산해요.
        </p>
        <button className="button primary" disabled={busy}>
          {busy ? "추가 중…" : "매장 추가"}
        </button>
      </form>
    </Modal>
  );
}

"use client";

import { LocationPicker, type Location } from "./location-picker";

import { Select, DateField, ResponsiveTable } from "./controls";

import { useRef, useState, type FormEvent } from "react";
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
import { PriceField, ProductCategoryField } from "./product-fields";
import { AiProductMemo } from "./ai-memo";

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
              <h2>파일로 올리기</h2>
              <p>여러 날 기록을 한 번에 올리고, 확인 후 저장해요.</p>
            </div>
            <Icon name="upload" />
          </div>
          <form onSubmit={inspect} className="stack">
            <label className="file-zone">
              <Icon name="upload" size={30} />
              <strong>{file?.name ?? "판매 기록 파일 고르기"}</strong>
              <span>CSV · XLSX · 최대 5MB · 1만 줄</span>
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
                빈 양식 받기 ↓
              </button>
              <button className="button primary" disabled={!file || busy}>
                {busy ? "확인 중…" : "내용 확인"}
              </button>
            </div>
          </form>
          <p className="helper">
            양식의 열 이름은 그대로 두세요. 이미 있는 날짜·상품은 덮어쓰지 않아요.
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>직접 입력</h2>
              <p>하루에 판 개수를 상품별로 적어요.</p>
            </div>
            <Icon name="sales" />
          </div>
          <form className="stack" onSubmit={manual}>
            <div className="form-grid">
              <label>
                판매일
                <DateField
                  name="date"
                  defaultValue={today}
                  max={today}
                  required
                />
              </label>
              <label>
                상품
                <Select name="product_id" required>
                  {products.map((product) => (
                    <option value={product.id} key={product.id}>
                      {product.name}
                    </option>
                  ))}
                </Select>
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
            {!products.length && (
              <p className="helper">상품을 먼저 등록하면 적을 수 있어요.</p>
            )}
          </form>
        </section>
      </div>
      {preview && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>파일 내용 확인</h2>
              <p>
                {preview.rows.length}건 읽음 · 오류 {preview.errors.length}건 ·
                아직 저장 전이에요.
              </p>
            </div>
            <button
              className="button primary"
              disabled={!preview.can_save || busy}
              onClick={() => void save(preview.rows)}
            >
              이대로 저장
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
            <ResponsiveTable>
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
            </ResponsiveTable>
          </div>
          {preview.rows.length > 10 && (
            <p className="helper">앞의 10건만 보여드려요.</p>
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
          <Empty title="아직 판매 기록이 없어요">
            {products.length
              ? "위에서 파일을 올리거나 직접 적어보세요."
              : "상품을 먼저 등록해주세요."}
          </Empty>
        ) : (
          <div className="table-scroll">
            <ResponsiveTable>
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
            </ResponsiveTable>
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
        오늘({today}) 마감 때 남은 개수를 적어요. 판매 마지막 날이 지나면
        빼고 계산해요.
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
          남은 재고가 하나도 없어요 (0개)
        </label>
        {!zero && (
          <>
            <div className="section-label">남은 재고 · 판매 마지막 날별로</div>
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
                  <DateField
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
              + 마지막 날이 다른 재고 추가
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
              <DateField
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
              판매 마지막 날
              <DateField
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
          + 입고 예정 추가
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          입고 예정까지 확인했어요 (없으면 비워두세요)
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? "저장 중…" : "재고 저장"}
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
  const form = useRef<HTMLFormElement>(null);
  const [fill, setFill] = useState<Record<string, string | number>>({});
  const [fillVersion, setFillVersion] = useState(0);
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
        ? { ...settings, category: String(fields.get("category")).trim() }
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
    <Modal
      title={product ? "상품 정보 수정" : "상품 등록"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form ref={form} onSubmit={submit} className="stack">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!product && (
          <p className="modal-description">
            가격과 도착 일수를 적으면 추천 발주량을 계산해요.
          </p>
        )}
        {!product && (
          <AiProductMemo
            token={token}
            storeId={storeId}
            onApply={(fields) => {
              const current = form.current
                ? Object.fromEntries(new FormData(form.current))
                : {};
              setFill({
                ...Object.fromEntries(
                  Object.entries(current)
                    .filter(
                      ([name, value]) =>
                        !(
                          ["price", "cost"].includes(name) &&
                          String(value) === ""
                        ),
                    )
                    .map(([name, value]) => [name, String(value)]),
                ),
                ...fields,
              });
              setFillVersion((value) => value + 1);
            }}
          />
        )}
        <div key={fillVersion} className="stack">
          {product ? (
            <p className="modal-description">
              {product.name} · {product.id}
            </p>
          ) : (
            <div className="form-grid">
              {[
                ["id", "상품 코드", "예: P001"],
                ["name", "상품 이름", "예: 햄치즈 샌드위치"],
                ["supplier", "상품을 받는 곳", "예: 화개푸드"],
              ].map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <input
                    name={key}
                    defaultValue={fill[key]}
                    placeholder={placeholder}
                    maxLength={key === "id" ? 40 : 80}
                    pattern={key === "id" ? "[A-Za-z0-9_-]+" : undefined}
                    required
                    disabled={busy}
                  />
                </label>
              ))}
            </div>
          )}
          <div className="form-grid">
            <ProductCategoryField
              value={String(fill.category ?? product?.category ?? "")}
              disabled={busy}
            />
          </div>
          <div className="form-grid">
            <PriceField
              name="price"
              label="판매 가격"
              defaultValue={
                fill.price === undefined ? product?.price : Number(fill.price)
              }
              disabled={busy}
            />
            <PriceField
              name="cost"
              label="한 개를 사오는 가격"
              defaultValue={
                fill.cost === undefined ? product?.cost : Number(fill.cost)
              }
              disabled={busy}
            />
          </div>
          <div className="form-grid">
            {[
              {
                key: "lead_days",
                label: "발주하면 며칠 뒤에 오나요?",
                hint: "예: 다음 날 도착하면 1일",
                min: 1,
                max: 30,
              },
              {
                key: "shelf_days",
                label: "유통기한 (받은 날부터)",
                hint: "예: 받은 날과 다음 날까지 판매하면 2일",
                min: 1,
                max: 365,
              },
              {
                key: "review_days",
                label: "며칠마다 발주하나요?",
                hint: "예: 매일 발주하면 1일",
                min: 1,
                max: 7,
              },
            ].map(({ key, label, hint, min, max }) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  type="number"
                  min={min}
                  max={max}
                  step="1"
                  required
                  disabled={busy}
                  defaultValue={
                    fill[key] ??
                    (product
                      ? product[key as keyof Product]
                      : key.includes("days")
                        ? 1
                        : undefined)
                  }
                />
                <small className="field-description">{hint}</small>
              </label>
            ))}
          </div>
        </div>
        <p className="helper">
          도착 일수와 발주 간격을 더해 7일이 넘으면 추천 수량이 나오지 않아요.
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
  const [location, setLocation] = useState<Location | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!location || busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/stores", token, {
        method: "POST",
        body: JSON.stringify({ name: fields.get("name"), ...location }),
      });
      onSaved(result.id);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="매장 추가"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        <p className="modal-description">
          위치를 정하면 그 지역 날씨를 예측에 반영해요.
        </p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <label>
          매장명
          <input name="name" maxLength={80} required disabled={busy} />
        </label>
        <fieldset disabled={busy} className="location-fieldset">
          <legend>매장 위치</legend>
          <LocationPicker token={token} onChange={setLocation} />
        </fieldset>
        <button className="button primary" disabled={busy || !location}>
          {busy ? "추가 중…" : "매장 추가"}
        </button>
      </form>
    </Modal>
  );
}

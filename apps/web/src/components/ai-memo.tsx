"use client";

import { type CSSProperties, useRef, useState } from "react";
import { api, type Product, won } from "@/lib/api";
import { DateField, ResponsiveTable, Select } from "./controls";
import { AiThinking } from "./ai-answer";
import {
  AiError,
  type AiAccess,
  type AiRun,
  useAiRequest,
} from "./ai-assistant";

type SalesRow = { date: string; product_id: string; units_sold: number };
type SalesDraft = {
  rows: SalesRow[];
  unresolved: string[];
  existing: { date: string; product_id: string }[];
};
type EditableRow = Omit<SalesRow, "units_sold"> & { units_sold: string };

const stagger = (index: number) =>
  ({ "--ai-delay": `${Math.min(index, 8) * 90}ms` }) as CSSProperties;

// "2026-10-30 콜라 3개: 기준일 이후 날짜라 기록할 수 없어요." → line + reason.
function skippedLine(item: string, today: string) {
  const text = item.replace(
    /(\d{4})-(\d{2})-(\d{2})/g,
    (_, year: string, month: string, day: string) =>
      `${year === today.slice(0, 4) ? "" : `${year}년 `}${Number(month)}월 ${Number(day)}일`,
  );
  const at = text.indexOf(": ");
  return at > 0 && at < text.length - 2
    ? { line: text.slice(0, at), reason: text.slice(at + 2) }
    : { line: "", reason: text };
}

function SkippedLines({ items, today }: { items: string[]; today: string }) {
  return (
    <div className="assistant-skipped" role="note">
      <strong>아래 내용은 표에 넣지 않았어요</strong>
      <ul>
        {items.map((item, index) => {
          const { line, reason } = skippedLine(item, today);
          return (
            <li key={index} style={stagger(index)}>
              {line && <b>{line}</b>}
              <span>{reason}</span>
            </li>
          );
        })}
      </ul>
      <p>저장되지 않아요. 필요하면 메모를 고쳐 다시 정리해주세요.</p>
    </div>
  );
}

export function AiSalesMemo({
  products,
  today,
  onSaved,
  ...access
}: AiAccess & {
  products: Product[];
  today: string;
  onSaved: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saveLock = useRef(false);
  const assistant = useAiRequest<AiRun & { draft: SalesDraft }>(access);
  const busy = saving || assistant.busy;
  const duplicate = rows.some((row) =>
    assistant.result?.draft.existing.some(
      (item) => item.date === row.date && item.product_id === row.product_id,
    ),
  );
  const valid =
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.date &&
        row.date <= today &&
        row.product_id &&
        /^\d+$/.test(row.units_sold) &&
        Number(row.units_sold) <= 1000000,
    );
  function edit(index: number, field: keyof EditableRow, value: string) {
    setRows((previous) =>
      previous.map((row, i) =>
        i === index ? { ...row, [field]: value } : row,
      ),
    );
    setConfirmed(false);
    setSaveError("");
  }
  async function save() {
    if (busy || saveLock.current || !confirmed || !valid || duplicate) return;
    saveLock.current = true;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/stores/${access.storeId}/sales`, access.token, {
        method: "POST",
        body: JSON.stringify({
          rows: rows.map((row) => ({
            ...row,
            units_sold: Number(row.units_sold),
          })),
        }),
      });
      assistant.clear();
      setRows([]);
      setText("");
      setConfirmed(false);
      onSaved(`${rows.length}개 판매 기록을 저장했어요.`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "저장하지 못했어요.");
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="panel assistant-panel" aria-busy={busy}>
      <div className="panel-heading">
        <div>
          <h2>메모로 판매 기록 입력</h2>
          <p>상품 이름과 팔린 개수를 적으면 입력할 표로 정리해요.</p>
        </div>
      </div>
      <label className="assistant-label">
        판매 메모
        <textarea
          className="assistant-field"
          rows={3}
          value={text}
          maxLength={6000}
          disabled={busy}
          placeholder={`예: 오늘 ${products[0]?.name ?? "바나나 우유"} 12개, 어제 ${products[1]?.name ?? "소금빵"} 8개 팔았어`}
          onChange={(e) => {
            setText(e.target.value);
            setRows([]);
            setConfirmed(false);
            assistant.clear();
            setSaveError("");
          }}
        />
      </label>
      <p className="helper">
        ‘오늘’은 매장 날짜 {today} 기준이에요. 없는 상품이나 모호한 내용은 따로
        알려드려요.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={busy || !products.length || text.trim().length < 2}
        onClick={async () => {
          setSaveError("");
          setRows([]);
          setConfirmed(false);
          const result = await assistant.run("draft-sales", {
            text: text.trim(),
            base_date: today,
          });
          if (result)
            setRows(
              result.draft.rows.map((row) => ({
                ...row,
                units_sold: String(row.units_sold),
              })),
            );
        }}
      >
        {assistant.busy ? "정리하는 중…" : "입력할 내용 정리"}
      </button>
      {assistant.busy && (
        <AiThinking
          label="메모를 표로 정리하고 있어요"
          steps={["상품 이름을 맞춰보고 있어요", "날짜와 개수를 확인하고 있어요"]}
        />
      )}
      <AiError error={assistant.error || saveError} />
      {assistant.result && (
        <div className="assistant-preview">
          {assistant.result.draft.rows.length > 0 && (
            <p className="assistant-draft-note">
              메모에서 판매 기록 {assistant.result.draft.rows.length}건을
              찾았어요. 확인한 뒤 저장해주세요.
            </p>
          )}
          {assistant.result.draft.unresolved.length > 0 && (
            <SkippedLines
              items={assistant.result.draft.unresolved}
              today={today}
            />
          )}
          {duplicate && (
            <p className="assistant-notice">
              이미 저장된 날짜·상품이 있어요. 해당 줄을 삭제하거나 날짜·상품을
              확인해주세요. 덮어쓰지 않아요.
            </p>
          )}
          {rows.length > 0 && (
            <>
              <div className="table-scroll">
                <ResponsiveTable>
                  <thead>
                    <tr>
                      <th>날짜</th>
                      <th>상품</th>
                      <th>판매 개수</th>
                      <th>삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={index}
                        className="assistant-row"
                        style={stagger(index)}
                      >
                        <td>
                          <DateField
                            aria-label={`${index + 1}번째 판매일`}
                            value={row.date}
                            max={today}
                            disabled={busy}
                            onChange={(e) =>
                              edit(index, "date", e.target.value)
                            }
                          />
                        </td>
                        <td>
                          <Select
                            aria-label={`${index + 1}번째 상품`}
                            value={row.product_id}
                            disabled={busy}
                            onChange={(e) =>
                              edit(index, "product_id", e.target.value)
                            }
                          >
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td>
                          <input
                            aria-label={`${index + 1}번째 판매 개수`}
                            type="number"
                            min="0"
                            max="1000000"
                            step="1"
                            inputMode="numeric"
                            value={row.units_sold}
                            disabled={busy}
                            onChange={(e) =>
                              edit(index, "units_sold", e.target.value)
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              setRows(rows.filter((_, i) => i !== index));
                              setConfirmed(false);
                            }}
                          >
                            삭제
                          </button>
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
                날짜·상품·개수를 확인했어요. 위 {rows.length}건만 저장할게요.
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !confirmed || !valid || duplicate}
                onClick={() => void save()}
              >
                {saving ? "저장 중…" : `${rows.length}건 저장`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export type ProductFill = Partial<Omit<Product, "id" | "active">>;
const FIELD_NAMES: Record<string, string> = {
  name: "상품 이름",
  category: "상품 종류",
  supplier: "상품을 받는 곳",
  price: "판매 가격",
  cost: "매입 가격",
  lead_days: "입고까지",
  shelf_days: "유통기한",
  review_days: "발주 간격",
};

export function AiProductMemo({
  onApply,
  ...access
}: AiAccess & { onApply: (fields: ProductFill) => void }) {
  const [text, setText] = useState("");
  const [applied, setApplied] = useState(false);
  const assistant = useAiRequest<AiRun & { draft: ProductFill }>(access);
  return (
    <details className="assistant-product">
      <summary>상품 설명으로 입력 줄이기</summary>
      <label className="assistant-label">
        상품 메모
        <textarea
          className="assistant-field"
          rows={3}
          value={text}
          maxLength={6000}
          disabled={assistant.busy}
          placeholder="예: 딸기 우유, 판매가 2,000원, 매입가 1,200원, 화개유업에서 받아요."
          onChange={(e) => {
            setText(e.target.value);
            setApplied(false);
            assistant.clear();
          }}
        />
      </label>
      <p className="helper">
        종류는 이름으로 추천해요. 가격·기간은 적어주신 내용만 채워요.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={assistant.busy || text.trim().length < 2}
        onClick={() => {
          setApplied(false);
          void assistant.run("draft-product", { text: text.trim() });
        }}
      >
        {assistant.busy ? "읽는 중…" : "입력할 내용 정리"}
      </button>
      {assistant.busy && (
        <AiThinking
          label="상품 설명을 읽고 있어요"
          steps={["가격과 기간을 찾고 있어요", "입력할 내용을 정리하고 있어요"]}
        />
      )}
      <AiError error={assistant.error} />
      {assistant.result && (
        <div className="assistant-preview">
          <dl className={`assistant-fields${applied ? " is-applied" : ""}`}>
            {Object.entries(assistant.result.draft).map(([field, value], index) => (
              <div key={field} style={stagger(index)}>
                <dt>{FIELD_NAMES[field]}</dt>
                <dd>
                  {typeof value === "number"
                    ? field === "price" || field === "cost"
                      ? won(value)
                      : `${value}일`
                    : value}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="button secondary"
            disabled={applied}
            onClick={() => {
              if (assistant.result) {
                onApply(assistant.result.draft);
                setApplied(true);
              }
            }}
          >
            {applied ? "입력란에 채웠어요" : "확인하고 입력란에 채우기"}
          </button>
          <p className="helper">
            아직 저장되지 않았어요. 비어 있는 항목도 확인한 뒤 상품을
            저장해주세요.
          </p>
        </div>
      )}
    </details>
  );
}

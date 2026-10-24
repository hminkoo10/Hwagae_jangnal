"use client";

import { Select, DateField, ResponsiveTable } from "./controls";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  api,
  addCalendarDays,
  ApiError,
  download,
  isOrderDateInWindow,
  units,
  won,
  type ModelDemoOrder,
  type ModelDemoPlanning,
  type ModelDemoPlanningItem,
  type ModelDemoRecommendation,
} from "@/lib/api";
import { Icon, Modal } from "./ui";
import styles from "./model-ordering.module.css";

type ItemInput = Omit<ModelDemoPlanningItem, "name" | "supplier">;
type LineInput = { product_id: string; quantity: number };
type Quantities = Record<string, string>;
type BatchInput = { quantity: string; expires_on: string };
type IncomingInput = BatchInput & { arrives_on: string };

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "요청을 처리하지 못했어요.";
const validQuantity = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) && Number(value) <= 7_000_000;
const itemInput = ({
  product_id,
  price,
  cost,
  lead_days,
  shelf_days,
  review_days,
  stock,
}: ModelDemoPlanningItem): ItemInput => ({
  product_id,
  price,
  cost,
  lead_days,
  shelf_days,
  review_days,
  stock,
});
const orderQuantities = (order: ModelDemoOrder) =>
  Object.fromEntries(
    order.lines.map((line) => [line.product_id, String(line.quantity)]),
  );
function tomorrow(asOf: string) {
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function PlanningItemModal({
  item,
  asOf,
  busy,
  onSave,
  onClose,
}: {
  item: ModelDemoPlanningItem;
  asOf: string;
  busy: boolean;
  onSave: (item: ItemInput) => Promise<void>;
  onClose: () => void;
}) {
  const nextDay = tomorrow(asOf);
  const [settings, setSettings] = useState({
    price: String(item.price),
    cost: String(item.cost),
    lead_days: String(item.lead_days),
    shelf_days: String(item.shelf_days),
    review_days: String(item.review_days),
  });
  const [mode, setMode] = useState<"unknown" | "zero" | "batches">(
    !item.stock ? "unknown" : item.stock.batches.length ? "batches" : "zero",
  );
  const [batches, setBatches] = useState<BatchInput[]>(
    item.stock?.batches.map((row) => ({
      ...row,
      quantity: String(row.quantity),
    })) ?? [],
  );
  const [incoming, setIncoming] = useState<IncomingInput[]>(
    item.stock?.incoming.map((row) => ({
      ...row,
      quantity: String(row.quantity),
    })) ?? [],
  );
  const [confirmed, setConfirmed] = useState(
    item.stock?.incoming_confirmed ?? false,
  );
  const [error, setError] = useState("");
  const settingFields = [
    ["price", "판매가 (원)", 0, 1_000_000],
    ["cost", "매입 원가 (원)", 0, 1_000_000],
    ["lead_days", "입고까지 (일)", 1, 30],
    ["shelf_days", "입고 후 판매 가능 기간 (일)", 1, 365],
    ["review_days", "다음 발주 검토까지 (일)", 1, 7],
  ] as const;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (mode === "batches" && !batches.length) {
      setError("재고 배치를 추가하거나 ‘0개 확인’을 선택해주세요.");
      return;
    }
    if (mode !== "unknown" && !confirmed) {
      setError("입고 예정 목록을 확인해주세요. 입고가 없어도 확인이 필요해요.");
      return;
    }
    try {
      await onSave({
        product_id: item.product_id,
        price: Number(settings.price),
        cost: Number(settings.cost),
        lead_days: Number(settings.lead_days),
        shelf_days: Number(settings.shelf_days),
        review_days: Number(settings.review_days),
        stock:
          mode === "unknown"
            ? null
            : {
                batches:
                  mode === "zero"
                    ? []
                    : batches.map((row) => ({
                        quantity: Number(row.quantity),
                        expires_on: row.expires_on,
                      })),
                incoming: incoming.map((row) => ({
                  ...row,
                  quantity: Number(row.quantity),
                })),
                incoming_confirmed: true,
              },
      });
    } catch (cause) {
      setError(message(cause));
    }
  }

  return (
    <Modal
      title="시연 재고·가정 입력"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className={styles.assumptions}>
        {item.name}
        <br />
        {asOf} 마감 기준이에요. 가격·기간·재고는 이 계정의 시연 가정으로
        저장해요.
      </p>
      <form className={styles.modalForm} onSubmit={submit}>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <fieldset className={styles.fields} disabled={busy}>
          <div className={styles.formGrid}>
            {settingFields.map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={min}
                  max={max}
                  step="1"
                  required
                  value={settings[key]}
                  onChange={(event) =>
                    setSettings({ ...settings, [key]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className={styles.formSection}>
            <label>
              재고 상태
              <Select
                value={mode}
                onChange={(event) => {
                  const next = event.target.value as typeof mode;
                  setMode(next);
                  if (next === "batches" && !batches.length)
                    setBatches([{ quantity: "", expires_on: nextDay }]);
                }}
              >
                <option value="unknown">아직 확인하지 않음</option>
                <option value="zero">현재 재고 0개 확인</option>
                <option value="batches">만료일별 재고 입력</option>
              </Select>
            </label>
            <p className={styles.muted}>
              미입력 재고는 0개로 계산하지 않아요. 판매 가능 마지막 날은{" "}
              {nextDay}부터 입력해요.
            </p>
          </div>
          {mode === "batches" && (
            <div className={styles.formSection}>
              <strong>현재 재고</strong>
              {batches.map((batch, index) => (
                <div className={styles.stockRow} key={index}>
                  <label>
                    수량 (개)
                    <input
                      type="number"
                      min="1"
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
                      min={nextDay}
                      required
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
                disabled={batches.length >= 100}
                onClick={() =>
                  setBatches([
                    ...batches,
                    { quantity: "", expires_on: nextDay },
                  ])
                }
              >
                + 재고 배치 추가
              </button>
            </div>
          )}
          {mode !== "unknown" && (
            <div className={styles.formSection}>
              <strong>입고 예정 · {incoming.length}건</strong>
              {incoming.map((batch, index) => (
                <div className={styles.incomingRow} key={index}>
                  <label>
                    수량 (개)
                    <input
                      type="number"
                      min="1"
                      max="1000000"
                      step="1"
                      required
                      value={batch.quantity}
                      onChange={(event) => {
                        setConfirmed(false);
                        setIncoming(
                          incoming.map((row, i) =>
                            i === index
                              ? { ...row, quantity: event.target.value }
                              : row,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label>
                    입고일
                    <DateField
                      min={nextDay}
                      required
                      value={batch.arrives_on}
                      onChange={(event) => {
                        setConfirmed(false);
                        setIncoming(
                          incoming.map((row, i) =>
                            i === index
                              ? { ...row, arrives_on: event.target.value }
                              : row,
                          ),
                        );
                      }}
                    />
                  </label>
                  <label>
                    판매 가능 마지막 날
                    <DateField
                      min={batch.arrives_on || nextDay}
                      required
                      value={batch.expires_on}
                      onChange={(event) => {
                        setConfirmed(false);
                        setIncoming(
                          incoming.map((row, i) =>
                            i === index
                              ? { ...row, expires_on: event.target.value }
                              : row,
                          ),
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${index + 1}번째 입고 삭제`}
                    onClick={() => {
                      setConfirmed(false);
                      setIncoming(incoming.filter((_, i) => i !== index));
                    }}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={incoming.length >= 100}
                onClick={() => {
                  setConfirmed(false);
                  setIncoming([
                    ...incoming,
                    { quantity: "", arrives_on: nextDay, expires_on: nextDay },
                  ]);
                }}
              >
                + 입고 예정 추가
              </button>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                입고 예정 목록을 확인했어요. 비어 있으면 예정된 입고가 없어요.
              </label>
            </div>
          )}
          <div className={styles.footer}>
            <span className={styles.muted}>
              저장 후 추천을 다시 계산해주세요.
            </span>
            <button type="submit" className="button primary">
              {busy ? "저장 중…" : "재고·가정 저장"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function SavedOrder({
  order,
  busy,
  canConfirm,
  onUpdate,
  onConfirm,
  onExport,
}: {
  order: ModelDemoOrder;
  busy: boolean;
  canConfirm: boolean;
  onUpdate: (
    order: ModelDemoOrder,
    lines: LineInput[],
  ) => Promise<ModelDemoOrder | undefined>;
  onConfirm: (order: ModelDemoOrder) => void;
  onExport: (order: ModelDemoOrder, format: "csv" | "xlsx") => void;
}) {
  const [quantities, setQuantities] = useState<Quantities>(() =>
    orderQuantities(order),
  );
  const previous = useRef(order);
  useEffect(() => {
    const before = previous.current;
    if (before.version !== order.version) {
      setQuantities((values) =>
        before.lines.some(
          (line) => values[line.product_id] !== String(line.quantity),
        )
          ? values
          : orderQuantities(order),
      );
    }
    previous.current = order;
  }, [order]);
  const dirty = order.lines.some(
    (line) => quantities[line.product_id] !== String(line.quantity),
  );
  const invalid = order.lines.some(
    (line) => !validQuantity(quantities[line.product_id]),
  );
  const confirmed = order.status === "confirmed";
  const total = order.lines.reduce(
    (sum, line) => sum + Number(quantities[line.product_id] || 0) * line.cost,
    0,
  );
  async function save() {
    const updated = await onUpdate(
      order,
      order.lines.map((line) => ({
        product_id: line.product_id,
        quantity: Number(quantities[line.product_id]),
      })),
    );
    if (updated) setQuantities(orderQuantities(updated));
  }
  return (
    <article className={styles.orderCard}>
      <div className={styles.orderHeader}>
        <div>
          <strong>{order.order_date ?? order.as_of} 시연 발주 예정</strong>
          <small>
            판매 기준 {order.as_of} · {order.lines.length}개 상품 ·{" "}
            {order.id.slice(0, 8)} · 버전 {order.version}
          </small>
        </div>
        <span
          className={`${styles.badge} ${confirmed ? styles.confirmed : ""}`}
        >
          {confirmed ? "확정" : "초안"}
        </span>
      </div>
      <div className={styles.meta}>
        <span>{order.model.name}</span>
        <span>
          저장 금액 <strong>{won(order.total)}</strong>
        </span>
        {order.stale && <span className={styles.stale}>현재 조건과 다름</span>}
      </div>
      <details>
        <summary className={styles.detailHeader}>
          상품별 수량 확인{!confirmed && " · 초안 수정"}
        </summary>
        <div className={styles.tableScroll}>
          <ResponsiveTable className={styles.table}>
            <thead>
              <tr>
                <th>상품</th>
                <th className="number">추천 수량</th>
                <th className="number">저장·수정 수량</th>
                <th className="number">매입액</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.product_id}>
                  <td>
                    <strong>{line.name}</strong>
                    <small>
                      {line.supplier} · 입고 {line.arrival_date}
                    </small>
                  </td>
                  <td className="number">
                    {units(line.recommended_quantity)}개
                  </td>
                  <td className="number">
                    {confirmed ? (
                      `${units(line.quantity)}개`
                    ) : (
                      <input
                        aria-label={`${line.name} 저장된 발주 수량`}
                        className={styles.quantityInput}
                        type="number"
                        min="0"
                        max="7000000"
                        step="1"
                        value={quantities[line.product_id] ?? ""}
                        disabled={busy || order.stale}
                        onChange={(event) =>
                          setQuantities({
                            ...quantities,
                            [line.product_id]: event.target.value,
                          })
                        }
                      />
                    )}
                  </td>
                  <td className="number">
                    {won(
                      confirmed
                        ? line.amount
                        : Number(quantities[line.product_id] || 0) * line.cost,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        </div>
        {!confirmed && dirty && (
          <p className={styles.dirtyNotice}>
            수정 금액 {invalid ? "수량 확인 필요" : won(total)} · 변경사항을
            저장한 뒤 확정해주세요.
          </p>
        )}
        <p className={styles.assumptions}>{order.assumptions}</p>
      </details>
      {order.stale && !confirmed && (
        <p className={styles.dirtyNotice}>
          예측이나 재고·가정이 달라졌어요. 위에서 추천을 다시 계산해 새
          발주안으로 저장해주세요.
        </p>
      )}
      <div className={styles.orderActions}>
        {!confirmed && (
          <button
            className="button secondary"
            disabled={busy || order.stale || !dirty || invalid}
            onClick={() => void save()}
          >
            변경사항 저장
          </button>
        )}
        {!confirmed && canConfirm && (
          <button
            className="button primary"
            disabled={busy || order.stale || dirty || invalid}
            onClick={() => onConfirm(order)}
          >
            발주안 확정
          </button>
        )}
        {confirmed &&
          canConfirm &&
          (["csv", "xlsx"] as const).map((format) => (
            <button
              className="button secondary"
              key={format}
              disabled={busy}
              onClick={() => onExport(order, format)}
            >
              {format === "xlsx" ? "Excel" : "CSV"} 내보내기{" "}
              <Icon name="arrow" size={15} />
            </button>
          ))}
        {!canConfirm && (
          <span className={styles.muted}>
            점주 계정에서 확정·내보내기를 할 수 있어요.
          </span>
        )}
      </div>
    </article>
  );
}

export function ModelOrdering({
  token,
  sampleId,
  forecastId,
  onPredict,
  onSessionExpired,
  onBusyChange,
}: {
  token: string;
  sampleId: string;
  forecastId: string | null;
  onPredict: () => void;
  onSessionExpired: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<ModelDemoPlanning | null>(null);
  const [orderDate, setOrderDate] = useState("");
  const [orders, setOrders] = useState<ModelDemoOrder[]>([]);
  const [recommendation, setRecommendation] =
    useState<ModelDemoRecommendation | null>(null);
  const [quantities, setQuantities] = useState<Quantities>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const query = `?sample_id=${encodeURIComponent(sampleId)}`;

  const fetchState = useCallback(
    async (signal: AbortSignal) => {
      const [next, saved] = await Promise.all([
        api<ModelDemoPlanning>(
          `/model-demo/planning?sample_id=${encodeURIComponent(sampleId)}`,
          token,
          { signal },
        ),
        api<{ orders: ModelDemoOrder[] }>(
          `/model-demo/orders?sample_id=${encodeURIComponent(sampleId)}`,
          token,
          { signal },
        ),
      ]);
      if (signal.aborted) return;
      if (
        next.sample_id !== sampleId ||
        saved.orders.some((order) => order.sample_id !== sampleId)
      )
        throw new Error(
          "선택한 매장의 발주 자료가 아니에요. 다시 불러와주세요.",
        );
      setPlan(next);
      setOrderDate((current) =>
        isOrderDateInWindow(current, next.as_of) ? current : next.as_of,
      );
      setOrders(saved.orders);
    },
    [sampleId, token],
  );

  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    busyRef.current = false;
    setBusy(false);
    onBusyChange(false);
    setLoading(true);
    setError("");
    setRecommendation(null);
    setQuantities({});
    setEditingId(null);
    void fetchState(controller.signal)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(message(cause));
        setPlan(null);
        setOrders([]);
        if (cause instanceof ApiError && cause.status === 401)
          onSessionExpired();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
      onBusyChange(false);
    };
  }, [fetchState, forecastId, reload, onBusyChange, onSessionExpired]);

  async function perform<T>(
    task: (signal: AbortSignal) => Promise<T>,
    rethrow = false,
  ): Promise<T | undefined> {
    if (busyRef.current || loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      return await task(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      let text = message(cause);
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      if (cause instanceof ApiError && cause.status === 409) {
        setRecommendation(null);
        setQuantities({});
        try {
          await fetchState(controller.signal);
          text = `${text} 최신 정보를 다시 불러왔어요. 상품 입력창과 저장된 초안의 수정값은 유지했어요. 이전 추천의 수정 수량은 저장되지 않았으니 새 조건으로 다시 계산해주세요.`;
        } catch (refreshError) {
          if (controller.signal.aborted) return;
          text = `${text} 최신 자료를 불러오지 못했어요. 다시 불러오기를 눌러주세요.`;
          if (refreshError instanceof ApiError && refreshError.status === 401)
            onSessionExpired();
        }
      }
      if (controller.signal.aborted) return;
      setError(text);
      if (rethrow) throw new Error(text);
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        busyRef.current = false;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  async function saveItem(value: ItemInput) {
    if (!plan) return;
    await perform(async (signal) => {
      const next = await api<ModelDemoPlanning>(
        `/model-demo/planning${query}`,
        token,
        {
          method: "PUT",
          signal,
          body: JSON.stringify({
            revision: plan.revision,
            items: plan.items.map((item) =>
              item.product_id === value.product_id ? value : itemInput(item),
            ),
          }),
        },
      );
      if (signal.aborted) return;
      if (next.sample_id !== sampleId)
        throw new Error("저장 결과의 매장이 일치하지 않아요.");
      setPlan(next);
      setRecommendation(null);
      setQuantities({});
      setEditingId(null);
      setOrders((current) =>
        current.map((order) => ({ ...order, stale: true })),
      );
      setNotice(
        "재고·가정을 저장했어요. 변경한 조건으로 추천을 다시 계산해주세요.",
      );
      await fetchState(signal);
    }, true);
  }

  const activeForecastId = plan?.latest_forecast_id ?? forecastId;
  const validOrderDate = !!plan && isOrderDateInWindow(orderDate, plan.as_of);
  const recommendationCurrent =
    !!recommendation &&
    (recommendation.order_date ?? recommendation.as_of) === orderDate;
  async function calculate() {
    if (!plan || !activeForecastId || !validOrderDate) return;
    setRecommendation(null);
    setQuantities({});
    await perform(async (signal) => {
      const next = await api<ModelDemoRecommendation>(
        "/model-demo/recommendations",
        token,
        {
          method: "POST",
          signal,
          body: JSON.stringify({
            forecast_id: activeForecastId,
            revision: plan.revision,
            order_date: orderDate,
          }),
        },
      );
      if (signal.aborted) return;
      if (
        next.sample_id !== sampleId ||
        next.forecast_id !== activeForecastId ||
        next.revision !== plan.revision ||
        (next.order_date ?? next.as_of) !== orderDate
      )
        throw new Error(
          "추천 결과의 매장·예측·재고·발주 예정일이 일치하지 않아요. 다시 불러와주세요.",
        );
      setRecommendation(next);
      setQuantities(
        Object.fromEntries(
          next.rows
            .filter((row) => row.status === "ready" && row.quantity !== null)
            .map((row) => [row.product_id, String(row.quantity)]),
        ),
      );
    });
  }

  const readyRows =
    recommendation?.rows.filter(
      (row) => row.status === "ready" && row.quantity !== null,
    ) ?? [];
  const invalid = readyRows.some(
    (row) => !validQuantity(quantities[row.product_id]),
  );
  const total = readyRows.reduce(
    (sum, row) => sum + Number(quantities[row.product_id] || 0) * row.cost,
    0,
  );
  async function saveRecommendation() {
    if (
      !recommendation ||
      !recommendationCurrent ||
      !validOrderDate ||
      !readyRows.length ||
      invalid
    )
      return;
    await perform(async (signal) => {
      const order = await api<ModelDemoOrder>("/model-demo/orders", token, {
        method: "POST",
        signal,
        body: JSON.stringify({
          recommendation_id: recommendation.id,
          lines: readyRows.map((row) => ({
            product_id: row.product_id,
            quantity: Number(quantities[row.product_id]),
          })),
        }),
      });
      if (signal.aborted) return;
      if (order.sample_id !== sampleId)
        throw new Error("저장 결과의 매장이 일치하지 않아요.");
      setOrders((current) => [
        order,
        ...current.filter((item) => item.id !== order.id),
      ]);
      setRecommendation(null);
      setQuantities({});
      setNotice(
        "시연 발주안을 저장했어요. 아래 저장 목록에서 내용을 확인하고 확정하세요.",
      );
    });
  }

  async function updateOrder(order: ModelDemoOrder, lines: LineInput[]) {
    return perform(async (signal) => {
      const next = await api<ModelDemoOrder>(
        `/model-demo/orders/${encodeURIComponent(order.id)}`,
        token,
        {
          method: "PUT",
          signal,
          body: JSON.stringify({ version: order.version, lines }),
        },
      );
      if (signal.aborted) return;
      if (next.sample_id !== sampleId || next.id !== order.id)
        throw new Error("변경 결과의 발주안이 일치하지 않아요.");
      setOrders((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      setNotice("수정 수량을 저장했어요. 내용을 확인한 뒤 확정해주세요.");
      return next;
    });
  }

  function confirmOrder(order: ModelDemoOrder) {
    void perform(async (signal) => {
      const next = await api<ModelDemoOrder>(
        `/model-demo/orders/${encodeURIComponent(order.id)}/confirm`,
        token,
        {
          method: "POST",
          signal,
          body: JSON.stringify({ version: order.version }),
        },
      );
      if (signal.aborted) return;
      if (next.sample_id !== sampleId || next.id !== order.id)
        throw new Error("확정 결과의 발주안이 일치하지 않아요.");
      setOrders((current) =>
        current.map((item) => (item.id === next.id ? next : item)),
      );
      setNotice(
        "시연 발주안을 확정했어요. 저장된 수량으로 파일을 내보낼 수 있어요.",
      );
    });
  }

  function exportOrder(order: ModelDemoOrder, format: "csv" | "xlsx") {
    void perform(async (signal) => {
      const exported = await download(
        `/model-demo/orders/${encodeURIComponent(order.id)}/export?format=${format}`,
        token,
        `화개장날_TFT시연_${order.order_date ?? order.as_of}_${order.id.slice(0, 8)}.${format}`,
        { signal },
      );
      if (exported && !signal.aborted)
        setNotice(
          "확정한 시연 수량을 파일로 내보냈어요. 실제 업체 주문은 전송되지 않아요.",
        );
    });
  }

  const knownCount =
    plan?.items.filter((item) => item.stock !== null).length ?? 0;
  const editing = plan?.items.find((item) => item.product_id === editingId);
  return (
    <div className={styles.panel}>
      <div className={styles.notice}>
        <Icon name="store" size={19} />
        <div>
          <strong>내 계정에 저장하는 과거 발주 시연</strong>
          <p>
            Walmart 상품에 시연용 가격·재고·기간을 적용해요. 일반 매장 주문과
            분리되며 업체에 주문을 전송하지 않아요.
          </p>
        </div>
      </div>
      {notice && (
        <div className={styles.notice} role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="button secondary"
            disabled={busy || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            다시 불러오기
          </button>
        </div>
      )}
      {loading && (
        <div className={styles.loading} role="status">
          <span className="loading-spinner" />
          저장된 시연 조건과 발주안을 불러오고 있어요.
        </div>
      )}
      {plan && (
        <>
          <div className={styles.steps}>
            <article
              className={!activeForecastId ? styles.activeStep : undefined}
            >
              <span>STEP 1</span>
              <strong>TFT 예측 준비</strong>
              <small>
                {activeForecastId
                  ? "저장된 TFT 예측이 있어요"
                  : "직접 예측을 먼저 실행하세요"}
              </small>
            </article>
            <article
              className={
                activeForecastId && knownCount < plan.items.length
                  ? styles.activeStep
                  : undefined
              }
            >
              <span>STEP 2</span>
              <strong>재고·시연 가정 확인</strong>
              <small>
                {knownCount} / {plan.items.length}개 상품 재고 확인
              </small>
            </article>
            <article
              className={
                activeForecastId && knownCount > 0
                  ? styles.activeStep
                  : undefined
              }
            >
              <span>STEP 3</span>
              <strong>추천 수정·저장·확정</strong>
              <small>확정한 발주안을 파일로 내보내요</small>
            </article>
          </div>
          <section className={styles.section}>
            <div className={styles.heading}>
              <div>
                <h2>1. 발주에 사용할 TFT 예측</h2>
                <p>
                  판매·재고 기준일 {plan.as_of} · 이후 7일의 수요를 예측해요.
                </p>
              </div>
              <button
                className="button secondary"
                disabled={busy || loading}
                onClick={onPredict}
              >
                {activeForecastId ? "직접 예측 화면" : "TFT 예측하러 가기"}
                <Icon name="arrow" size={16} />
              </button>
            </div>
            {activeForecastId ? (
              <div className={styles.meta}>
                <span>{plan.model?.name ?? "TFT"}</span>
                <span>예측 {activeForecastId.slice(0, 8)}</span>
                {plan.latest_forecast_created_at && (
                  <span>
                    실행{" "}
                    {new Date(plan.latest_forecast_created_at).toLocaleString(
                      "ko-KR",
                      { timeZone: "Asia/Seoul" },
                    )}
                  </span>
                )}
              </div>
            ) : (
              <div className={styles.empty}>
                아직 저장된 TFT 예측이 없어요. ‘직접 예측’에서 실행한 뒤
                돌아와주세요.
              </div>
            )}
          </section>
          <section className={styles.section}>
            <div className={styles.heading}>
              <div>
                <h2>2. 상품별 재고·시연 가정</h2>
                <p>{plan.as_of} 마감 기준 · 미입력 재고는 계산에서 제외해요.</p>
              </div>
              <span className={styles.badge}>
                재고 확인 {knownCount}/{plan.items.length}
              </span>
            </div>
            <div className={styles.tableScroll}>
              <ResponsiveTable
                className={`${styles.table} ${styles.settingsTable}`}
              >
                <thead>
                  <tr>
                    <th>상품</th>
                    <th>시연 가격</th>
                    <th>입고·판매·검토 기간</th>
                    <th>확인 재고</th>
                    <th>설정</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((item) => (
                    <tr key={item.product_id}>
                      <td>
                        <strong>{item.name}</strong>
                        <small>{item.supplier}</small>
                      </td>
                      <td>
                        {won(item.price)}
                        <small>원가 {won(item.cost)}</small>
                      </td>
                      <td>
                        입고 {item.lead_days}일
                        <small>
                          판매 {item.shelf_days}일 · 검토 {item.review_days}일
                        </small>
                      </td>
                      <td>
                        {item.stock === null ? (
                          <span className={styles.stockUnknown}>
                            재고 미입력
                          </span>
                        ) : (
                          <>
                            <span className={styles.stockKnown}>
                              {units(
                                item.stock.batches
                                  .filter(
                                    (batch) => batch.expires_on > plan.as_of,
                                  )
                                  .reduce(
                                    (sum, batch) => sum + batch.quantity,
                                    0,
                                  ),
                              )}
                              개 확인
                            </span>
                            <small>
                              입고 예정 {item.stock.incoming.length}건
                            </small>
                          </>
                        )}
                      </td>
                      <td>
                        <button
                          className="button table-button"
                          disabled={busy || loading}
                          onClick={() => setEditingId(item.product_id)}
                        >
                          재고·가정 입력
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            </div>
            <p className={styles.assumptions}>{plan.assumptions}</p>
          </section>
          <section className={styles.section}>
            <div className={styles.heading}>
              <div>
                <h2>3. 추천 수량 확인·저장</h2>
                <p>
                  재고를 확인한 상품만 계산해요. 수량은 저장 전에 바꿀 수
                  있어요.
                </p>
              </div>
              <button
                className="button primary"
                disabled={
                  busy || loading || !activeForecastId || !validOrderDate
                }
                onClick={() => void calculate()}
              >
                <Icon name="refresh" size={16} />
                {busy
                  ? "처리 중…"
                  : recommendation
                    ? "추천 다시 계산"
                    : "발주량 계산"}
              </button>
            </div>
            <div className={styles.summary}>
              <label className="date-picker">
                발주 예정일
                <DateField
                  aria-label="시연 발주 예정일"
                  value={orderDate}
                  min={plan.as_of}
                  max={addCalendarDays(plan.as_of, 6)}
                  required
                  disabled={busy || loading}
                  onChange={(event) => {
                    if (busyRef.current) return;
                    request.current?.abort();
                    setRecommendation(null);
                    setQuantities({});
                    setOrderDate(event.target.value);
                    setNotice(
                      "발주 예정일을 바꿨어요. 새 날짜로 추천을 다시 계산해주세요.",
                    );
                  }}
                />
              </label>
              <span>판매 기준일과 발주일을 나눠 계획해요.</span>
            </div>
            {!recommendation || !recommendationCurrent ? (
              <div className={styles.empty}>
                {activeForecastId
                  ? "상품별 재고·가정을 확인한 뒤 발주량을 계산해주세요."
                  : "TFT 예측을 먼저 실행해주세요. 예측을 자동 실행하지 않아요."}
              </div>
            ) : (
              <>
                <div className={styles.summary}>
                  <span>
                    발주 예정{" "}
                    <strong>
                      {recommendation.order_date ?? recommendation.as_of}
                    </strong>
                  </span>
                  <span>
                    계산 가능{" "}
                    <strong>
                      {readyRows.length} / {recommendation.rows.length}개
                    </strong>
                  </span>
                  <span>
                    수정 수량 기준 합계{" "}
                    <strong className={styles.amount}>
                      {invalid ? "수량 확인 필요" : won(total)}
                    </strong>
                  </span>
                </div>
                <div className={styles.tableScroll}>
                  <ResponsiveTable className={styles.table}>
                    <thead>
                      <tr>
                        <th>상품</th>
                        <th>입고 예정</th>
                        <th className="number">추천</th>
                        <th className="number">최종 수량</th>
                        <th className="number">매입액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recommendation.rows.map((row) => {
                        const available =
                          row.status === "ready" && row.quantity !== null;
                        return (
                          <tr key={row.product_id}>
                            <td>
                              <strong>{row.name}</strong>
                              <small>
                                {row.reason ??
                                  `${row.supplier} · 확인 재고 ${units(row.current_stock ?? 0)}개`}
                              </small>
                            </td>
                            <td>{row.arrival_date}</td>
                            <td className="number">
                              {available ? `${units(row.quantity!)}개` : "—"}
                            </td>
                            <td className="number">
                              {available ? (
                                <input
                                  aria-label={`${row.name} 추천 발주 최종 수량`}
                                  className={styles.quantityInput}
                                  type="number"
                                  min="0"
                                  max="7000000"
                                  step="1"
                                  value={quantities[row.product_id] ?? ""}
                                  disabled={busy || loading}
                                  onChange={(event) =>
                                    setQuantities({
                                      ...quantities,
                                      [row.product_id]: event.target.value,
                                    })
                                  }
                                />
                              ) : (
                                <span className={styles.stockUnknown}>
                                  계산 보류
                                </span>
                              )}
                            </td>
                            <td className="number">
                              {available
                                ? won(
                                    Number(quantities[row.product_id] || 0) *
                                      row.cost,
                                  )
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </ResponsiveTable>
                </div>
                <p className={styles.assumptions}>
                  {recommendation.assumptions}
                </p>
                {invalid && (
                  <p className={styles.error}>
                    최종 수량은 0~7,000,000 사이 정수로 입력해주세요.
                  </p>
                )}
                <div className={styles.footer}>
                  <span className={styles.muted}>
                    계산 보류 상품은 저장하지 않아요.
                  </span>
                  {readyRows.length > 0 && (
                    <button
                      className="button primary"
                      disabled={
                        busy || loading || invalid || !recommendationCurrent
                      }
                      onClick={() => void saveRecommendation()}
                    >
                      시연 발주안 저장
                      <Icon name="check" size={16} />
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          <section className={styles.section}>
            <div className={styles.heading}>
              <div>
                <h2>저장한 시연 발주안 · {orders.length}건</h2>
                <p>
                  초안을 수정한 뒤 확정하세요. 확정한 내용은 바뀌지 않으며
                  재접속해도 남아요.
                </p>
              </div>
            </div>
            {!orders.length ? (
              <div className={styles.empty}>아직 저장한 발주안이 없어요.</div>
            ) : (
              <div className={styles.orderList}>
                {orders.map((order) => (
                  <SavedOrder
                    key={order.id}
                    order={order}
                    busy={busy || loading}
                    canConfirm={plan.can_confirm_export}
                    onUpdate={updateOrder}
                    onConfirm={confirmOrder}
                    onExport={exportOrder}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {editing && plan && (
        <PlanningItemModal
          key={editing.product_id}
          item={editing}
          asOf={plan.as_of}
          busy={busy || loading}
          onSave={saveItem}
          onClose={() => {
            if (!busy) setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

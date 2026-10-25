"use client";
import { useState, type ReactNode } from "react";
import {
  type Forecast,
  type Order,
  type Product,
  type Stock,
  shortDate,
  units,
  won,
} from "@/lib/api";
import { merchantSummary } from "@/lib/merchant-summary";
import { forecastHelp } from "@/lib/merchant-language";
import { CountUp, Icon, Modal, usePresence } from "./ui";

type Detail = "demand" | "ready" | "inventory" | "drafts";
type Props = {
  products: Product[];
  inventory: Record<string, Stock>;
  forecast: Forecast | null;
  orders: Order[];
  today: string;
  disabled?: boolean;
  onForecast: (id: string) => void;
  onHistory: () => void;
  onInventory: (product: Product) => void;
  onOrder: (order: Order) => void;
  onOrders: () => void;
};
const titles: Record<Detail, string> = {
  demand: "예상 판매량",
  ready: "판매 예측 가능한 상품",
  inventory: "재고 확인이 필요한 상품",
  drafts: "저장한 발주 초안",
};

export function MerchantMetrics(props: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [shown, closing] = usePresence(detail);
  const summary = merchantSummary(
    props.products,
    props.inventory,
    props.forecast,
    props.orders,
    props.today,
  );
  const entries: {
    key: Detail;
    label: string;
    value: string;
    display: ReactNode;
    hint: string;
    icon: string;
  }[] = [
    {
      key: "demand",
      label: `${summary.firstDate ? shortDate(summary.firstDate) : "내일"} 예상 판매량`,
      value: summary.demandCount ? `${units(summary.demand)}개` : "—",
      display: summary.demandCount ? (
        <>
          <CountUp value={summary.demand} />개
        </>
      ) : (
        "—"
      ),
      hint: "상품별 수량 보기",
      icon: "forecast",
    },
    {
      key: "ready",
      label: "예측 가능한 상품",
      value: `${summary.ready.length} / ${props.products.length}개`,
      display: (
        <>
          <CountUp value={summary.ready.length} /> / {props.products.length}개
        </>
      ),
      hint: "상품별로 보기",
      icon: "products",
    },
    {
      key: "inventory",
      label: "재고 확인 필요",
      value: `${summary.missing.length}개`,
      display: (
        <>
          <CountUp value={summary.missing.length} />개
        </>
      ),
      hint: "확인할 상품 보기",
      icon: "inventory",
    },
    {
      key: "drafts",
      label: "저장한 발주 초안",
      value: `${summary.drafts.length}건`,
      display: (
        <>
          <CountUp value={summary.drafts.length} />건
        </>
      ),
      hint: "저장한 상품과 수량 보기",
      icon: "orders",
    },
  ];
  function go(action: () => void) {
    setDetail(null);
    action();
  }
  return (
    <>
      <div className="merchant-metrics">
        {entries.map((entry) => (
          <button
            type="button"
            className="metric-card metric-link"
            key={entry.key}
            onClick={() => setDetail(entry.key)}
            disabled={props.disabled}
            aria-label={`${entry.label} ${entry.value}, ${entry.hint}`}
          >
            <span className="metric-label">
              {entry.label}
              <Icon name={entry.icon} size={17} />
            </span>
            <strong>{entry.display}</strong>
            <span className="metric-link-hint">
              {entry.hint}
              <Icon name="arrow" size={15} />
            </span>
          </button>
        ))}
      </div>
      {shown && (
        <Modal
          title={titles[shown]}
          closing={closing}
          onClose={() => setDetail(null)}
        >
          {shown === "demand" && (
            <p className="modal-description">
              {summary.firstDate ? `${summary.firstDate}에` : "내일"} 팔릴
              것으로 보는 수량이에요.{" "}
              {summary.demandCount}개 상품 합계{" "}
              <strong>{units(summary.demand)}개</strong>
            </p>
          )}
          {shown === "ready" && (
            <p className="modal-description">
              예측을 보거나, 기록이 부족한 상품은 판매 기록을 채워요.
            </p>
          )}
          {shown === "inventory" && (
            <p className="modal-description">
              오늘 재고를 아직 적지 않은 상품이에요.
            </p>
          )}
          {shown === "drafts" && (
            <p className="modal-description">
              저장만 하고 아직 확정하지 않은 발주예요.
            </p>
          )}
          {shown === "drafts" ? (
            <div className="insight-list">
              {summary.drafts.length ? (
                summary.drafts.map((order) => (
                  <button
                    type="button"
                    className="insight-order"
                    key={order.id}
                    onClick={() => go(() => props.onOrder(order))}
                  >
                    <span>
                      <strong>
                        {order.order_date ?? order.as_of} 발주 초안
                      </strong>
                      <small>
                        {order.lines
                          .map(
                            (line) => `${line.name} ${units(line.quantity)}개`,
                          )
                          .join(" · ")}
                      </small>
                    </span>
                    <strong>{won(order.total)}</strong>
                    <Icon name="arrow" size={17} />
                  </button>
                ))
              ) : (
                <p className="helper">
                  저장한 초안이 없어요. 발주 계획에서 만들어보세요.
                </p>
              )}
              <button
                type="button"
                className="button secondary"
                onClick={() => go(props.onOrders)}
              >
                발주 계획 보기
              </button>
            </div>
          ) : (
            <div className="insight-list">
              {(shown === "inventory"
                ? summary.missing
                : shown === "demand"
                  ? summary.items.filter((item) => item.demand !== null)
                  : summary.items
              ).map((item) => (
                <div className="insight-product" key={item.product.id}>
                  <div>
                    <strong>{item.product.name}</strong>
                    <small>
                      {shown === "inventory"
                        ? item.inventoryReason
                        : shown === "demand"
                          ? `${units(item.demand!)}개 예상`
                          : item.ready
                            ? "7일 판매 예측을 볼 수 있어요"
                            : forecastHelp(item.prediction?.reason ?? null)
                                .title}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() =>
                      go(() =>
                        shown === "inventory"
                          ? props.onInventory(item.product)
                          : shown === "ready" && !item.ready
                            ? props.onHistory()
                            : props.onForecast(item.product.id),
                      )
                    }
                  >
                    {shown === "inventory"
                      ? "재고 입력"
                      : shown === "ready" && !item.ready
                        ? "기록 입력"
                        : "예측 보기"}
                  </button>
                </div>
              ))}
              {shown === "inventory" && !summary.missing.length && (
                <p className="helper">모든 상품의 재고를 오늘 확인했어요.</p>
              )}
              {shown === "demand" && !summary.demandCount && (
                <p className="helper">
                  판매 기록을 올리면 상품별 예상 수량이 나와요.
                </p>
              )}
              {shown === "ready" && !summary.items.length && (
                <p className="helper">상품을 등록하면 예측을 볼 수 있어요.</p>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

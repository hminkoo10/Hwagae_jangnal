"use client";
import { useState } from "react";
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
import { Icon, Modal } from "./ui";

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
    hint: string;
    icon: string;
  }[] = [
    {
      key: "demand",
      label: `${summary.firstDate ? shortDate(summary.firstDate) : "내일"} 예상 판매량`,
      value: summary.demandCount ? `${units(summary.demand)}개` : "—",
      hint: "상품별 수량 보기",
      icon: "forecast",
    },
    {
      key: "ready",
      label: "예측 준비 상품",
      value: `${summary.ready.length} / ${props.products.length}개`,
      hint: "가능한 상품과 빠진 기록 보기",
      icon: "products",
    },
    {
      key: "inventory",
      label: "재고 확인 필요",
      value: `${summary.missing.length}개`,
      hint: "확인할 상품 보기",
      icon: "inventory",
    },
    {
      key: "drafts",
      label: "저장한 발주 초안",
      value: `${summary.drafts.length}건`,
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
            <strong>{entry.value}</strong>
            <span className="metric-link-hint">
              {entry.hint}
              <Icon name="arrow" size={15} />
            </span>
          </button>
        ))}
      </div>
      {detail && (
        <Modal title={titles[detail]} onClose={() => setDetail(null)}>
          {detail === "demand" && (
            <p className="modal-description">
              {summary.firstDate}에 팔릴 것으로 예상되는 수량이에요.{" "}
              {summary.demandCount}개 상품 합계{" "}
              <strong>{units(summary.demand)}개</strong>
            </p>
          )}
          {detail === "ready" && (
            <p className="modal-description">
              상품별로 예측을 보거나 빠진 판매 기록을 채워주세요.
            </p>
          )}
          {detail === "inventory" && (
            <p className="modal-description">
              재고를 아직 입력하지 않았거나 오늘 확인이 필요한 상품이에요.
            </p>
          )}
          {detail === "drafts" ? (
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
                <p className="helper">저장한 초안이 없어요.</p>
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
              {(detail === "inventory"
                ? summary.missing
                : detail === "demand"
                  ? summary.items.filter((item) => item.demand !== null)
                  : summary.items
              ).map((item) => (
                <div className="insight-product" key={item.product.id}>
                  <div>
                    <strong>{item.product.name}</strong>
                    <small>
                      {detail === "inventory"
                        ? item.inventoryReason
                        : detail === "demand"
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
                        detail === "inventory"
                          ? props.onInventory(item.product)
                          : detail === "ready" && !item.ready
                            ? props.onHistory()
                            : props.onForecast(item.product.id),
                      )
                    }
                  >
                    {detail === "inventory"
                      ? "재고 입력"
                      : detail === "ready" && !item.ready
                        ? "기록 입력"
                        : "예측 보기"}
                  </button>
                </div>
              ))}
              {detail === "inventory" && !summary.missing.length && (
                <p className="helper">모든 상품의 재고를 오늘 확인했어요.</p>
              )}
              {detail === "demand" && !summary.demandCount && (
                <p className="helper">
                  판매 기록을 입력하면 상품별 예상 수량을 볼 수 있어요.
                </p>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

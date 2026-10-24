"use client";
import { type Order, units, won } from "@/lib/api";
import { ResponsiveTable } from "./controls";
import { Modal } from "./ui";

export function OrderContents({ order }: { order: Order }) {
  return (
    <div className="order-contents">
      <dl className="order-summary">
        <div>
          <dt>발주일</dt>
          <dd>{order.order_date ?? order.as_of}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{order.status === "confirmed" ? "확정" : "초안"}</dd>
        </div>
        <div>
          <dt>작성자</dt>
          <dd>{order.author}</dd>
        </div>
        <div>
          <dt>총 매입액</dt>
          <dd>{won(order.total)}</dd>
        </div>
      </dl>
      <p className="helper">저장한 상품과 수량이에요.</p>
      {order.stale && (
        <p className="warning-banner">
          저장 후 판매·재고 정보가 달라졌어요. 확정 전 다시 계산해주세요.
        </p>
      )}
      <div className="table-scroll">
        <ResponsiveTable>
          <thead>
            <tr>
              <th>상품</th>
              <th>공급사</th>
              <th className="number">발주 수량</th>
              <th className="number">매입액</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.product_id}>
                <td>
                  <strong>{line.name}</strong>
                  <small>{line.product_id}</small>
                </td>
                <td>{line.supplier}</td>
                <td className="number">{units(line.quantity)}개</td>
                <td className="number">{won(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      </div>
    </div>
  );
}

export function OrderDetails({
  order,
  onClose,
  onOpenOrders,
}: {
  order: Order;
  onClose: () => void;
  onOpenOrders: () => void;
}) {
  return (
    <Modal title="발주 내용" onClose={onClose}>
      <OrderContents order={order} />
      <button
        type="button"
        className="button primary order-details-action"
        onClick={() => {
          onClose();
          onOpenOrders();
        }}
      >
        발주 계획으로 이동
      </button>
    </Modal>
  );
}

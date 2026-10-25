"use client";
import { type Order, units, won } from "@/lib/api";
import { ResponsiveTable } from "./controls";
import { Modal } from "./ui";
import { AiOrderMessage, type AiAccess } from "./ai-assistant";

export function OrderContents({ order, confirmationIssue }: { order: Order; confirmationIssue?: string }) {
  const issue = confirmationIssue ?? (order.status === "draft" && order.stale
    ? "저장 후 판매·재고·상품 정보가 바뀌었어요. 다시 계산해주세요." : "");
  return (
    <div className="order-contents">
      <dl className="order-summary">
        <div>
          <dt>발주일</dt>
          <dd>{order.order_date ?? order.as_of}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>{order.status === "confirmed" ? "확정" : "확정 전"}</dd>
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
      <p className="helper">
        {order.status === "confirmed"
          ? "확정한 발주예요. 이 수량대로 공급사에 보내요."
          : "확정 전이에요. 발주 계획에서 수량을 고치고 확정해요."}
      </p>
      {issue && (
        <p className="warning-banner">
          {issue}
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
  ai,
  confirmationIssue,
  onNewOrder,
}: {
  order: Order;
  onClose: () => void;
  onOpenOrders: () => void;
  ai?: AiAccess;
  confirmationIssue?: string;
  onNewOrder?: () => void;
}) {
  return (
    <Modal title="발주 내용" onClose={onClose}>
      <OrderContents order={order} confirmationIssue={confirmationIssue} />
      {ai && !order.stale && <AiOrderMessage key={order.id} {...ai} orderId={order.id} />}
      <button
        type="button"
        className="button primary order-details-action"
        onClick={() => {
          onClose();
          if (confirmationIssue && onNewOrder) onNewOrder();
          else onOpenOrders();
        }}
      >
        {confirmationIssue && onNewOrder ? "새 발주안 만들기" : "발주 계획으로 이동"}
      </button>
    </Modal>
  );
}

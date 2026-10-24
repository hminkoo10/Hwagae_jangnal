import type { Forecast, Order, Product, Stock } from "./api";

export function merchantSummary(
  products: Product[],
  inventory: Record<string, Stock>,
  forecast: Forecast | null,
  orders: Order[],
  today: string,
) {
  const firstDate = forecast?.dates[0];
  const items = products.map((product) => {
    const prediction = forecast?.products.find(
      (item) => item.product_id === product.id,
    );
    const point = prediction?.points.find((item) => item.date === firstDate);
    const stock = inventory[product.id];
    return {
      product,
      prediction,
      demand: prediction?.status === "ready" && point ? point.p50 : null,
      ready: prediction?.status === "ready" && !!prediction.points.length,
      needsInventory: !stock || stock.measured_on !== today,
      inventoryReason: !stock
        ? "재고를 아직 입력하지 않았어요"
        : `마지막 확인 ${stock.measured_on}`,
    };
  });
  return {
    items,
    demand: items.reduce((sum, item) => sum + (item.demand ?? 0), 0),
    demandCount: items.filter((item) => item.demand !== null).length,
    ready: items.filter((item) => item.ready),
    missing: items.filter((item) => item.needsInventory),
    drafts: orders.filter((order) => order.status === "draft"),
    firstDate,
  };
}

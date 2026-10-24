import type { Product } from "./api";

export const PRODUCT_CATEGORIES = [
  "간편식",
  "유제품",
  "음료",
  "신선식품",
  "베이커리",
  "냉동식품",
  "기타",
] as const;

export function categoryOptions(products: Pick<Product, "category">[]) {
  return [
    ...new Set([
      ...PRODUCT_CATEGORIES,
      ...products.map((p) => p.category).filter(Boolean),
    ]),
  ];
}

export function filterProducts(
  products: Product[],
  query: string,
  category: string,
) {
  const term = query.trim().toLocaleLowerCase();
  return products.filter(
    (p) =>
      (category === "all" || p.category === category) &&
      `${p.name} ${p.id} ${p.category} ${p.supplier}`
        .toLocaleLowerCase()
        .includes(term),
  );
}

export function adjustPrice(value: string, direction: 1 | -1) {
  const number = Number(value || 0);
  return String(
    Math.min(
      1_000_000,
      Math.max(
        0,
        (Number.isFinite(number) ? Math.round(number) : 0) + direction * 100,
      ),
    ),
  );
}

export function forecastHelp(reason: string | null) {
  if (!reason)
    return {
      title: "판매 기록을 확인해주세요",
      description: "판매 기록을 올리면 예상 판매량을 확인할 수 있어요.",
      action: "판매 기록 확인하기",
    };
  const count = reason.match(/(?:현재\s*|received\s+)(\d+)\s*\/\s*56/);
  if (count) {
    const observed = Number(count[1]);
    const missing = Math.max(0, 56 - observed);
    return {
      title:
        missing === 1
          ? "판매 기록 하루만 더 확인해주세요"
          : `판매 기록 ${missing}일이 비어 있어요`,
      description: `선택한 날짜까지 최근 56일의 기록이 필요해요. 지금은 ${observed}일이 있어요. 비어 있는 날짜의 판매량을 입력해주세요. 실제로 안 팔린 날만 0개로 적어주세요.`,
      action: "판매 기록 채우기",
    };
  }
  if (reason.includes("요일마다 4일"))
    return {
      title: "요일별 판매 기록이 더 필요해요",
      description:
        "월요일부터 일요일까지, 각 요일의 판매 기록이 4번 이상 필요해요. 빠진 날짜를 확인해주세요. 실제로 안 팔린 날만 0개로 적어주세요.",
      action: "판매 기록 확인하기",
    };
  return {
    title: "아직 판매량을 예상하기 어려워요",
    description: reason,
    action: "판매 기록 확인하기",
  };
}

export function forecastName(model: {
  uses_weather: boolean;
  training_data?: string;
}) {
  return model.uses_weather ? "날씨를 반영한 AI 예측" : "요일별 판매 예측";
}

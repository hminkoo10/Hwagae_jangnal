export type User = { id: string; name: string; email: string };
export type Store = {
  id: string;
  name: string;
  city: string;
  role: "owner" | "staff";
  provenance: string;
  demo_as_of?: string;
  demo_kind?: string;
  demo_notice?: string;
};
export type Product = {
  id: string;
  name: string;
  category: string;
  supplier: string;
  price: number | null;
  cost: number | null;
  commercial_settings_available?: boolean;
  lead_days: number;
  shelf_days: number;
  review_days: number;
};
export type Stock = {
  batches: { quantity: number; expires_on: string }[];
  incoming: { quantity: number; expires_on: string; arrives_on: string }[];
  incoming_confirmed: true;
  measured_on: string;
  updated_at: string;
};
export type Sale = { date: string; product_id: string; units_sold: number };
export type SalesData = {
  rows: (Sale & { name: string; source: string })[];
  summary: {
    count: number;
    first_date: string | null;
    last_date: string | null;
  };
};
export type Preview = {
  rows: Sale[];
  errors: { row: number; message: string }[];
  can_save: boolean;
};
export type WeatherDay = {
  date: string;
  temp_max: number | null;
  temp_min: number | null;
  rain_mm: number | null;
  rain_probability: number | null;
  code: number | null;
};
export type Weather = {
  status: string;
  source: string;
  mode: string;
  fetched_at: string | null;
  cached?: boolean;
  days: WeatherDay[];
  note: string;
  message?: string | null;
};
export type ForecastPoint = {
  date: string;
  p10: number;
  p50: number;
  p90: number;
  actual: number | null;
};
export type ProductForecast = {
  product_id: string;
  name: string;
  status: string;
  reason: string | null;
  points: ForecastPoint[];
};
export type Forecast = {
  id: string;
  as_of: string;
  dates: string[];
  created_at: string;
  model: { name: string; version: string; uses_weather: boolean };
  weather: Weather;
  products: ProductForecast[];
};
export type RecommendationRow = {
  product_id: string;
  name: string;
  supplier: string;
  cost: number;
  quantity: number | null;
  amount: number | null;
  status: string;
  reason: string | null;
  current_stock: number | null;
  arrival_date: string;
  scenario_loss?: number;
  method?: string;
};
export type Recommendation = {
  id: string;
  rows: RecommendationRow[];
  calculated_count: number;
  total: number;
  assumptions: string;
};
export type Order = {
  id: string;
  status: "draft" | "confirmed";
  created_at: string;
  as_of: string;
  total: number;
  author: string;
  stale: boolean;
  lines: (RecommendationRow & {
    recommended_quantity: number;
    quantity: number;
    amount: number;
  })[];
};

const base = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function response(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string")
    headers.set("Content-Type", "application/json");
  const timeout = AbortSignal.timeout(25000);
  let result: Response;
  try {
    result = await fetch(`${base}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      "API에 연결하지 못했어요. 서버 실행과 연결 주소를 확인해주세요.",
      0,
    );
  }
  if (!result.ok) {
    const error = await result.json().catch(() => ({}));
    const detail = error.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map(
                (item: { loc?: string[]; msg?: string }) =>
                  `${item.loc?.slice(1).join(" · ")}: ${item.msg}`,
              )
              .join(" / ")
          : `요청에 실패했어요. (${result.status})`;
    throw new ApiError(message, result.status);
  }
  return result;
}

export async function api<T>(
  path: string,
  token = "",
  init: RequestInit = {},
): Promise<T> {
  return (await response(path, token, init)).json();
}

export async function download(path: string, token: string, filename: string) {
  const blob = await (await response(path, token)).blob();
  saveBlob(blob, filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const won = (value: number) =>
  new Intl.NumberFormat("ko-KR").format(value) + "원";
export const units = (value: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
export const shortDate = (value: string) =>
  `${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}`;

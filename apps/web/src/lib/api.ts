export type User = { id: string; name: string; email: string };
export type Store = {
  id: string;
  name: string;
  city: string;
  role: "owner" | "staff";
  provenance: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  local_today?: string;
  provider?: "weekday" | "merchant_tft";
  data_note?: string | null;
};
export type Product = {
  id: string;
  name: string;
  category: string;
  supplier: string;
  price: number;
  cost: number;
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
  fetched_at: string;
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
  model: {
    name: string;
    version: string;
    uses_weather: boolean;
    training_data?: string;
    note?: string;
  };
  weather: Weather;
  products: ProductForecast[];
};
export type MerchantForecastSettings = {
  provider: "weekday" | "merchant_tft";
  model_kind?: "walmart" | "synthetic";
  history_available_from?: string | null;
  history_available_to?: string | null;
  runtime: { status: string; message: string };
  model: Forecast["model"] | null;
  requirements: {
    history_days: number;
    horizon_days: number;
    weather_fields: string[];
    live_forecast_required: boolean;
  };
  data_note: string | null;
};
export type ModelDemoStatus = {
  sample_id: string;
  samples: { id: string; label: string; product_count: number }[];
  total_products: number;
  runtime: {
    status: "disabled" | "starting" | "ready" | "unavailable";
    message: string;
  };
  sample: {
    title: string;
    as_of: string;
    dates: string[];
    history_start: string;
    history_end: string;
    history_days: 56;
    product_count: number;
    products: { id: string; name: string }[];
    source: string;
    weather_strategy: "persistence";
    note: string;
  };
};
export type ModelDemoForecast = {
  id: string;
  sample_id: string;
  as_of: string;
  dates: string[];
  created_at: string;
  elapsed_ms: number;
  model: Forecast["model"];
  products: ProductForecast[];
  baseline: {
    model: Forecast["model"];
    products: ProductForecast[];
  };
  provenance: string;
  weather_strategy: "persistence";
  note: string;
};
export type ModelEvaluation = {
  report_id: string;
  title: string;
  dataset: string;
  source: string;
  evaluation_period: { start: string; end: string };
  method: {
    history_days: 56;
    baseline_lookback_days: 84;
    forecast_days: 7;
    quantiles: number[];
    seed: 42;
    weather_strategy: "persistence";
    sampling: string;
  };
  subsets: {
    id: string;
    label: string;
    description: string;
    n: number;
    windows: number;
    series: number;
    metrics: {
      model: string;
      label: string;
      mae: number;
      wape: number | null;
      mean_pinball: number;
      coverage: number;
      interval_width: number;
    }[];
  }[];
  limitations: string[];
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
  order_date?: string;
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
  order_date?: string;
  total: number;
  author: string;
  stale: boolean;
  lines: (RecommendationRow & {
    recommended_quantity: number;
    quantity: number;
    amount: number;
  })[];
};
export type ModelDemoPlanningItem = {
  product_id: string;
  name: string;
  supplier: string;
  price: number;
  cost: number;
  lead_days: number;
  shelf_days: number;
  review_days: number;
  stock: Pick<Stock, "batches" | "incoming" | "incoming_confirmed"> | null;
};
export type ModelDemoPlanning = {
  sample_id: string;
  as_of: string;
  revision: number;
  can_confirm_export: boolean;
  latest_forecast_id: string | null;
  latest_forecast_created_at: string | null;
  model: Forecast["model"] | null;
  items: ModelDemoPlanningItem[];
  assumptions: string;
};
export type ModelDemoRecommendation = Recommendation & {
  sample_id: string;
  forecast_id: string;
  as_of: string;
  revision: number;
  model: Forecast["model"];
};
export type ModelDemoOrder = Omit<Order, "author"> & {
  sample_id: string;
  version: number;
  confirmed_at: string | null;
  forecast_id: string;
  model: Forecast["model"];
  assumptions: string;
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

let pendingRequests = 0;

export function hasPendingRequests() {
  return pendingRequests > 0;
}

async function response<T>(
  path: string,
  token: string,
  init: RequestInit,
  read: (result: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (typeof init.body === "string")
    headers.set("Content-Type", "application/json");
  // Older supported iOS WebViews do not implement AbortSignal.any(). Keep the
  // deadline alive until the response body is consumed, and release listeners.
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25000);
  pendingRequests += 1;
  try {
    const result = await fetch(`${base}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!result.ok) {
      const error = await result.json().catch((error) => {
        if (controller.signal.aborted) throw error;
        return {};
      });
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
    return await read(result);
  } catch (error) {
    if (init.signal?.aborted)
      throw new DOMException("요청을 취소했어요.", "AbortError");
    if (timedOut)
      throw new ApiError(
        "응답이 늦어지고 있어요. 잠시 후 다시 시도해주세요.",
        0,
      );
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      "API에 연결하지 못했어요. 서버 실행과 연결 주소를 확인해주세요.",
      0,
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
    pendingRequests -= 1;
  }
}

export async function api<T>(
  path: string,
  token = "",
  init: RequestInit = {},
): Promise<T> {
  return response(path, token, init, (result) => result.json());
}

export async function download(
  path: string,
  token: string,
  filename: string,
  init: RequestInit = {},
) {
  const blob = await response(path, token, init, (result) => result.blob());
  if (init.signal?.aborted) return false;
  return saveBlob(blob, filename);
}

export async function saveBlob(blob: Blob, filename: string) {
  pendingRequests += 1;
  try {
    const { shareNativeFile } = await import("./native-files");
    const result = await shareNativeFile(blob, filename);
    if (result !== "browser") return result === "shared";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } finally {
    pendingRequests -= 1;
  }
}

export const won = (value: number) =>
  new Intl.NumberFormat("ko-KR").format(value) + "원";
export const units = (value: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
export const shortDate = (value: string) =>
  `${Number(value.slice(5, 7))}.${Number(value.slice(8, 10))}`;

export function addCalendarDays(value: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isOrderDateInWindow(value: string, asOf: string) {
  return (
    !!asOf &&
    !!value &&
    addCalendarDays(value, 0) === value &&
    value >= asOf &&
    value <= addCalendarDays(asOf, 6)
  );
}

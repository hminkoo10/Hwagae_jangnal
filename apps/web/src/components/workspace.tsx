"use client";

import { Select, DateField, ResponsiveTable } from "./controls";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  addCalendarDays,
  ApiError,
  download,
  isOrderDateInWindow,
  shortDate,
  units,
  won,
  type Forecast,
  type Order,
  type Product,
  type Recommendation,
  type SalesData,
  type Stock,
  type Store,
  type User,
} from "@/lib/api";
import { InventoryModal, ProductModal, SalesPanel, StoreModal } from "./forms";
import { Empty, ForecastChart, Icon } from "./ui";
import { MerchantOverview } from "./merchant-overview";
import { ModelDemo } from "./model-demo";
import { NATIVE_BACK_EVENT } from "./native-shell";
import { MerchantModelPanel } from "./merchant-model-panel";
import { InitialData } from "./initial-data";
import { AiSettings, AiExplanation } from "./ai-settings";
import { AiAssistant, ASSISTANT_TASKS } from "./ai-assistant";
import { AiSalesMemo } from "./ai-memo";
import { OperatorDashboard } from "./operator-dashboard";
import { categoryOptions, filterProducts } from "@/lib/merchant-language";
import { WeatherSource } from "./weather-source";
import { OrderDetails } from "./order-details";

type Tab =
  | "overview"
  | "forecast"
  | "sales"
  | "inventory"
  | "products"
  | "orders"
  | "ai-settings"
  | "model-demo";
const tabs: { id: Tab; label: string; description: string }[] = [
  {
    id: "overview",
    label: "홈",
    description: "오늘 필요한 수량을 확인해요.",
  },
  {
    id: "forecast",
    label: "7일 판매 예측",
    description: "앞으로 7일, 얼마나 팔릴지 확인해요.",
  },
  {
    id: "sales",
    label: "판매 기록",
    description: "날짜별로 팔린 개수를 모아요.",
  },
  {
    id: "inventory",
    label: "재고 확인",
    description: "남은 수량과 도착할 상품을 확인해요.",
  },
  {
    id: "products",
    label: "상품 · 공급사",
    description: "상품 가격과 유통기한·발주 주기를 관리해요.",
  },
  {
    id: "orders",
    label: "발주 계획",
    description: "발주할 수량을 정하고 발주서를 만들어요.",
  },
  {
    id: "ai-settings",
    label: "AI 도우미",
    description: "발주 이유를 쉬운 말로 설명받아요. 연결은 선택사항이에요.",
  },
  {
    id: "model-demo",
    label: "TFT 모델 체험",
    description: "과거 공개 데이터로 학습한 모델의 예측을 직접 실행해보세요.",
  },
];
type Bundle = {
  storeId: string;
  products: Product[];
  inventory: Record<string, Stock>;
  sales: SalesData;
  orders: Order[];
};

function LoginScreen({
  onLogin,
}: {
  onLogin: (token: string, user: User) => void;
}) {
  const [email, setEmail] = useState(
    process.env.NEXT_PUBLIC_DEMO_LOGIN_ENABLED === "false"
      ? ""
      : "owner@hwagae.local",
  );
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(account = email, secret = password) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string; user: User }>(
        "/auth/login",
        "",
        {
          method: "POST",
          body: JSON.stringify({ email: account, password: secret }),
        },
      );
      onLogin(result.token, result.user);
    } catch (error) {
      setError(error instanceof Error ? error.message : "로그인에 실패했어요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-icon">
            <Icon name="store" size={26} />
          </span>
          <strong>
            화개장날<span>.</span>
          </strong>
        </div>
        <span className="story-eyebrow">사장님의 내일을 함께 준비해요</span>
        <h1>
          내일 장사,
          <br />
          오늘부터 가볍게.
        </h1>
        <p>
          판매의 흐름을 읽고 재고를 확인해
          <br />
          우리 매장에 필요한 만큼 준비하세요.
        </p>
        <div className="story-illustration" aria-hidden="true">
          <div className="illustration-orbit" />
          <div className="illustration-store">
            <Icon name="store" size={130} />
          </div>
          <span className="floating-chip chip-one">
            <Icon name="forecast" />
            7일 판매 예측
          </span>
          <span className="floating-chip chip-two">
            <Icon name="check" />
            재고 확인 완료
          </span>
          <span className="floating-chip chip-three">
            <Icon name="orders" />
            차근차근 발주 준비
          </span>
        </div>
        <small>전라도와 경상도, 날씨와 장사를 잇다. TEAM 화개장터</small>
      </section>
      <section className="login-form-wrap">
        <div className="login-form">
          <span className="pill mint">화개장날 사장님</span>
          <h2>로그인</h2>
          <p className="muted">이메일과 비밀번호를 입력해주세요.</p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void login();
            }}
          >
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            <label>
              이메일
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              비밀번호
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button className="button primary large" disabled={busy}>
              {busy ? "매장으로 이동 중…" : "로그인"}
              <Icon name="arrow" />
            </button>
          </form>
          <div
            className="login-divider"
            hidden={process.env.NEXT_PUBLIC_DEMO_LOGIN_ENABLED === "false"}
          >
            <span>샘플 매장으로 먼저 둘러보세요</span>
          </div>
          <div
            className="demo-buttons"
            hidden={process.env.NEXT_PUBLIC_DEMO_LOGIN_ENABLED === "false"}
          >
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void login("owner@hwagae.local", "hwagae-demo")}
            >
              점주 체험
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void login("staff@hwagae.local", "hwagae-demo")}
            >
              직원 체험
            </button>
          </div>
          <p
            className="helper"
            hidden={process.env.NEXT_PUBLIC_DEMO_LOGIN_ENABLED === "false"}
          >
            체험 매장의 상품·가격·판매 기록은 가상 자료예요.
            <br />
            재고는 직접 입력하기 전까지 비어 있어요.
          </p>
        </div>
      </section>
    </main>
  );
}

export default function Workspace() {
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  const [serverToday, setServerToday] = useState("");
  const today =
    stores.find((store) => store.id === storeId)?.local_today ?? serverToday;
  const [asOf, setAsOf] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const selectedStoreId = useRef(storeId);
  selectedStoreId.current = storeId;
  const [tab, setTab] = useState<Tab>("overview");
  const modelDemo = tab === "model-demo";
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [forecastResult, setForecastResult] = useState<{
    storeId: string;
    forecast: Forecast;
  } | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState("");
  const [forecastReload, setForecastReload] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [productCategory, setProductCategory] = useState("all");
  useEffect(() => setProductCategory("all"), [storeId]);
  const [selectedProduct, setSelectedProduct] = useState("P001");
  const [inventoryProduct, setInventoryProduct] = useState<Product | null>(
    null,
  );
  const [productModal, setProductModal] = useState<Product | "new" | null>(
    null,
  );
  const [storeModal, setStoreModal] = useState(false);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  useEffect(() => setOrderDetail(null), [storeId]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(
    null,
  );
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const recommendationRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => recommendationRequest.current?.abort(),
    [token, storeId, asOf, orderDate, reload, forecastReload, modelDemo],
  );

  useEffect(() => {
    setOrderDate(today);
    setRecommendation(null);
    setQuantities({});
  }, [today, storeId]);

  function acceptLogin(value: string, account: User) {
    sessionStorage.setItem("hwagae-session", value);
    setToken(value);
    setUser(account);
  }
  const clearSession = useCallback(() => {
    sessionStorage.removeItem("hwagae-session");
    setRestoreError("");
    setToken("");
    setUser(null);
    setStores([]);
    setStoreId("");
    setBundle(null);
    setForecastResult(null);
    setBusy(false);
    setRecommendation(null);
  }, []);

  useEffect(() => {
    const stored = sessionStorage.getItem("hwagae-session");
    if (!stored) {
      setRestoring(false);
      return;
    }
    const controller = new AbortController();
    api<User>("/auth/me", stored, { signal: controller.signal })
      .then((account) => {
        if (controller.signal.aborted) return;
        setUser(account);
        setToken(stored);
        setRestoreError("");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          sessionStorage.removeItem("hwagae-session");
          setRestoreError("");
        } else {
          setRestoreError(
            error instanceof Error
              ? error.message
              : "매장에 연결하지 못했어요.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [restoreAttempt]);

  useEffect(() => {
    const back = (event: Event) => {
      if (busy) {
        event.preventDefault();
        return;
      }
      if (user && tab !== "overview") {
        event.preventDefault();
        setTab("overview");
        setSearch("");
        setAsOf(today);
      }
    };
    window.addEventListener(NATIVE_BACK_EVENT, back);
    return () => window.removeEventListener(NATIVE_BACK_EVENT, back);
  }, [busy, tab, today, user]);

  const refreshStores = useCallback(
    async (preferred?: string) => {
      const result = await api<{ stores: Store[]; today: string }>(
        "/stores",
        token,
      );
      const nextId =
        preferred ??
        (result.stores.some((store) => store.id === selectedStoreId.current)
          ? selectedStoreId.current
          : (result.stores.find((store) => store.id === "gwangju")?.id ??
            result.stores[0]?.id ??
            ""));
      const nextToday =
        result.stores.find((store) => store.id === nextId)?.local_today ??
        result.today;
      setStores(result.stores);
      setServerToday(result.today);
      setAsOf((current) =>
        preferred || selectedStoreId.current !== nextId
          ? nextToday
          : current || nextToday,
      );
      setStoreId(nextId);
      return nextToday;
    },
    [token],
  );

  useEffect(() => {
    if (token)
      void refreshStores().catch((error) => {
        setError(error.message);
        if (error instanceof ApiError && error.status === 401) clearSession();
      });
  }, [token, refreshStores, clearSession]);

  useEffect(() => {
    if (modelDemo) {
      setLoading(false);
      return;
    }
    if (!token || !storeId) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setLoading(true);
    setError("");
    setRecommendation(null);
    setQuantities({});
    Promise.all([
      api<{ products: Product[]; inventory: Record<string, Stock> }>(
        `/stores/${storeId}/products`,
        token,
        options,
      ),
      api<SalesData>(`/stores/${storeId}/sales`, token, options),
      api<{ orders: Order[] }>(`/stores/${storeId}/orders`, token, options),
    ])
      .then(([catalog, sales, orders]) => {
        if (controller.signal.aborted) return;
        setBundle({
          storeId,
          ...catalog,
          sales,
          orders: orders.orders,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setError(error.message);
        setBundle(null);
        if (error instanceof ApiError && error.status === 401) clearSession();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, storeId, reload, clearSession, modelDemo]);

  useEffect(() => {
    if (modelDemo || !token || !storeId || !asOf) return;
    const controller = new AbortController();
    setForecastResult(null);
    setForecastError("");
    setForecastLoading(true);
    setRecommendation(null);
    setQuantities({});
    api<Forecast>(`/stores/${storeId}/forecasts?as_of=${asOf}`, token, {
      method: "POST",
      signal: controller.signal,
    })
      .then((forecast) => {
        if (!controller.signal.aborted)
          setForecastResult({ storeId, forecast });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setForecastError(
          error instanceof Error
            ? error.message
            : "판매 예측을 불러오지 못했어요.",
        );
        if (error instanceof ApiError && error.status === 401) clearSession();
      })
      .finally(() => {
        if (!controller.signal.aborted) setForecastLoading(false);
      });
    return () => controller.abort();
  }, [token, storeId, asOf, reload, forecastReload, modelDemo, clearSession]);

  useEffect(() => {
    if (notice) {
      const timer = window.setTimeout(() => setNotice(""), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  function saved(text: string) {
    setNotice(text);
    setReload((value) => value + 1);
  }
  async function imported(text: string) {
    saved(text);
    setTab("overview");
    try {
      await refreshStores(storeId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearSession();
      else
        setError(
          error instanceof Error
            ? error.message
            : "매장 정보를 다시 불러오지 못했어요.",
        );
    }
  }
  function navigate(next: Tab) {
    if (busy) return;
    setTab(next);
    setSearch("");
    if (next !== "forecast" && next !== "model-demo") setAsOf(today);
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(error instanceof Error ? error.message : "요청에 실패했어요.");
      if (error instanceof ApiError && error.status === 401) clearSession();
    } finally {
      setBusy(false);
    }
  }

  if (restoring)
    return (
      <main className="boot-screen">
        <span className="loading-spinner" />
        매장 연결을 확인하고 있어요.
      </main>
    );
  if (restoreError)
    return (
      <main className="boot-screen">
        <section className="connection-retry" role="alert">
          <h1>매장에 연결하지 못했어요</h1>
          <p>{restoreError}</p>
          <div className="split-actions">
            <button
              className="button primary"
              onClick={() => {
                setRestoring(true);
                setRestoreAttempt((value) => value + 1);
              }}
            >
              다시 연결
            </button>
            <button className="button secondary" onClick={clearSession}>
              다른 계정으로 로그인
            </button>
          </div>
        </section>
      </main>
    );
  if (!user) return <LoginScreen onLogin={acceptLogin} />;
  if (user.platform_role === "operator")
    return (
      <OperatorDashboard
        token={token}
        user={user}
        onExpired={clearSession}
        onLogout={() => {
          void api("/auth/logout", token, { method: "POST" })
            .catch(() => {})
            .finally(clearSession);
        }}
      />
    );

  const store = stores.find((item) => item.id === storeId);
  const data = bundle?.storeId === storeId ? bundle : null;
  const forecast =
    forecastResult?.storeId === storeId &&
    forecastResult.forecast.as_of === asOf
      ? forecastResult.forecast
      : null;
  const replay = !!today && asOf !== today;
  const weatherLabel =
    forecast?.weather.mode === "live_forecast"
      ? "현재 실제 예보"
      : forecast?.weather.mode === "historical_reanalysis"
        ? "과거 재분석"
        : forecast?.weather.mode === "recent_weather"
          ? "최근 날씨 시나리오"
          : "날씨 자료";
  const validOrderDate = isOrderDateInWindow(orderDate, today);
  const recommendationCurrent =
    !!recommendation &&
    (recommendation.order_date ?? asOf) === orderDate &&
    !replay;
  const owner = store?.role === "owner";
  const currentTab = tabs.find((item) => item.id === tab)!;
  const filtered = filterProducts(
    data?.products ?? [],
    search,
    productCategory,
  );
  const readyCount =
    forecast?.products.filter((product) => product.status === "ready").length ??
    0;
  const missingStock =
    data?.products.filter(
      (product) =>
        !data.inventory[product.id] ||
        data.inventory[product.id].measured_on !== today,
    ).length ?? 0;
  const selectedForecast =
    forecast?.products.find(
      (product) => product.product_id === selectedProduct,
    ) ?? forecast?.products[0];
  const editedTotal =
    recommendation?.rows.reduce(
      (sum, row) =>
        row.quantity !== null
          ? sum + Number(quantities[row.product_id] || 0) * row.cost
          : sum,
      0,
    ) ?? 0;
  const invalidQuantity = recommendation?.rows.some(
    (row) =>
      row.quantity !== null &&
      (!/^\d+$/.test(quantities[row.product_id] ?? "") ||
        Number(quantities[row.product_id]) > 7000000),
  );

  async function calculate() {
    if (!data || !forecast || forecastLoading || replay || !validOrderDate)
      return;
    setRecommendation(null);
    setQuantities({});
    recommendationRequest.current?.abort();
    const controller = new AbortController();
    recommendationRequest.current = controller;
    const result = await api<Recommendation>(
      `/stores/${storeId}/recommendations`,
      token,
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          forecast_id: forecast.id,
          order_date: orderDate,
        }),
      },
    );
    if (controller.signal.aborted) return;
    if ((result.order_date ?? asOf) !== orderDate)
      throw new Error(
        "추천의 발주 예정일이 일치하지 않아요. 다시 계산해주세요.",
      );
    setRecommendation(result);
    setQuantities(
      Object.fromEntries(
        result.rows
          .filter((row) => row.quantity !== null)
          .map((row) => [row.product_id, String(row.quantity)]),
      ),
    );
  }

  async function saveOrder() {
    if (!data || !recommendation || !recommendationCurrent || !validOrderDate)
      return;
    const lines = recommendation.rows
      .filter((row) => row.quantity !== null)
      .map((row) => ({
        product_id: row.product_id,
        quantity: Number(quantities[row.product_id]),
      }));
    await api(`/stores/${storeId}/orders`, token, {
      method: "POST",
      body: JSON.stringify({ recommendation_id: recommendation.id, lines }),
    });
    saved("발주안을 저장했어요. 점주 확정 후 파일로 내보낼 수 있어요.");
  }

  function productRows(mode: "overview" | "inventory" | "products") {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              {mode === "inventory"
                ? "상품별 재고"
                : mode === "products"
                  ? "등록 상품"
                  : "상품별 준비 현황"}
              <span className="count-label">
                {filtered.length} / {data?.products.length ?? 0}개
              </span>
            </h2>
            <p>
              {mode === "inventory"
                ? "재고를 세어 입력해주세요. 비어 있으면 재고가 없는지 아직 알 수 없어요."
                : "상품별 개수 기준으로 확인해요."}
            </p>
          </div>
          <div className="table-tools">
            <span className="product-filter">
              <Select
                aria-label="상품 종류로 보기"
                value={productCategory}
                onChange={(e) => setProductCategory(e.target.value)}
              >
                <option value="all">모든 상품 종류</option>
                {categoryOptions(data?.products ?? []).map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </Select>
            </span>
            <input
              className="search-input"
              aria-label="상품 검색"
              placeholder="상품 이름 · 코드 · 공급사 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {(search || productCategory !== "all") && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSearch("");
                  setProductCategory("all");
                }}
              >
                전체 보기
              </button>
            )}
            {mode === "products" && owner && (
              <button
                className="button primary small"
                disabled={busy}
                onClick={() => setProductModal("new")}
              >
                <Icon name="plus" size={16} />
                상품 등록
              </button>
            )}
          </div>
        </div>
        {!filtered.length ? (
          <Empty
            title={
              search || productCategory !== "all"
                ? "조건에 맞는 상품이 없어요"
                : "등록된 상품이 없어요"
            }
          >
            {search || productCategory !== "all"
              ? "상품 종류를 바꾸거나 전체 보기를 눌러주세요."
              : "상품을 등록하고 판매 기록을 입력해보세요."}
          </Empty>
        ) : (
          <div className="table-scroll">
            <ResponsiveTable>
              <thead>
                <tr>
                  <th>상품</th>
                  <th>{mode === "products" ? "공급사" : "내일 판매 예측"}</th>
                  <th>{mode === "products" ? "판매가 / 원가" : "확인 재고"}</th>
                  <th>
                    {mode === "products" ? "도착 · 유통기한" : "준비 상태"}
                  </th>
                  <th className="number">관리</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const inventory = data?.inventory[product.id];
                  const prediction = forecast?.products.find(
                    (item) => item.product_id === product.id,
                  )?.points[0];
                  const quantity = inventory?.batches
                    .filter((batch) => batch.expires_on > today)
                    .reduce((sum, batch) => sum + batch.quantity, 0);
                  const current = inventory?.measured_on === today;
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="product-cell">
                          <span
                            className={`product-symbol category-${({ 음료: "drink", 유제품: "milk", 신선식품: "fresh", 베이커리: "bakery", 냉동식품: "frozen" } as Record<string, string>)[product.category] ?? "food"}`}
                          >
                            <Icon name="products" />
                          </span>
                          <div>
                            <strong>{product.name}</strong>
                            <small>
                              {product.id} · {product.category}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {mode === "products" ? (
                          product.supplier
                        ) : prediction ? (
                          <>
                            <strong>{units(prediction.p50)}개</strong>
                            <small>
                              {units(prediction.p10)}~{units(prediction.p90)}개
                              · 예상 범위
                            </small>
                          </>
                        ) : (
                          <span className="muted">
                            {forecast ? "기록 부족" : "예측 대기"}
                          </span>
                        )}
                      </td>
                      <td>
                        {mode === "products" ? (
                          <>
                            {won(product.price)}
                            <small>매입 {won(product.cost)}</small>
                          </>
                        ) : inventory ? (
                          <>
                            {units(quantity ?? 0)}개
                            <small>{inventory.measured_on} 기준</small>
                          </>
                        ) : (
                          <span className="muted">미입력</span>
                        )}
                      </td>
                      <td>
                        {mode === "products" ? (
                          <>
                            발주 후 {product.lead_days}일 뒤 도착
                            <small>
                              유통기한 {product.shelf_days}일 ·{" "}
                              {product.review_days}일마다 발주
                            </small>
                          </>
                        ) : (
                          <span
                            className={`pill ${current ? "mint" : "amber"}`}
                          >
                            {current
                              ? "재고 확인됨"
                              : inventory
                                ? "재확인 필요"
                                : "재고 입력 필요"}
                          </span>
                        )}
                      </td>
                      <td className="number">
                        {mode === "products" ? (
                          owner ? (
                            <button
                              className="button table-button"
                              disabled={busy}
                              onClick={() => setProductModal(product)}
                            >
                              수정
                            </button>
                          ) : (
                            <span className="muted">조회</span>
                          )
                        ) : (
                          <button
                            className="button table-button"
                            disabled={busy || loading || replay}
                            onClick={() => setInventoryProduct(product)}
                          >
                            {inventory ? "재고 수정" : "재고 입력"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ResponsiveTable>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="app-shell merchant-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Icon name="store" size={24} />
          </span>
          <strong>
            화개장날<span>.</span>
          </strong>
        </div>
        <div className="workspace-label">매장 운영</div>
        <nav aria-label="주 메뉴">
          {tabs
            .filter(
              (item) =>
                item.id !== "model-demo" &&
                (item.id !== "ai-settings" || owner),
            )
            .map((item) => (
              <button
                key={item.id}
                aria-label={item.label}
                className={`nav-item ${tab === item.id ? "active" : ""}`}
                aria-current={tab === item.id ? "page" : undefined}
                disabled={busy}
                onClick={() => navigate(item.id)}
              >
                <Icon name={item.id === "model-demo" ? "forecast" : item.id} />
                <span>{item.label}</span>
                {item.id === "inventory" && missingStock > 0 && (
                  <em>{missingStock}</em>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="guide-card">
            <span className="guide-icon">
              <Icon name="store" size={23} />
            </span>
            <strong>오늘도, 필요한 만큼.</strong>
            <p>
              판매 기록을 입력하고
              <br />
              재고를 확인하면 준비 끝.
            </p>
            <button className="text-button" onClick={() => navigate("sales")}>
              판매 기록 입력하기 <Icon name="arrow" size={15} />
            </button>
          </div>
          <span className="team-label">TEAM 화개장터</span>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div className="account-actions">
            <span className="user-avatar">{owner ? "사" : "직"}</span>
            <span>
              {user.name}
              <small>{owner ? "점주" : "직원"}</small>
            </span>
            <button
              className="text-button muted"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  // Leaving the replay cancels its in-flight model request immediately.
                  if (modelDemo) navigate("overview");
                  await api("/auth/logout", token, { method: "POST" });
                  clearSession();
                })
              }
            >
              로그아웃
            </button>
          </div>
        </header>
        <main className="workspace-main">
          <div className="page-heading">
            <div>
              <div className="overline">화개장날 사장님 서비스</div>
              <h1>
                {tab === "overview"
                  ? (store?.name ?? "우리 매장")
                  : currentTab.label}
              </h1>
              {tab !== "overview" && <p>{currentTab.description}</p>}
              {!modelDemo && store?.timezone && (
                <p>
                  {store.city} · {today} 마감 기준
                </p>
              )}
            </div>
            {!modelDemo && (
              <div className="store-picker">
                <Icon name="store" />
                <Select
                  aria-label="매장 선택"
                  disabled={busy}
                  value={storeId}
                  onChange={(event) => {
                    const next = stores.find(
                      (item) => item.id === event.target.value,
                    );
                    recommendationRequest.current?.abort();
                    setRecommendation(null);
                    setStoreId(event.target.value);
                    if (tab === "ai-settings" && next?.role !== "owner")
                      setTab("overview");
                    setSearch("");
                    setAsOf(next?.local_today ?? serverToday);
                    setInventoryProduct(null);
                    setProductModal(null);
                  }}
                >
                  {stores.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
                {owner && (
                  <button
                    className="icon-button"
                    aria-label="매장 추가"
                    disabled={busy}
                    onClick={() => setStoreModal(true)}
                  >
                    <Icon name="plus" size={18} />
                  </button>
                )}
              </div>
            )}
          </div>
          {notice && (
            <div className="toast" role="status">
              <Icon name="check" />
              {notice}
              <button
                className="icon-button"
                aria-label="알림 닫기"
                onClick={() => setNotice("")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {!modelDemo && error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="text-button"
                disabled={busy || loading}
                onClick={() =>
                  void action(async () => {
                    await refreshStores();
                    setReload((value) => value + 1);
                  })
                }
              >
                다시 연결
              </button>
            </div>
          )}
          {!modelDemo && loading && (
            <div className="loading-banner" role="status">
              <span className="loading-spinner" />
              판매 기록과 매장 자료를 확인하고 있어요…
            </div>
          )}
          {!modelDemo && !data && !loading && !error && (
            <Empty title="매장을 준비하고 있어요">
              접근 가능한 매장이 없다면 점주에게 소속을 확인해주세요.
            </Empty>
          )}
          {modelDemo && (
            <ModelDemo token={token} onSessionExpired={clearSession} />
          )}
          {!modelDemo && store && tab === "forecast" && (
            <MerchantModelPanel
              key={`${token}:${storeId}`}
              token={token}
              storeId={storeId}
              asOf={asOf}
              today={today}
              weatherMode={forecast?.weather.mode}
              owner={owner}
              busy={busy}
              onBusyChange={setBusy}
              onSessionExpired={clearSession}
              onChanged={() => {
                setForecastResult(null);
                setRecommendation(null);
                setAsOf(today);
                setReload((value) => value + 1);
                setNotice("예측 방식을 바꿨어요. 새 모델로 다시 계산해요.");
              }}
            />
          )}
          {!modelDemo &&
            (tab === "overview" || tab === "forecast" || tab === "orders") &&
            forecastLoading && (
              <div className="loading-banner" role="status">
                <span className="loading-spinner" />
                날씨와 판매 기록으로 7일 예측을 계산하고 있어요. 판매·재고
                입력은 계속할 수 있어요.
              </div>
            )}
          {!modelDemo &&
            (tab === "overview" || tab === "forecast" || tab === "orders") &&
            forecastError && (
              <div className="error-banner" role="alert">
                <div>
                  <strong>판매 예측을 완료하지 못했어요.</strong>
                  <p>{forecastError}</p>
                  <small>
                    상품·판매 기록·재고는 계속 확인하고 수정할 수 있어요.
                  </small>
                </div>
                <button
                  className="text-button"
                  disabled={busy || forecastLoading}
                  onClick={() => setForecastReload((value) => value + 1)}
                >
                  예측 다시 시도
                </button>
                {replay && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setAsOf(today)}
                  >
                    오늘 예측으로
                  </button>
                )}
              </div>
            )}
          {tab === "ai-settings" && owner && store && (
            <AiSettings
              key={`${token}:${storeId}`}
              token={token}
              storeId={storeId}
              onExpired={clearSession}
            />
          )}
          {!modelDemo && data && (
            <div
              className={loading ? "content-updating" : undefined}
              aria-busy={loading}
            >
              {!data.products.length && owner && tab !== "ai-settings" && (
                <InitialData
                  key={storeId}
                  token={token}
                  storeId={storeId}
                  onSaved={(text) => void imported(text)}
                  onSessionExpired={clearSession}
                />
              )}
              {owner && store && tab in ASSISTANT_TASKS && (
                <AiAssistant
                  key={`${storeId}:${tab}:${reload}:${asOf}:${forecast?.id ?? ""}`}
                  token={token} storeId={storeId} onExpired={clearSession}
                  tab={tab as keyof typeof ASSISTANT_TASKS} asOf={asOf}
                  forecastId={forecast?.as_of === asOf ? forecast.id : undefined}
                  disabled={busy || loading} onSetup={() => navigate("ai-settings")}
                />
              )}
              {tab === "overview" && store && data.products.length > 0 && (
                <MerchantOverview
                  store={store}
                  user={user}
                  today={today}
                  products={data.products}
                  inventory={data.inventory}
                  sales={data.sales}
                  forecast={forecast}
                  orders={data.orders}
                  selectedForecast={selectedForecast}
                  onSelectProduct={setSelectedProduct}
                  onNavigate={navigate}
                  onOrder={setOrderDetail}
                  disabled={busy || loading}
                  onInventory={(product) => {
                    if (!busy) setInventoryProduct(product);
                  }}
                />
              )}
              {tab === "forecast" && (
                <>
                  <div className="stat-grid">
                    <article className="stat-card">
                      <span>
                        예측 가능한 상품
                        <Icon name="forecast" />
                      </span>
                      <strong>
                        {readyCount}
                        <em> / {data.products.length}개</em>
                      </strong>
                      <small>7일 예측이 준비된 상품</small>
                    </article>
                    <article className="stat-card">
                      <span>
                        {replay ? "재생 기준일" : "재고 확인 필요"}
                        <Icon name="inventory" />
                      </span>
                      <strong>
                        {replay ? shortDate(asOf) : missingStock}
                        <em>{replay ? "" : "개"}</em>
                      </strong>
                      <small>
                        {replay
                          ? "미래 기록을 가린 과거 비교"
                          : "입력 전에는 예측만 제공해요"}
                      </small>
                    </article>
                    <article className="stat-card">
                      <span>
                        저장된 판매 기록
                        <Icon name="sales" />
                      </span>
                      <strong>
                        {data.sales.summary.count.toLocaleString()}
                        <em>건</em>
                      </strong>
                      <small>자료 전체 · 날짜·상품별 기록</small>
                    </article>
                    <article className="stat-card">
                      <span>
                        최근 판매 기록일
                        <Icon name="check" />
                      </span>
                      <strong>
                        {data.sales.summary.last_date
                          ? shortDate(data.sales.summary.last_date)
                          : "—"}
                      </strong>
                      <small>영업일 누락 여부를 확인하세요</small>
                    </article>
                  </div>
                  {forecast && (
                    <section className="panel weather-panel">
                      <div className="weather-title">
                        <span className="weather-title-icon">
                          <Icon name="sun" size={27} />
                        </span>
                        <div>
                          <h2>{store?.city} 날씨</h2>
                          <p>
                            {weatherLabel}
                            {forecast.weather.mode ===
                              "historical_reanalysis" ||
                            forecast.weather.mode === "recent_weather"
                              ? " · 당시 예보 아님"
                              : " · 앞으로 7일"}
                          </p>
                        </div>
                        <span className="pill neutral">날씨 예보</span>
                      </div>
                      {forecast.weather.days.length > 0 ? (
                        <div className="weather-days">
                          {forecast.weather.days.map((day) => (
                            <div className="weather-day" key={day.date}>
                              <span>{shortDate(day.date)}</span>
                              <Icon
                                name={
                                  day.code === null
                                    ? "cloud"
                                    : day.code >= 50
                                      ? "rain"
                                      : day.code <= 1
                                        ? "sun"
                                        : "cloud"
                                }
                                size={25}
                              />
                              <strong>
                                {day.temp_max === null
                                  ? "—"
                                  : Math.round(day.temp_max) + "°"}
                                <small>
                                  {day.temp_min === null
                                    ? "—"
                                    : Math.round(day.temp_min) + "°"}
                                </small>
                              </strong>
                              <em>
                                {day.rain_probability !== null
                                  ? `${day.rain_probability}%`
                                  : day.rain_mm !== null
                                    ? `${day.rain_mm}mm`
                                    : "—"}
                              </em>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="weather-unavailable">
                          {forecast.weather.message ??
                            "날씨 자료를 불러오지 못했어요."}
                        </div>
                      )}
                      <div className="weather-caption">
                        {forecast.model.uses_weather
                          ? "판매 예측에 반영한 날씨예요."
                          : "참고용 날씨예요. 판매 예측에는 반영하지 않았어요."}
                      </div>
                      <WeatherSource weather={forecast.weather} />
                    </section>
                  )}
                  <section className="panel">
                    <div className="panel-heading forecast-heading">
                      <div>
                        <h2>앞으로 7일, 얼마나 팔릴까요?</h2>
                        <p>
                          예상 판매량과 적게·많이 팔릴 때의 범위를 확인하세요.
                        </p>
                      </div>
                      <div className="forecast-controls">
                        <Select
                          aria-label="예측 상품 선택"
                          value={selectedForecast?.product_id ?? ""}
                          onChange={(event) =>
                            setSelectedProduct(event.target.value)
                          }
                        >
                          {data.products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                        </Select>
                        <label className="date-picker">
                          판매 기준일
                          <DateField
                            aria-label="예측 기준일"
                            value={asOf}
                            max={today}
                            required
                            disabled={busy}
                            onChange={(event) => {
                              if (event.target.value) {
                                setAsOf(event.target.value);
                                setTab("forecast");
                              }
                            }}
                          />
                        </label>
                        {replay && (
                          <button
                            className="button secondary small"
                            onClick={() => setAsOf(today)}
                          >
                            오늘로
                          </button>
                        )}
                      </div>
                    </div>
                    {selectedForecast ? (
                      <ForecastChart
                        forecast={selectedForecast}
                        onHistory={() => navigate("sales")}
                      />
                    ) : (
                      <Empty
                        title={
                          data.products.length
                            ? "예측 결과를 기다리고 있어요"
                            : "예측할 상품이 없어요"
                        }
                      >
                        {data.products.length
                          ? "모델 연결과 판매 기록을 확인한 뒤 예측을 다시 시도해주세요."
                          : "상품을 먼저 등록해주세요."}
                      </Empty>
                    )}
                    {tab === "forecast" &&
                      selectedForecast &&
                      selectedForecast.points.length > 0 && (
                        <div className="table-scroll">
                          <ResponsiveTable>
                            <thead>
                              <tr>
                                <th>판매일</th>
                                <th className="number">적게 팔릴 때</th>
                                <th className="number">예상 판매</th>
                                <th className="number">많이 팔릴 때</th>
                                <th className="number">실제 판매</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedForecast.points.map((point) => (
                                <tr key={point.date}>
                                  <td>{point.date}</td>
                                  <td className="number">
                                    {units(point.p10)}개
                                  </td>
                                  <td className="number">
                                    <strong>{units(point.p50)}개</strong>
                                  </td>
                                  <td className="number">
                                    {units(point.p90)}개
                                  </td>
                                  <td className="number">
                                    {point.actual === null
                                      ? "—"
                                      : units(point.actual) + "개"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </ResponsiveTable>
                        </div>
                      )}
                    {forecast && (
                      <p className="chart-footnote">
                        예상 판매량과 적게·많이 팔릴 때의 범위를 함께
                        보여드려요. 실제 판매량은 날씨와 매장 상황에 따라 달라질
                        수 있어요.
                      </p>
                    )}
                  </section>
                </>
              )}
              {tab === "sales" && (
                <>
                {owner && <AiSalesMemo key={`memo:${storeId}:${reload}`} token={token} storeId={storeId}
                  products={data.products} today={today} onSaved={saved} onExpired={clearSession} />}
                <SalesPanel
                  key={storeId}
                  token={token}
                  storeId={storeId}
                  products={data.products}
                  sales={data.sales}
                  today={today}
                  onSaved={saved}
                />
                </>
              )}
              {tab === "inventory" && (
                <>
                  <div className="info-banner">
                    <Icon name="inventory" />
                    <div>
                      <strong>재고를 모르면 발주량을 계산하지 않아요.</strong>
                      <p>
                        현재 재고가 없을 때는 직접 0개로 확인해주세요. 만료일과
                        입고 예정도 함께 반영해요.
                      </p>
                    </div>
                  </div>
                  {productRows("inventory")}
                  <div className="page-bottom-action">
                    <span>재고 확인이 끝났나요?</span>
                    <button
                      className="button primary"
                      onClick={() => navigate("orders")}
                    >
                      발주 계획으로 이동
                      <Icon name="arrow" size={17} />
                    </button>
                  </div>
                </>
              )}
              {tab === "products" && productRows("products")}
              {tab === "orders" && (
                <>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>새 발주 계획</h2>
                        <p>
                          판매·재고 기준일 {asOf} · 매장 현지 날짜. 발주
                          예정일과 입고까지 걸리는 기간을 함께 반영해요.
                        </p>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          busy ||
                          loading ||
                          replay ||
                          !validOrderDate ||
                          forecastLoading ||
                          !forecast
                        }
                        onClick={() => void action(calculate)}
                      >
                        <Icon name="refresh" size={17} />
                        {busy
                          ? "처리 중…"
                          : recommendation
                            ? "다시 계산"
                            : "발주량 계산"}
                      </button>
                    </div>
                    <div className="plan-summary">
                      <label className="date-picker">
                        발주 예정일
                        <DateField
                          aria-label="발주 예정일"
                          value={orderDate}
                          min={today}
                          max={addCalendarDays(today, 6)}
                          required
                          disabled={busy || loading || replay}
                          onChange={(event) => {
                            recommendationRequest.current?.abort();
                            setRecommendation(null);
                            setQuantities({});
                            setOrderDate(event.target.value);
                          }}
                        />
                      </label>
                      <span>
                        오늘부터 7일 중 선택 · 날짜를 바꾸면 다시 계산해요.
                      </span>
                    </div>
                    {replay && (
                      <p className="helper assumptions">
                        과거 판매·날씨는 예측 화면에서 볼 수 있어요. 현재 재고로
                        발주하려면 오늘 기준 예측을 사용해주세요.
                      </p>
                    )}
                    {!recommendation || !recommendationCurrent ? (
                      <Empty
                        title={
                          forecast
                            ? "필요한 발주량을 확인해보세요"
                            : "판매 예측부터 준비해주세요"
                        }
                      >
                        {forecast
                          ? "재고를 입력한 상품부터 계산할 수 있어요."
                          : "7일 판매 예측이 완료되면 재고를 반영해 발주량을 계산해요."}
                        <br />
                        <button
                          className="text-button"
                          onClick={() => navigate("inventory")}
                        >
                          재고 확인하러 가기 →
                        </button>
                      </Empty>
                    ) : (
                      <>
                        <div className="plan-summary">
                          <span>
                            발주 예정{" "}
                            <strong>{recommendation.order_date ?? asOf}</strong>
                          </span>
                          <span>
                            계산 가능한 상품{" "}
                            <strong>
                              {recommendation.calculated_count} /{" "}
                              {recommendation.rows.length}개
                            </strong>
                          </span>
                          <span>
                            수정 수량 기준 부분 합계{" "}
                            <strong>{won(editedTotal)}</strong>
                          </span>
                        </div>
                        <div className="table-scroll">
                          <ResponsiveTable>
                            <thead>
                              <tr>
                                <th>상품</th>
                                <th>입고 예정</th>
                                <th className="number">추천 수량</th>
                                <th>최종 발주 개수</th>
                                <th className="number">매입액</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recommendation.rows.map((row) => (
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
                                    {row.quantity === null
                                      ? "—"
                                      : row.quantity + "개"}
                                  </td>
                                  <td>
                                    {row.quantity === null ? (
                                      <span className="pill amber">
                                        계산 보류
                                      </span>
                                    ) : (
                                      <input
                                        className="quantity-input"
                                        aria-label={`${row.name} 최종 발주 개수`}
                                        type="number"
                                        min="0"
                                        max="7000000"
                                        step="1"
                                        value={quantities[row.product_id] ?? ""}
                                        onChange={(event) =>
                                          setQuantities({
                                            ...quantities,
                                            [row.product_id]:
                                              event.target.value,
                                          })
                                        }
                                      />
                                    )}
                                  </td>
                                  <td className="number">
                                    {row.quantity === null
                                      ? "—"
                                      : won(
                                          Number(
                                            quantities[row.product_id] || 0,
                                          ) * row.cost,
                                        )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </ResponsiveTable>
                        </div>
                        <p className="helper assumptions">
                          {recommendation.assumptions}
                          <br />
                          시나리오 비교용 근사 계획이며, 실제 폐기·품절 감소를
                          보장하지 않아요.
                        </p>
                        {owner && (
                          <AiExplanation
                            key={recommendation.id}
                            token={token}
                            storeId={storeId}
                            recommendationId={recommendation.id}
                            onExpired={clearSession}
                          />
                        )}
                        <div className="panel-footer">
                          <span>미계산 상품은 저장 대상에서 제외돼요.</span>
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              loading ||
                              !recommendationCurrent ||
                              !recommendation.calculated_count ||
                              invalidQuantity
                            }
                            onClick={() => void action(saveOrder)}
                          >
                            발주안 저장
                            <Icon name="check" size={16} />
                          </button>
                        </div>
                      </>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          저장한 발주안
                          <span className="count-label">
                            {data.orders.length}
                          </span>
                        </h2>
                        <p>
                          직원은 초안 작성, 점주는 확정과 파일 내보내기가
                          가능해요.
                        </p>
                      </div>
                    </div>
                    {!data.orders.length ? (
                      <Empty title="아직 저장한 발주안이 없어요">
                        수량을 확인한 뒤 발주안을 저장해주세요.
                      </Empty>
                    ) : (
                      <div className="table-scroll">
                        <ResponsiveTable>
                          <thead>
                            <tr>
                              <th>발주안</th>
                              <th>작성자</th>
                              <th>상태</th>
                              <th className="number">매입액</th>
                              <th className="number">확정 · 내보내기</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.orders.map((order) => (
                              <tr key={order.id}>
                                <td>
                                  <button
                                    type="button"
                                    className="order-title"
                                    onClick={() => setOrderDetail(order)}
                                    aria-label={`${order.order_date ?? order.as_of} 발주 내용 보기`}
                                  >
                                    {order.order_date ?? order.as_of} 발주 예정{" "}
                                    <span>내용 보기</span>
                                  </button>
                                  <small>
                                    판매 기준 {order.as_of} ·{" "}
                                    {order.lines.length}개 상품 ·{" "}
                                    {order.id.slice(0, 8)}
                                    {order.stale ? " · 현재 자료와 다름" : ""}
                                  </small>
                                </td>
                                <td>{order.author}</td>
                                <td>
                                  <span
                                    className={`pill ${order.status === "confirmed" ? "mint" : "neutral"}`}
                                  >
                                    {order.status === "confirmed"
                                      ? "확정"
                                      : "초안"}
                                  </span>
                                </td>
                                <td className="number">{won(order.total)}</td>
                                <td className="number">
                                  <div className="row-actions">
                                    {owner && order.status === "draft" && (
                                      <button
                                        className="button table-button"
                                        disabled={
                                          busy ||
                                          loading ||
                                          order.stale ||
                                          order.as_of !== today
                                        }
                                        onClick={() =>
                                          void action(async () => {
                                            await api(
                                              `/stores/${storeId}/orders/${order.id}/confirm`,
                                              token,
                                              { method: "POST" },
                                            );
                                            saved("발주안을 확정했어요.");
                                          })
                                        }
                                      >
                                        점주 확정
                                      </button>
                                    )}
                                    {owner &&
                                      order.status === "confirmed" &&
                                      (["csv", "xlsx"] as const).map(
                                        (format) => (
                                          <button
                                            key={format}
                                            className="button table-button"
                                            disabled={busy}
                                            onClick={() =>
                                              void action(async () => {
                                                const exported = await download(
                                                  `/stores/${storeId}/orders/${order.id}/export?format=${format}`,
                                                  token,
                                                  `화개장날_발주서_${order.order_date ?? order.as_of}.${format}`,
                                                );
                                                if (exported)
                                                  setNotice(
                                                    "저장 당시 수량으로 발주서를 내보냈어요.",
                                                  );
                                              })
                                            }
                                          >
                                            {format === "xlsx"
                                              ? "Excel"
                                              : "CSV"}{" "}
                                            ↓
                                          </button>
                                        ),
                                      )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </ResponsiveTable>
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
          <footer className="workspace-footer">
            <span>화개장날 · 화개장터 팀</span>
            <span>
              {modelDemo
                ? "과거 공개 데이터 재현 · 현재 매장 발주와 분리된 체험"
                : "판매 예측과 발주량을 구분해, 필요한 만큼 준비해요."}
            </span>
          </footer>
        </main>
      </div>
      {inventoryProduct && data && (
        <InventoryModal
          key={`${storeId}-${inventoryProduct.id}`}
          token={token}
          storeId={storeId}
          product={inventoryProduct}
          stock={data.inventory[inventoryProduct.id]}
          today={today}
          onSaved={saved}
          onClose={() => setInventoryProduct(null)}
        />
      )}
      {orderDetail && (
        <OrderDetails
          ai={owner ? { token, storeId, onExpired: clearSession } : undefined}
          order={
            data?.orders.find((order) => order.id === orderDetail.id) ??
            orderDetail
          }
          onClose={() => setOrderDetail(null)}
          onOpenOrders={() => navigate("orders")}
        />
      )}
      {productModal && (
        <ProductModal
          key={productModal === "new" ? "new" : productModal.id}
          token={token}
          storeId={storeId}
          product={productModal === "new" ? undefined : productModal}
          onSaved={saved}
          onClose={() => setProductModal(null)}
        />
      )}
      {storeModal && (
        <StoreModal
          token={token}
          onSaved={(id) => {
            void action(async () => {
              setAsOf(await refreshStores(id));
              setTab("products");
              setNotice(
                "매장을 등록했어요. 엑셀 자료를 가져오거나 상품을 직접 등록하세요.",
              );
            });
          }}
          onClose={() => setStoreModal(false)}
        />
      )}
    </div>
  );
}

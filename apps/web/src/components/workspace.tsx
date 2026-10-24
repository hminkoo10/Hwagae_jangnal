"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  download,
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

type Tab =
  "overview" | "forecast" | "sales" | "inventory" | "products" | "orders";
const tabs: { id: Tab; label: string; description: string }[] = [
  {
    id: "overview",
    label: "홈",
    description: "판매 예측부터 발주 준비까지, 오늘 필요한 정보를 확인하세요.",
  },
  {
    id: "forecast",
    label: "7일 판매 예측",
    description: "상품별 예측 범위와 과거 실제 판매를 확인하세요.",
  },
  {
    id: "sales",
    label: "판매 기록",
    description: "판매 기록이 쌓일수록 우리 매장의 패턴을 살펴볼 수 있어요.",
  },
  {
    id: "inventory",
    label: "재고 확인",
    description: "재고와 입고 예정을 직접 확인한 상품부터 발주량을 계산해요.",
  },
  {
    id: "products",
    label: "상품 · 공급사",
    description: "매입 원가와 입고·판매 기간을 상품별로 설정하세요.",
  },
  {
    id: "orders",
    label: "발주 계획",
    description: "필요한 수량을 확인하고 수정한 뒤 발주서로 저장하세요.",
  },
];
type Bundle = {
  storeId: string;
  products: Product[];
  inventory: Record<string, Stock>;
  sales: SalesData;
  forecast: Forecast;
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
          <h2>우리 매장으로 들어가기</h2>
          <p className="muted">오늘의 준비를 시작해볼까요?</p>
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
          <p className="helper">
            기본 체험 매장의 상품·가격·판매 기록은 가상 자료예요.
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
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  const [today, setToday] = useState("");
  const [asOf, setAsOf] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [selectedProduct, setSelectedProduct] = useState("P001");
  const [inventoryProduct, setInventoryProduct] = useState<Product | null>(
    null,
  );
  const [productModal, setProductModal] = useState<Product | "new" | null>(
    null,
  );
  const [storeModal, setStoreModal] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(
    null,
  );
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const store = stores.find((item) => item.id === storeId);
  const sampleDemo = store?.demo_kind === "walmart_tft";
  const forecastDate = store?.demo_as_of ?? asOf;

  function acceptLogin(value: string, account: User) {
    sessionStorage.setItem("hwagae-session", value);
    setToken(value);
    setUser(account);
  }
  const clearSession = useCallback(() => {
    sessionStorage.removeItem("hwagae-session");
    setToken("");
    setUser(null);
    setStores([]);
    setStoreId("");
    setAsOf("");
    setBundle(null);
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
        setUser(account);
        setToken(stored);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          sessionStorage.removeItem("hwagae-session");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, []);

  const refreshStores = useCallback(
    async (preferred?: string) => {
      const result = await api<{ stores: Store[]; today: string }>(
        "/stores",
        token,
      );
      setStores(result.stores);
      setToday(result.today);
      setAsOf((current) => current || result.today);
      setStoreId(
        (current) =>
          preferred ??
          (result.stores.some((store) => store.id === current)
            ? current
            : (result.stores.find((store) => store.id === "gwangju")?.id ??
              result.stores[0]?.id ??
              "")),
      );
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
    if (!token || !storeId || !forecastDate) return;
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
      api<SalesData>(
        `/stores/${storeId}/sales${sampleDemo ? "?limit=200" : ""}`,
        token,
        options,
      ),
      api<{ orders: Order[] }>(`/stores/${storeId}/orders`, token, options),
      api<Forecast>(`/stores/${storeId}/forecasts?as_of=${forecastDate}`, token, {
        ...options,
        method: "POST",
      }),
    ])
      .then(([catalog, sales, orders, forecast]) =>
        setBundle({
          storeId,
          ...catalog,
          sales,
          orders: orders.orders,
          forecast,
        }),
      )
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
  }, [token, storeId, forecastDate, sampleDemo, reload, clearSession]);

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
  function navigate(next: Tab) {
    setTab(next);
    setSearch("");
    if (next !== "forecast") setAsOf(store?.demo_as_of ?? today);
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (error) {
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
  if (!user) return <LoginScreen onLogin={acceptLogin} />;

  const data =
    bundle?.storeId === storeId && bundle.forecast.as_of === forecastDate
      ? bundle
      : null;
  const replay = !!today && forecastDate !== today;
  const persistenceDemo =
    data?.forecast.weather.mode === "historical_persistence_demo";
  const owner = store?.role === "owner";
  const currentTab = tabs.find((item) => item.id === tab)!;
  const filtered =
    data?.products.filter((product) =>
      `${product.name} ${product.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const readyCount =
    data?.forecast.products.filter((product) => product.status === "ready")
      .length ?? 0;
  const missingStock =
    data?.products.filter(
      (product) =>
        !data.inventory[product.id] ||
        data.inventory[product.id].measured_on !== today,
    ).length ?? 0;
  const selectedForecast =
    data?.forecast.products.find(
      (product) => product.product_id === selectedProduct,
    ) ?? data?.forecast.products[0];
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
        Number(quantities[row.product_id]) > 1000000),
  );

  async function calculate() {
    if (!data) return;
    const result = await api<Recommendation>(
      `/stores/${storeId}/recommendations`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ forecast_id: data.forecast.id }),
      },
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
    if (!recommendation) return;
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
              <span className="count-label">{data?.products.length ?? 0}</span>
            </h2>
            <p>
              {mode === "inventory"
                ? "빈 재고는 0개가 아니에요. 실사 후 직접 입력해주세요."
                : "상품별 개수 기준으로 확인해요."}
            </p>
          </div>
          <div className="table-tools">
            <input
              className="search-input"
              aria-label="상품 검색"
              placeholder="상품명 · 코드 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {mode === "products" && owner && !sampleDemo && (
              <button
                className="button primary small"
                onClick={() => setProductModal("new")}
              >
                <Icon name="plus" size={16} />
                상품 등록
              </button>
            )}
          </div>
        </div>
        {!filtered.length ? (
          <Empty title={search ? "검색 결과가 없어요" : "등록된 상품이 없어요"}>
            {search
              ? "다른 상품명이나 코드를 입력해보세요."
              : "상품을 등록하고 판매 기록을 입력해보세요."}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>상품</th>
                  <th>{mode === "products" ? "공급사" : "내일 판매 예측"}</th>
                  <th>{mode === "products" ? "판매가 / 원가" : "확인 재고"}</th>
                  <th>
                    {mode === "products" ? "납기 / 판매 기간" : "준비 상태"}
                  </th>
                  <th className="number">관리</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const inventory = data?.inventory[product.id];
                  const prediction = data?.forecast.products.find(
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
                            className={`product-symbol category-${product.category === "음료" ? "drink" : product.category === "유제품" ? "milk" : "food"}`}
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
                              · P10~P90
                            </small>
                          </>
                        ) : (
                          <span className="muted">기록 부족</span>
                        )}
                      </td>
                      <td>
                        {mode === "products" ? (
                          <>
                            {product.price === null
                              ? "판매가 미제공"
                              : won(product.price)}
                            <small>
                              {product.cost === null
                                ? "원가 미제공"
                                : `매입 ${won(product.cost)}`}
                            </small>
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
                            {product.commercial_settings_available === false ? (
                              "자료 미제공"
                            ) : (
                              <>
                                {product.lead_days}일 / {product.shelf_days}일
                                <small>{product.review_days}일마다 발주</small>
                              </>
                            )}
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
                          owner && !sampleDemo ? (
                            <button
                              className="button table-button"
                              onClick={() => setProductModal(product)}
                            >
                              설정
                            </button>
                          ) : (
                            <span className="muted">조회</span>
                          )
                        ) : (
                          <button
                            className="button table-button"
                            disabled={loading || replay}
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
            </table>
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
          {tabs.filter((item) =>
            !sampleDemo || !["inventory", "orders"].includes(item.id),
          ).map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.id} />
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
            <strong>{sampleDemo ? "Walmart 과거 재현" : "오늘도, 필요한 만큼."}</strong>
            <p>
              {sampleDemo ? "실제 판매 기록과" : "판매 기록을 입력하고"}
              <br />
              {sampleDemo ? "7일 예측을 확인하세요." : "재고를 확인하면 준비 끝."}
            </p>
            <button className="text-button" onClick={() => navigate("sales")}>
              판매 기록 {sampleDemo ? "확인하기" : "입력하기"} <Icon name="arrow" size={15} />
            </button>
          </div>
          <span className="team-label">TEAM 화개장터</span>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="breadcrumb">
            내 매장 <span>/</span> <strong>{currentTab.label}</strong>
          </span>
          <div className="account-actions">
            <span className="user-avatar">{owner ? "사" : "직"}</span>
            <span>
              {user.name}
              <small>{owner ? "점주" : "직원"}</small>
            </span>
            <button
              className="text-button muted"
              onClick={() =>
                void action(async () => {
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
              <p>
                {sampleDemo
                  ? `Walmart 공개자료 · ${forecastDate} 기준 과거 판매 재현`
                  : currentTab.description}
              </p>
            </div>
            <div className="store-picker">
              <Icon name="store" />
              <select
                aria-label="매장 선택"
                value={storeId}
                onChange={(event) => {
                  const nextStore = stores.find(
                    (item) => item.id === event.target.value,
                  );
                  setStoreId(event.target.value);
                  setSearch("");
                  setAsOf(nextStore?.demo_as_of ?? today);
                  if (nextStore?.demo_as_of && (tab === "inventory" || tab === "orders"))
                    setTab("overview");
                  setInventoryProduct(null);
                  setProductModal(null);
                }}
              >
                {stores.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {owner && !sampleDemo && (
                <button
                  className="icon-button"
                  aria-label="매장 추가"
                  onClick={() => setStoreModal(true)}
                >
                  <Icon name="plus" size={18} />
                </button>
              )}
            </div>
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
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => setReload((value) => value + 1)}
              >
                다시 연결
              </button>
            </div>
          )}
          {store && (
            <div className="source-note">
              <span className="source-dot" />
              <span>{store.provenance}</span>
              <span className="source-model">
                {data
                  ? `${data.forecast.model.name} · ${persistenceDemo ? "과거 관측 날씨 반복" : data.forecast.model.uses_weather ? "날씨 반영" : "날씨 미반영"}`
                  : "자료 확인 중"}
              </span>
            </div>
          )}
          {sampleDemo && (
            <div className="info-banner">
              <Icon name="forecast" />
              <div>
                <strong>{forecastDate} 기준 · Walmart 과거 재현</strong>
                <p>
                  {store?.demo_notice} 이 화면에서는 제공된 자료와 예측을 조회할 수 있어요.
                </p>
              </div>
            </div>
          )}
          {loading && (
            <div className="loading-banner" role="status">
              <span className="loading-spinner" />
              판매 기록과 날씨를 확인하고 있어요…
            </div>
          )}
          {!data && !loading && !error && (
            <Empty title="매장을 준비하고 있어요">
              접근 가능한 매장이 없다면 점주에게 소속을 확인해주세요.
            </Empty>
          )}
          {data && (
            <div
              className={loading ? "content-updating" : undefined}
              aria-busy={loading}
            >
              {tab === "overview" && store && (
                <MerchantOverview
                  store={store}
                  user={user}
                  today={today}
                  products={data.products}
                  inventory={data.inventory}
                  sales={data.sales}
                  forecast={data.forecast}
                  orders={data.orders}
                  selectedForecast={selectedForecast}
                  onSelectProduct={setSelectedProduct}
                  onNavigate={navigate}
                  onInventory={setInventoryProduct}
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
                        {replay ? shortDate(forecastDate) : missingStock}
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
                  <section className="panel weather-panel">
                    <div className="weather-title">
                      <span className="weather-title-icon">
                        <Icon name="sun" size={27} />
                      </span>
                      <div>
                        <h2>{store?.city} 날씨</h2>
                        <p>
                          {persistenceDemo
                            ? "기준일 관측 날씨를 7일 반복 · 당시 예보 아님"
                            : replay
                              ? "과거 재분석 · 당시 예보 아님"
                              : "앞으로 7일 · 현재 예보"}
                        </p>
                      </div>
                      <span className="pill neutral">{data.forecast.weather.source}</span>
                    </div>
                    {data.forecast.weather.days.length > 0 ? (
                      <div className="weather-days">
                        {data.forecast.weather.days.map((day) => (
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
                        {data.forecast.weather.message ??
                          "날씨 자료를 불러오지 못했어요."}
                      </div>
                    )}
                    <div className="weather-caption">
                      {data.forecast.weather.note} ·{" "}
                      {data.forecast.weather.fetched_at
                        ? `조회 ${new Date(data.forecast.weather.fetched_at).toLocaleString("ko-KR")}`
                        : "원본 관측자료 · 조회 시각 기록 없음"}
                      {data.forecast.weather.cached ? " · 저장된 자료" : ""}
                      {data.forecast.weather.message &&
                      data.forecast.weather.days.length > 0
                        ? ` · ${data.forecast.weather.message}`
                        : ""}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading forecast-heading">
                      <div>
                        <h2>
                          {sampleDemo
                            ? "기준일 다음 7일 판매 예측"
                            : "앞으로 7일, 얼마나 팔릴까요?"}
                        </h2>
                        <p>P50 중앙값과 P10~P90 범위를 함께 확인하세요.</p>
                      </div>
                      <div className="forecast-controls">
                        <select
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
                        </select>
                        <label className="date-picker">
                          기준일
                          <input
                            aria-label="예측 기준일"
                            type="date"
                            value={forecastDate}
                            readOnly={sampleDemo}
                            max={today}
                            required
                            onChange={(event) => {
                              if (event.target.value) {
                                setAsOf(event.target.value);
                                setTab("forecast");
                              }
                            }}
                          />
                        </label>
                        {replay && !sampleDemo && (
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
                      <ForecastChart forecast={selectedForecast} />
                    ) : (
                      <Empty title="예측할 상품이 없어요">
                        상품을 먼저 등록해주세요.
                      </Empty>
                    )}
                    {tab === "forecast" &&
                      selectedForecast &&
                      selectedForecast.points.length > 0 && (
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>판매일</th>
                                <th className="number">P10</th>
                                <th className="number">P50</th>
                                <th className="number">P90</th>
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
                          </table>
                        </div>
                      )}
                    <p className="chart-footnote">
                      {persistenceDemo
                        ? "기준일까지의 판매 기록과 관측 날씨로 예측하며, 미래 날씨는 기준일 값을 반복하는 가정이에요. 당시 발급된 예보는 사용하지 않았어요."
                        : data.forecast.model.uses_weather
                          ? "날씨를 입력으로 사용하는 연결 모델이에요."
                          : "현재는 요일별 과거 판매량으로 계산해요. 표시된 날씨는 예측에 반영하지 않아요."}{" "}
                      예측 범위는 정확도 보장이 아니에요.
                    </p>
                  </section>
                </>
              )}
              {tab === "sales" && (
                <SalesPanel
                  key={storeId}
                  token={token}
                  storeId={storeId}
                  products={data.products}
                  sales={data.sales}
                  today={today}
                  onSaved={saved}
                  readOnly={sampleDemo}
                />
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
                          오늘 기준 재고와 상품 설정으로 계산해요. 실제 업체
                          주문은 별도로 진행해주세요.
                        </p>
                      </div>
                      <button
                        className="button primary"
                        disabled={busy || loading || replay}
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
                    {!recommendation ? (
                      <Empty title="필요한 발주량을 확인해보세요">
                        재고를 입력한 상품부터 계산할 수 있어요.
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
                          <table>
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
                                        max="1000000"
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
                          </table>
                        </div>
                        <p className="helper assumptions">
                          {recommendation.assumptions}
                          <br />
                          시나리오 비교용 근사 계획이며, 실제 폐기·품절 감소를
                          보장하지 않아요.
                        </p>
                        <div className="panel-footer">
                          <span>미계산 상품은 저장 대상에서 제외돼요.</span>
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              loading ||
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
                        <table>
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
                                  <strong>{order.as_of} 발주안</strong>
                                  <small>
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
                                                await download(
                                                  `/stores/${storeId}/orders/${order.id}/export?format=${format}`,
                                                  token,
                                                  `화개장날_발주서_${order.as_of}.${format}`,
                                                );
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
                        </table>
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
          <footer className="workspace-footer">
            <span>화개장날 · 화개장터 팀</span>
            <span>판매 예측과 발주량을 구분해, 필요한 만큼 준비해요.</span>
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
              await refreshStores(id);
              setAsOf(today);
              setTab("products");
              setNotice("새 매장을 추가했어요. 상품부터 등록해주세요.");
            });
          }}
          onClose={() => setStoreModal(false)}
        />
      )}
    </div>
  );
}

"use client";

import { Select, ResponsiveTable } from "./controls";

import {
  shortDate,
  units,
  won,
  type Forecast,
  type Order,
  type Product,
  type ProductForecast,
  type SalesData,
  type Stock,
  type Store,
  type User,
} from "@/lib/api";
import { Empty, ForecastChart, Icon } from "./ui";
import { MerchantMetrics } from "./merchant-metrics";
import { WeatherSource } from "./weather-source";

type Destination = "forecast" | "sales" | "inventory" | "products" | "orders";

type Props = {
  store: Store;
  user: User;
  today: string;
  products: Product[];
  inventory: Record<string, Stock>;
  sales: SalesData;
  forecast: Forecast | null;
  orders: Order[];
  selectedForecast?: ProductForecast;
  onSelectProduct: (id: string) => void;
  onNavigate: (destination: Destination) => void;
  onInventory: (product: Product) => void;
  onOrder: (order: Order) => void;
  disabled?: boolean;
};

function weatherIcon(code: number | null) {
  if (code === null) return "cloud";
  if (code <= 1) return "sun";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ((code >= 51 && code <= 67) || [80, 81, 82, 95, 96, 97, 99].includes(code))
    return "rain";
  return "cloud";
}

export function MerchantOverview({
  store,
  user,
  today,
  products,
  inventory,
  sales,
  forecast,
  orders,
  selectedForecast,
  onSelectProduct,
  onNavigate,
  onInventory,
  onOrder,
  disabled,
}: Props) {
  const checked = products.filter(
    (product) => inventory[product.id]?.measured_on === today,
  ).length;
  const missing = products.length - checked;
  const drafts = orders.filter((order) => order.status === "draft");
  const nextDay = forecast?.dates[0];
  const coverage = products.length
    ? Math.round((checked / products.length) * 100)
    : 0;
  const firstWeather = forecast?.weather.days[0];
  const weatherCurrent = forecast?.weather.status === "ok";
  const todayLabel = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${today}T12:00:00+09:00`));
  const salesCount = sales.summary.count;
  const readyCount =
    forecast?.products.filter(
      (item) => item.status === "ready" && item.points.length > 0,
    ).length ?? 0;
  const todayOrder = orders.find(
    (order) => order.as_of === today && !order.stale,
  );
  const steps: {
    title: string;
    hint: string;
    done: boolean;
    target: Destination;
  }[] = [
    {
      title: "자료 올리기",
      target: "sales",
      done: salesCount > 0,
      hint: salesCount
        ? `판매 기록 ${salesCount.toLocaleString()}건`
        : "엑셀·CSV로 올려요",
    },
    {
      title: "7일 판매 예측",
      target: "forecast",
      done: readyCount > 0,
      hint: readyCount ? `${readyCount}개 상품 예측 완료` : "예측 결과 보기",
    },
    {
      title: "재고 확인",
      target: "inventory",
      done: missing === 0,
      hint: missing ? `${missing}개 남았어요` : "오늘 확인 완료",
    },
    {
      title: "발주 계획",
      target: "orders",
      done: !!todayOrder,
      hint: todayOrder
        ? todayOrder.status === "confirmed"
          ? "오늘 발주 확정"
          : "초안 저장했어요"
        : "추천 수량으로 만들어요",
    },
  ];
  const nextStep = steps.findIndex((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <div className="merchant-overview">
      <div className="merchant-content">
        <div className="merchant-intro">
          <div>
            <h2>오늘은 얼마나 준비할까요?</h2>
            <p>판매 예측과 남은 재고를 확인해요.</p>
          </div>
          <span className="merchant-intro-meta">
            {firstWeather && weatherCurrent && (
              <Icon name={weatherIcon(firstWeather.code)} size={16} />
            )}
            {firstWeather && weatherCurrent
              ? `${shortDate(firstWeather.date)} 최고 ${firstWeather.temp_max === null ? "—" : Math.round(firstWeather.temp_max) + "°"}`
              : todayLabel}
          </span>
        </div>

        <details className="merchant-guide" open={nextStep !== -1}>
          <summary>
            <strong>이렇게 쓰면 돼요</strong>
            <span className="merchant-guide-count">
              {nextStep === -1
                ? "오늘 할 일 끝"
                : `${doneCount} / ${steps.length} 완료`}
            </span>
          </summary>
          <ol className="guide-steps">
            {steps.map((step, index) => {
              const state = step.done
                ? "done"
                : index === nextStep
                  ? "next"
                  : "todo";
              return (
                <li key={step.target}>
                  <button
                    type="button"
                    className={`guide-step ${state}`}
                    aria-current={state === "next" ? "step" : undefined}
                    onClick={() => onNavigate(step.target)}
                  >
                    <span className="guide-step-mark">
                      {step.done ? <Icon name="check" size={14} /> : index + 1}
                    </span>
                    <span className="guide-step-copy">
                      <strong>
                        {step.title}
                        {step.done && <span className="sr-only"> 완료</span>}
                      </strong>
                      <small>{step.hint}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </details>

        <MerchantMetrics
          products={products}
          inventory={inventory}
          forecast={forecast}
          orders={orders}
          today={today}
          disabled={disabled}
          onForecast={(id) => {
            onSelectProduct(id);
            onNavigate("forecast");
          }}
          onHistory={() => onNavigate("sales")}
          onInventory={onInventory}
          onOrder={onOrder}
          onOrders={() => onNavigate("orders")}
        />

        <div className="merchant-chart-row">
          <section className="merchant-card merchant-forecast">
            <div className="merchant-card-heading">
              <div>
                <h2>상품별 7일 판매 예측</h2>
                <p>상품을 고르면 7일 동안 팔 양이 보여요.</p>
              </div>
              <Select
                aria-label="홈 예측 상품 선택"
                value={selectedForecast?.product_id ?? ""}
                onChange={(event) => onSelectProduct(event.target.value)}
              >
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </Select>
            </div>
            {selectedForecast ? (
              <ForecastChart
                forecast={selectedForecast}
                onHistory={() => onNavigate("sales")}
              />
            ) : (
              <Empty
                title={
                  products.length ? "아직 예측이 없어요" : "등록된 상품이 없어요"
                }
              >
                {products.length
                  ? "판매 기록을 올리면 7일 예측이 나와요."
                  : "상품을 등록하면 예측을 시작할 수 있어요."}
              </Empty>
            )}
            <div className="merchant-card-footer">
              <span>
                {forecast
                  ? forecast.model.uses_weather
                    ? "날씨까지 반영한 예측이에요"
                    : "요일별 판매로 예측했어요"
                  : "아직 예측 전이에요"}
              </span>
              <button
                className="text-button"
                onClick={() => onNavigate("forecast")}
              >
                자세히 보기 <Icon name="arrow" size={14} />
              </button>
            </div>
          </section>
          <section className="merchant-card merchant-readiness">
            <div className="merchant-card-heading">
              <div>
                <h2>오늘 재고 확인</h2>
                <p>재고를 적은 상품부터 발주할 수 있어요.</p>
              </div>
            </div>
            <svg
              className="readiness-ring"
              viewBox="0 0 120 120"
              role="img"
              aria-label={`등록 ${products.length}개 중 오늘 재고 확인 ${checked}개, ${coverage}%`}
            >
              <circle
                className="ring-track"
                cx="60"
                cy="60"
                r="44"
                fill="none"
                strokeWidth="11"
              />
              <circle
                className="ring-progress"
                cx="60"
                cy="60"
                r="44"
                fill="none"
                strokeWidth="11"
                strokeDasharray={2 * Math.PI * 44}
                strokeDashoffset={2 * Math.PI * 44 * (1 - coverage / 100)}
                transform="rotate(-90 60 60)"
                strokeLinecap="round"
              />
              <text className="ring-number" x="60" y="60" textAnchor="middle">
                {coverage}%
              </text>
              <text className="ring-caption" x="60" y="77" textAnchor="middle">
                재고 확인
              </text>
            </svg>
            <div className="readiness-legend">
              <span>
                확인 완료 <strong>{checked}개</strong>
              </span>
              <span>
                남은 상품 <strong>{missing}개</strong>
              </span>
            </div>
            <button
              className="button secondary small"
              onClick={() => onNavigate("inventory")}
            >
              재고 입력하기 <Icon name="arrow" size={14} />
            </button>
          </section>
        </div>

        <section className="merchant-card merchant-table-products">
          <div className="merchant-card-heading">
            <div>
              <h2>
                상품별 준비 현황{" "}
                <span className="count-label">{products.length}</span>
              </h2>
              <p>내일 팔 양과 남은 재고를 비교해요.</p>
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("inventory")}
            >
              전체 보기 <Icon name="arrow" size={14} />
            </button>
          </div>
          {products.length ? (
            <div className="table-scroll">
              <ResponsiveTable>
                <thead>
                  <tr>
                    <th>상품</th>
                    <th className="number">
                      {nextDay ? shortDate(nextDay) : "내일"} 예상 판매
                    </th>
                    <th className="number">내일 팔 수 있는 재고</th>
                    <th>확인 상태</th>
                    <th>
                      <span className="sr-only">작업</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {products.slice(0, 5).map((product) => {
                    const stock = inventory[product.id];
                    const fresh = stock?.measured_on === today;
                    const predicted = forecast?.products
                      .find((item) => item.product_id === product.id)
                      ?.points.find((point) => point.date === nextDay)?.p50;
                    const available = fresh
                      ? stock.batches
                          .filter((batch) => batch.expires_on > today)
                          .reduce((sum, batch) => sum + batch.quantity, 0)
                      : null;
                    return (
                      <tr key={product.id}>
                        <td>
                          <span className="merchant-cell-title">
                            <span className="product-dot">
                              <Icon name="products" size={16} />
                            </span>
                            {product.name}
                          </span>
                          <span className="merchant-cell-sub">
                            {product.category}
                          </span>
                        </td>
                        <td className="number">
                          {predicted === undefined
                            ? "—"
                            : `${units(predicted)}개`}
                        </td>
                        <td className="number">
                          {available === null ? "미확인" : `${available}개`}
                        </td>
                        <td>
                          <span
                            className={`merchant-status ${fresh ? "ready" : "warning"}`}
                          >
                            {fresh ? "확인 완료" : "확인 필요"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="button table-button"
                            onClick={() => onInventory(product)}
                            aria-label={`${product.name} 재고 ${fresh ? "수정" : "입력"}`}
                          >
                            {fresh ? "수정" : "입력"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
            </div>
          ) : (
            <div className="merchant-empty">
              상품을 먼저 등록해주세요.
              <button
                className="text-button"
                onClick={() => onNavigate("products")}
              >
                상품 등록하기
              </button>
            </div>
          )}
        </section>
      </div>

      <aside className="merchant-rail" aria-label="매장 운영 요약">
        <section className="rail-greeting">
          <span className="rail-date">{todayLabel}</span>
          <h2>
            {user.name.endsWith("님") ? user.name : `${user.name}님`},
            <br />
            오늘도 응원해요.
          </h2>
          <p>
            {store.name} · {store.city}
          </p>
        </section>
        <section className="rail-weather">
          <h2 className="rail-section-title">
            {store.city} 날씨{" "}
            <span
              className={`merchant-status ${weatherCurrent ? "ready" : "warning"}`}
            >
              {weatherCurrent ? "현재 예보" : "예보 확인 필요"}
            </span>
          </h2>
          {firstWeather ? (
            <>
              <div className="rail-weather-main">
                <Icon name={weatherIcon(firstWeather.code)} size={44} />
                <div>
                  <strong>
                    {firstWeather.temp_max === null
                      ? "—"
                      : `${Math.round(firstWeather.temp_max)}°`}
                    <small>
                      {" "}
                      /{" "}
                      {firstWeather.temp_min === null
                        ? "—"
                        : `${Math.round(firstWeather.temp_min)}°`}
                    </small>
                  </strong>
                  <span>{shortDate(firstWeather.date)} 최고 / 최저</span>
                </div>
              </div>
              <dl className="rail-weather-details">
                <div>
                  <dt>강수 확률</dt>
                  <dd>
                    {firstWeather.rain_probability === null
                      ? "—"
                      : `${firstWeather.rain_probability}%`}
                  </dd>
                </div>
                <div>
                  <dt>예상 강수량</dt>
                  <dd>
                    {firstWeather.rain_mm === null
                      ? "—"
                      : `${firstWeather.rain_mm} mm`}
                  </dd>
                </div>
              </dl>
              <div className="rail-weather-week">
                {forecast?.weather.days.map((day) => (
                  <div className="rail-weather-day" key={day.date}>
                    <time dateTime={day.date}>
                      {shortDate(day.date)}
                      <span className="weather-weekday">
                        {new Date(`${day.date}T12:00:00Z`).toLocaleDateString(
                          "ko-KR",
                          { weekday: "short", timeZone: "UTC" },
                        )}
                      </span>
                    </time>
                    <Icon name={weatherIcon(day.code)} size={18} />
                    <strong>
                      {day.temp_max === null
                        ? "—"
                        : `${Math.round(day.temp_max)}°`}
                      <small>
                        {" "}
                        /{" "}
                        {day.temp_min === null
                          ? "—"
                          : `${Math.round(day.temp_min)}°`}
                      </small>
                    </strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="merchant-empty">지금은 날씨를 불러올 수 없어요.</p>
          )}
          {forecast && <WeatherSource weather={forecast.weather} />}
        </section>
        <section className="rail-tasks">
          <h2 className="rail-section-title">
            오늘 확인할 일 <Icon name="check" size={17} />
          </h2>
          <div className="rail-task-list">
            <button onClick={() => onNavigate("inventory")}>
              <span className="task-symbol">
                <Icon name="inventory" size={18} />
              </span>
              <span className="task-copy">
                <strong>재고 확인</strong>
                <small>남은 개수와 입고 예정</small>
              </span>
              <span className="task-count">{missing}개</span>
              <Icon name="arrow" size={14} />
            </button>
            <button onClick={() => onNavigate("sales")}>
              <span className="task-symbol">
                <Icon name="sales" size={18} />
              </span>
              <span className="task-copy">
                <strong>판매 기록</strong>
                <small>
                  {sales.summary.last_date
                    ? `최근 ${shortDate(sales.summary.last_date)} 입력`
                    : "첫 기록을 올려주세요"}
                </small>
              </span>
              <Icon name="arrow" size={14} />
            </button>
            <button onClick={() => onNavigate("orders")}>
              <span className="task-symbol">
                <Icon name="orders" size={18} />
              </span>
              <span className="task-copy">
                <strong>발주 초안 확인</strong>
                <small>수량을 보고 확정해요</small>
              </span>
              <span className="task-count">{drafts.length}건</span>
              <Icon name="arrow" size={14} />
            </button>
          </div>
        </section>
        <section className="rail-orders">
          <h2 className="rail-section-title">
            최근 발주 계획{" "}
            <button
              className="text-button"
              onClick={() => onNavigate("orders")}
              aria-label="모든 발주 계획 보기"
            >
              <Icon name="arrow" size={16} />
            </button>
          </h2>
          {orders.length ? (
            <div className="rail-order-list">
              {orders.slice(0, 3).map((order) => (
                <button
                  key={order.id}
                  onClick={() => onOrder(order)}
                  disabled={disabled}
                >
                  <span className="rail-order-meta">
                    <strong>
                      {shortDate(order.order_date ?? order.as_of)} 발주 계획
                    </strong>
                    <small>
                      {order.status === "confirmed" ? "확정" : "초안"}
                      {order.stale ? " · 이전 자료 기준" : ""} ·{" "}
                      {order.lines.length}개 상품
                    </small>
                  </span>
                  <span className="rail-order-amount">{won(order.total)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="merchant-empty">
              <Icon name="orders" size={28} />
              <p>추천 수량으로 첫 발주 계획을 만들어보세요.</p>
              <button
                className="text-button"
                onClick={() => onNavigate("orders")}
              >
                발주 계획 만들기 <Icon name="arrow" size={14} />
              </button>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

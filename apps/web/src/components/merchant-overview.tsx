"use client";

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
}: Props) {
  const ready =
    forecast?.products.filter((item) => item.status === "ready") ?? [];
  const checked = products.filter(
    (product) => inventory[product.id]?.measured_on === today,
  ).length;
  const missing = products.length - checked;
  const drafts = orders.filter((order) => order.status === "draft");
  const nextDay = forecast?.dates[0];
  const nextDemand = ready.reduce(
    (sum, item) =>
      sum + (item.points.find((point) => point.date === nextDay)?.p50 ?? 0),
    0,
  );
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

  return (
    <div className="merchant-overview">
      <div className="merchant-content">
        <div className="merchant-intro">
          <div>
            <h2>오늘의 장사, 차근차근 준비해요</h2>
            <p>판매 흐름을 살피고 필요한 만큼 발주하세요.</p>
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

        <div className="merchant-actions">
          <button
            className="action-card featured"
            onClick={() => onNavigate("inventory")}
          >
            <span className="action-icon">
              <Icon name="inventory" size={25} />
            </span>
            <span className="merchant-status warning">
              {missing > 0 ? `${missing}개 상품 확인 필요` : "오늘의 재고 확인"}
            </span>
            <strong>남은 재고부터 확인해요</strong>
            <p>입력한 재고를 반영해 추가 발주량을 계산해요.</p>
            <span className="action-link">
              재고 확인하기 <Icon name="arrow" size={15} />
            </span>
          </button>
          <button className="action-card" onClick={() => onNavigate("sales")}>
            <span className="action-icon">
              <Icon name="sales" size={25} />
            </span>
            <span className="merchant-status muted">
              CSV · 엑셀 · 직접 입력
            </span>
            <strong>판매 기록을 모아보세요</strong>
            <p>날짜별 판매 개수가 예측의 시작이 돼요.</p>
            <span className="action-link">
              판매 기록 입력 <Icon name="arrow" size={15} />
            </span>
          </button>
          <button className="action-card" onClick={() => onNavigate("orders")}>
            <span className="action-icon">
              <Icon name="orders" size={25} />
            </span>
            <span className="merchant-status muted">
              {drafts.length
                ? `저장한 초안 ${drafts.length}건`
                : "수정부터 내보내기까지"}
            </span>
            <strong>발주 준비를 한곳에서</strong>
            <p>수량을 조정하고 발주서 파일로 정리해요.</p>
            <span className="action-link">
              발주 계획 보기 <Icon name="arrow" size={15} />
            </span>
          </button>
        </div>

        <div className="merchant-metrics">
          <article className="metric-card">
            <span className="metric-label">
              {nextDay ? shortDate(nextDay) : "내일"} 예상 판매량{" "}
              <Icon name="forecast" size={17} />
            </span>
            <strong>
              {ready.length ? units(nextDemand) : "—"}
              <small>개</small>
            </strong>
            <p>예측 가능한 상품의 예상 판매 합계</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">
              예측 준비 상품 <Icon name="products" size={17} />
            </span>
            <strong>
              {ready.length}
              <small> / {products.length}개</small>
            </strong>
            <p>앞으로 7일 예측 제공</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">
              재고 확인 필요 <Icon name="inventory" size={17} />
            </span>
            <strong>
              {missing}
              <small>개</small>
            </strong>
            <p>미입력 또는 오늘 확인 전</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">
              저장된 발주 초안 <Icon name="orders" size={17} />
            </span>
            <strong>
              {drafts.length}
              <small>건</small>
            </strong>
            <p>확정 전 수량을 확인하세요</p>
          </article>
        </div>

        <div className="merchant-chart-row">
          <section className="merchant-card merchant-forecast">
            <div className="merchant-card-heading">
              <div>
                <h2>상품별 7일 판매 예측</h2>
                <p>얼마나 준비하면 좋을까요?</p>
              </div>
              <select
                aria-label="홈 예측 상품 선택"
                value={selectedForecast?.product_id ?? ""}
                onChange={(event) => onSelectProduct(event.target.value)}
              >
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </div>
            {selectedForecast ? (
              <ForecastChart forecast={selectedForecast} />
            ) : (
              <Empty
                title={
                  products.length
                    ? "예측 결과를 기다리고 있어요"
                    : "등록된 상품이 없어요"
                }
              >
                {products.length
                  ? "모델 연결과 판매 기록을 확인해주세요."
                  : "상품을 등록하면 예측을 시작할 수 있어요."}
              </Empty>
            )}
            <div className="merchant-card-footer">
              <span>
                {forecast
                  ? forecast.model.uses_weather
                    ? "날씨 반영 판매 예측"
                    : "요일별 판매 예측"
                  : "아직 예측이 완료되지 않았어요"}
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
                <h2>오늘 재고 확인 현황</h2>
                <p>입력한 상품부터 발주 준비</p>
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
                오늘 확인한 상품 <strong>{checked}개</strong>
              </span>
              <span>
                확인할 상품 <strong>{missing}개</strong>
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
              <p>판매 예측과 실제 발주량은 달라요. 재고를 먼저 확인해주세요.</p>
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
              <table>
                <thead>
                  <tr>
                    <th>상품</th>
                    <th className="number">
                      {nextDay ? shortDate(nextDay) : "내일"} 예상 판매
                    </th>
                    <th className="number">내일 판매 가능한 재고</th>
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
                            {fresh ? "재고 확인 완료" : "재고 확인 필요"}
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
              </table>
            </div>
          ) : (
            <div className="merchant-empty">
              등록된 상품이 없어요.
              <button
                className="text-button"
                onClick={() => onNavigate("products")}
              >
                상품 관리로 이동
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
                    <span>{shortDate(day.date)}</span>
                    <Icon name={weatherIcon(day.code)} size={18} />
                    <strong>
                      {day.temp_max === null
                        ? "—"
                        : `${Math.round(day.temp_max)}°`}
                    </strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="merchant-empty">지금은 날씨를 불러올 수 없어요.</p>
          )}
          {forecast && (
            <p className="rail-note">
              {forecast.weather.source} ·{" "}
              {new Intl.DateTimeFormat("ko-KR", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Asia/Seoul",
              }).format(new Date(forecast.weather.fetched_at))}{" "}
              한국 시간 조회{forecast.weather.cached ? " · 저장된 자료" : ""}
              {forecast.weather.message ? ` · ${forecast.weather.message}` : ""}
              {forecast.model.uses_weather
                ? " · 판매 예측에 사용"
                : " · 참고용 날씨"}
            </p>
          )}
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
                <small>남은 수량과 입고 예정</small>
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
                    : "첫 기록을 입력해주세요"}
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
                <small>수량 확인 후 점주 확정</small>
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
                <button key={order.id} onClick={() => onNavigate("orders")}>
                  <span className="rail-order-meta">
                    <strong>{shortDate(order.as_of)} 발주 계획</strong>
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
              <p>아직 저장한 발주 계획이 없어요.</p>
              <button
                className="text-button"
                onClick={() => onNavigate("orders")}
              >
                첫 발주 준비하기 <Icon name="arrow" size={14} />
              </button>
            </div>
          )}
        </section>
        <details className="rail-model">
          <summary className="rail-section-title">
            예측 방식·데이터 안내
          </summary>
          <p className="rail-note">
            {forecast
              ? `현재 ${forecast.model.name} 모델로 예측해요. `
              : "판매 예측이 아직 완료되지 않았어요. "}
            {forecast?.model.uses_weather
              ? "판매 기록과 날씨를 함께 사용해요."
              : forecast
                ? "날씨는 예측에 반영하지 않고 참고 정보로 제공해요."
                : "예측 화면에서 연결 상태를 확인해주세요."}{" "}
            {forecast?.model.training_data === "synthetic"
              ? "합성 자료로 학습한 실험 모델이에요. "
              : ""}
            예측 범위는 정확도 보장이 아니에요.
            {store.provenance}
          </p>
          <button
            className="text-button rail-link"
            onClick={() => onNavigate("forecast")}
          >
            예측 범위 자세히 보기 <Icon name="arrow" size={14} />
          </button>
        </details>
      </aside>
    </div>
  );
}

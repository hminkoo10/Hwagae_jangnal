"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shortDate, units, type ProductForecast } from "@/lib/api";

const paths: Record<string, ReactNode> = {
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 11h18m-13 4h1m6 0h1" />
    </>
  ),
  "ai-settings": (
    <>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  store: (
    <>
      <path d="M3 10h18l-2-6H5l-2 6Zm1 0v10h16V10M9 20v-6h6v6M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0" />
    </>
  ),
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  forecast: (
    <>
      <path d="M4 4v16h17M7 14l4-5 4 3 5-7" />
      <path d="M17 5h3v3" />
    </>
  ),
  sales: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h3M14 16l2 2 4-4" />
    </>
  ),
  inventory: (
    <>
      <path d="m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M7 5l9 4" />
    </>
  ),
  products: (
    <>
      <path d="M20 13 11 4H4v7l9 9a2 2 0 0 0 3 0l4-4a2 2 0 0 0 0-3Z" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  orders: (
    <>
      <path d="M7 6H4l-1-3M5 6l2 10h12l2-10H5" />
      <circle cx="9" cy="20" r="1" />
      <circle cx="18" cy="20" r="1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  rain: (
    <>
      <path d="M6 14a4 4 0 0 1-1-8 6 6 0 0 1 11-1 4 4 0 0 1 2 8M8 17l-1 3M13 17l-1 3M18 17l-1 3" />
    </>
  ),
  snow: (
    <>
      <path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4M17 19l-1-4 4-1M4 14l4 1-1 4M17 5l-1 4 4 1" />
    </>
  ),
  cloud: <path d="M6 17a5 5 0 0 1-1-10 6 6 0 0 1 11-1 5 5 0 1 1 2 11H6Z" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  refresh: (
    <>
      <path d="M20 10a8 8 0 0 0-14-4L3 9m0-5v5h5M4 14a8 8 0 0 0 14 4l3-3m0 5v-5h-5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.store}
    </svg>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="panel-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="닫기"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name="inventory" size={30} />
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function ForecastChart({ forecast }: { forecast: ProductForecast }) {
  if (!forecast.points.length)
    return <Empty title="예측 준비가 필요해요">{forecast.reason}</Empty>;
  const points = forecast.points;
  const max =
    Math.max(
      ...points.map((point) => Math.max(point.p90, point.actual ?? 0)),
      1,
    ) * 1.2;
  const x = (index: number) => 44 + index * 96;
  const y = (value: number) => 190 - (value / max) * 152;
  const path = (key: "p10" | "p50" | "p90") =>
    points
      .map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`)
      .join(" ");
  const band =
    path("p90") +
    [...points]
      .reverse()
      .map(
        (point, index) => ` L${x(points.length - 1 - index)},${y(point.p10)}`,
      )
      .join("") +
    " Z";
  const actual = points.filter((point) => point.actual !== null);
  return (
    <div className="chart-wrap">
      <p className="chart-scroll-hint">좌우로 밀어 7일 예측을 확인하세요.</p>
      <div
        className="chart-scroll"
        tabIndex={0}
        role="region"
        aria-label="7일 판매 예측 그래프"
      >
        <svg
          className="forecast-chart"
          viewBox="0 0 664 232"
          role="img"
          aria-label={`${forecast.name} 7일 예측 중앙값과 범위입니다. 7일 판매 예측 메뉴에서 수량 표를 확인할 수 있습니다.`}
        >
          {[0, 1, 2, 3].map((level) => (
            <g key={level}>
              <line
                x1="44"
                x2="640"
                y1={y((max * level) / 3)}
                y2={y((max * level) / 3)}
                stroke="#e9eeec"
                strokeDasharray="4 5"
              />
              <text
                x="32"
                y={y((max * level) / 3) + 4}
                textAnchor="end"
                className="chart-text"
              >
                {Math.round((max * level) / 3)}
              </text>
            </g>
          ))}
          <path d={band} fill="var(--chart-band, #e0f4ee)" />
          <path
            d={path("p50")}
            stroke="var(--chart-line, #18836b)"
            strokeWidth="3"
            fill="none"
          />
          {points.map((point, index) => (
            <g key={point.date}>
              <circle
                cx={x(index)}
                cy={y(point.p50)}
                r="4"
                fill="#fff"
                stroke="var(--chart-line, #18836b)"
                strokeWidth="2.5"
              />
              <text
                x={x(index)}
                y="219"
                textAnchor="middle"
                className="chart-text"
              >
                {shortDate(point.date)}
              </text>
            </g>
          ))}
          {actual.map((point) => (
            <circle
              key={point.date}
              cx={x(points.indexOf(point))}
              cy={y(point.actual!)}
              r="4"
              fill="var(--chart-actual, #8d78b8)"
            >
              <title>실제 판매 {units(point.actual!)}개</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          예측 중앙값
        </span>
        <span>
          <i className="legend-band" />
          P10~P90 범위
        </span>
        {actual.length > 0 && (
          <span>
            <i className="legend-actual" />
            실제 판매
          </span>
        )}
      </div>
    </div>
  );
}

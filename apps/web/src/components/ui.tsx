"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { shortDate, units, type ProductForecast } from "@/lib/api";
import { forecastHelp } from "@/lib/merchant-language";

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
  staff: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4A6 6 0 0 1 21 20" />
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
  "chevron-down": <path d="m6 9 6 6 6-6" />,
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

/** 닫는 애니메이션(motion.css)과 같은 길이 */
export const EXIT_MS = 270;

/**
 * 값이 비워진 뒤에도 잠깐 마지막 값을 남겨 닫히는 애니메이션을 보여준다.
 * 돌려주는 leaving이 true인 동안 요소에 닫힘 클래스를 붙이면 된다.
 */
export function usePresence<T>(value: T, duration = EXIT_MS) {
  const [kept, setKept] = useState(value);
  if (value && !Object.is(value, kept)) setKept(value);
  const leaving = !value && !!kept;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setKept(value), duration);
    return () => window.clearTimeout(timer);
  }, [leaving, value, duration]);
  return [leaving ? kept : value, leaving] as const;
}

/**
 * 서버 렌더에서는 처음부터 최종 값을 보여준다.
 * 화면 읽기 프로그램은 최종 값만 읽고, 자리는 최종 값 너비로 고정해 글자가 밀리지 않는다.
 */
export function CountUp({
  value,
  duration = 900,
  svg = false,
}: {
  value: number;
  duration?: number;
  /** SVG <text> 안에서는 글자만 그린다. */
  svg?: boolean;
}) {
  const [shown, setShown] = useState(value);
  const current = useRef<number | null>(null);
  useLayoutEffect(() => {
    const from = current.current ?? 0;
    current.current = from;
    if (from === value || !Number.isFinite(value)) {
      current.current = value;
      setShown(value);
      return;
    }
    setShown(from);
    const start = performance.now();
    let frame = window.requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const next = from + (value - from) * (1 - (1 - progress) ** 3);
      current.current = next;
      setShown(next);
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [value, duration]);
  const format = (n: number) =>
    Number.isFinite(n) ? Math.round(n).toLocaleString("ko-KR") : String(n);
  if (svg) return <>{format(shown)}</>;
  return (
    <span className="count-up">
      <span className="count-up-final">{format(value)}</span>
      <span className="count-up-value" aria-hidden="true">
        {format(shown)}
      </span>
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
  closing,
  anchor,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /**
   * 부모가 usePresence로 닫힘을 직접 관리할 때 넘긴다. 이때 닫기 버튼·바깥 누르기·Esc는
   * onClose를 바로 부르고, 이 값이 true인 동안 닫히는 애니메이션을 보여준다.
   * 넘기지 않으면 모달이 스스로 짧게 닫히는 애니메이션을 보여준 뒤 onClose를 부른다.
   */
  closing?: boolean;
  /** 이 요소(예: 선택 버튼) 쪽에서 커지며 열린다. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    // 처음 열릴 때 한 번만, 누른 버튼 위치를 확대 기준점으로 잡는다.
    const from = anchor?.current;
    if (dialog && from) {
      // offset 값은 열리는 애니메이션의 scale 영향을 받지 않는다.
      const rect = from.getBoundingClientRect();
      dialog.style.transformOrigin = `${Math.round(rect.left + rect.width / 2 - dialog.offsetLeft)}px ${Math.round(rect.top + rect.height / 2 - dialog.offsetTop)}px`;
    }
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  function dismiss() {
    if (closing !== undefined) {
      onClose();
      return;
    }
    if (leaving) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      // 부모가 닫지 않으면(예: 저장 중) 다시 보이게 되돌린다.
      setLeaving(false);
      latestClose.current();
    }, EXIT_MS);
  }
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={ref}
      className={`modal${anchor ? " modal-anchored" : ""}${closing || leaving ? " modal-closing" : ""}`}
      aria-label={title}
      onPointerDown={(event) => {
        outsidePress.current = event.target === event.currentTarget && outsideDialog(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (outsidePress.current && event.target === event.currentTarget && outsideDialog(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)) dismiss();
        outsidePress.current = false;
      }}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="panel-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="닫기"
          onClick={dismiss}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function outsideDialog(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">, x: number, y: number) {
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
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

export function ForecastChart({
  forecast,
  onHistory,
}: {
  forecast: ProductForecast;
  onHistory?: () => void;
}) {
  if (!forecast.points.length)
    return (
      <Empty title={forecastHelp(forecast.reason).title}>
        <p>{forecastHelp(forecast.reason).description}</p>
        {onHistory && (
          <button
            type="button"
            className="button secondary forecast-next-step"
            onClick={onHistory}
          >
            {forecastHelp(forecast.reason).action}
          </button>
        )}
      </Empty>
    );
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
  const order = (index: number) => ({ "--i": index }) as CSSProperties;
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
          key={`${forecast.product_id}:${points[0].date}`}
          className="forecast-chart"
          viewBox="0 0 664 232"
          role="img"
          aria-label={`${forecast.name}의 7일 예상 판매량과 예상 범위(P10~P90)예요. 날짜별 수량은 7일 판매 예측 메뉴의 표에서 확인할 수 있어요.`}
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
          <path
            className="forecast-band"
            d={band}
            fill="var(--chart-band, #e0f4ee)"
          />
          <path
            className="forecast-line"
            d={path("p50")}
            pathLength={1}
            stroke="var(--chart-line, #18836b)"
            strokeWidth="3"
            fill="none"
          />
          {points.map((point, index) => (
            <g key={point.date}>
              <circle
                className="forecast-point"
                style={order(index)}
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
              className="forecast-point"
              style={order(points.indexOf(point))}
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
          예상 판매량
        </span>
        <span>
          <i className="legend-band" />
          예상 범위 (P10~P90)
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

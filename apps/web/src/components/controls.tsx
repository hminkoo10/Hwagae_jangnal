"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TableHTMLAttributes,
} from "react";
import { Modal, Icon } from "./ui";
import { searchKey } from "@/lib/merchant-language";

type Change = { target: { value: string } };
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) =>
      isValidElement<{ children?: ReactNode }>(n)
        ? text(n.props.children)
        : typeof n === "string" || typeof n === "number"
          ? String(n)
          : "",
    )
    .join("");
}
function options(
  node: ReactNode,
): { value: string; label: string; disabled: boolean }[] {
  return Children.toArray(node).flatMap((n) => {
    if (
      !isValidElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }>(n)
    )
      return [];
    return n.type === "option"
      ? [
          {
            value: String(n.props.value ?? text(n.props.children)),
            label: text(n.props.children),
            disabled: !!n.props.disabled,
          },
        ]
      : options(n.props.children);
  });
}

export function Select({
  children,
  value,
  defaultValue,
  onChange,
  name,
  required,
  disabled,
  className = "",
  ...rest
}: Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "onChange" | "multiple" | "size" | "value" | "defaultValue"
> & {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: Change) => void;
}) {
  const items = options(children);
  const [local, setLocal] = useState(
    String(defaultValue ?? items[0]?.value ?? ""),
  );
  const selected = String(
    value ??
      (items.some((i) => i.value === local)
        ? local
        : (defaultValue ?? items[0]?.value ?? "")),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const filtered = items.filter((i) =>
    searchKey(i.label).includes(searchKey(query)),
  );
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  const label = rest["aria-label"] ?? "항목 선택";
  return (
    <span className={`custom-control ${className}`}>
      <button
        type="button"
        ref={trigger}
        id={rest.id}
        className="control-trigger"
        disabled={disabled || !items.length}
        aria-label={rest["aria-label"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          {items.find((i) => i.value === selected)?.label ?? "선택하세요"}
        </span>
        <Icon name="chevron-down" size={18} />
      </button>
      <input
        className="control-validation"
        name={name}
        value={selected}
        onChange={() => {}}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onInvalid={(e) => {
          e.preventDefault();
          trigger.current?.focus();
        }}
      />
      {open && (
        <Modal title={label} onClose={close}>
          {items.length > 7 && (
            <input
              aria-label="항목 검색"
              placeholder="이름으로 찾기"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          )}
          <div
            id={id}
            className="choice-list"
            role="listbox"
            aria-label={label}
            onKeyDown={(e) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
                return;
              const buttons = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? buttons.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          buttons.length - 1,
                          index + (e.key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              e.preventDefault();
              buttons[next]?.focus();
            }}
          >
            {filtered.map((i) => (
              <button
                type="button"
                role="option"
                aria-selected={selected === i.value}
                key={i.value}
                disabled={i.disabled}
                autoFocus={items.length <= 7 && selected === i.value}
                onClick={() => {
                  setLocal(i.value);
                  onChange?.({ target: { value: i.value } });
                  close();
                }}
              >
                <span>{i.label}</span>
                {selected === i.value && <Icon name="check" size={18} />}
              </button>
            ))}
            {!filtered.length && (
              <p className="helper">일치하는 항목이 없어요.</p>
            )}
          </div>
        </Modal>
      )}
    </span>
  );
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date();
export function DateField({
  value,
  defaultValue,
  onChange,
  name,
  min,
  max,
  required,
  disabled,
  className = "",
  ...rest
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "value" | "defaultValue" | "min" | "max"
> & {
  value?: string;
  defaultValue?: string;
  min?: string;
  max?: string;
  onChange?: (event: Change) => void;
}) {
  const [local, setLocal] = useState(defaultValue ?? "");
  const selected = value ?? local;
  const [month, setMonth] = useState(() => parse(selected));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = rest["aria-label"] ?? "날짜 선택";
  function choose(next: string) {
    setLocal(next);
    onChange?.({ target: { value: next } });
    setOpen(false);
    trigger.current?.focus();
  }
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
  return (
    <span className={`custom-control date-control ${className}`}>
      <button
        ref={trigger}
        id={rest.id}
        type="button"
        className="control-trigger"
        disabled={disabled}
        aria-label={rest["aria-label"]}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setMonth(parse(selected || min || iso(new Date())));
          setOpen(true);
        }}
      >
        <span>{selected ? selected.replaceAll("-", ". ") : "날짜 선택"}</span>
        <Icon name="calendar" size={18} />
      </button>
      <input
        className="control-validation"
        name={name}
        value={selected}
        onChange={() => {}}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onInvalid={(e) => {
          e.preventDefault();
          trigger.current?.focus();
        }}
      />
      {open && (
        <Modal
          title={label}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <div className="calendar-heading">
            <button
              className="button secondary small"
              type="button"
              aria-label="이전 달"
              onClick={() =>
                setMonth(
                  new Date(month.getFullYear(), month.getMonth() - 1, 1, 12),
                )
              }
            >
              ‹
            </button>
            <label className="calendar-year">
              <input
                key={month.getFullYear()}
                aria-label="연도"
                type="number"
                min="1900"
                max="2200"
                defaultValue={month.getFullYear()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  const y = Number(e.target.value);
                  if (y >= 1900 && y <= 2200)
                    setMonth(new Date(y, month.getMonth(), 1, 12));
                  else e.target.value = String(month.getFullYear());
                }}
              />
              년 {month.getMonth() + 1}월
            </label>
            <button
              className="button secondary small"
              type="button"
              aria-label="다음 달"
              onClick={() =>
                setMonth(
                  new Date(month.getFullYear(), month.getMonth() + 1, 1, 12),
                )
              }
            >
              ›
            </button>
          </div>
          <div className="calendar-week" aria-hidden="true">
            {"일월화수목금토".split("").map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div
            className="calendar-days"
            aria-label="날짜"
            onKeyDown={(e) => {
              const offset = (
                {
                  ArrowLeft: -1,
                  ArrowRight: 1,
                  ArrowUp: -7,
                  ArrowDown: 7,
                } as Record<string, number>
              )[e.key];
              if (!offset) return;
              const buttons = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next = buttons[index + offset];
              if (next && !next.disabled) {
                e.preventDefault();
                next.focus();
              }
            }}
          >
            {days.map((day) => {
              const date = iso(day);
              return (
                <button
                  type="button"
                  key={date}
                  className={`${day.getMonth() !== month.getMonth() ? "other-month" : ""} ${date === selected ? "selected" : ""}`}
                  aria-label={`${date} ${"일월화수목금토"[day.getDay()]}요일`}
                  aria-pressed={date === selected}
                  disabled={!!((min && date < min) || (max && date > max))}
                  autoFocus={date === (selected || iso(first))}
                  onClick={() => choose(date)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          <div className="split-actions">
            <button
              type="button"
              className="button secondary"
              disabled={
                !!(
                  (min && iso(new Date()) < min) ||
                  (max && iso(new Date()) > max)
                )
              }
              onClick={() => choose(iso(new Date()))}
            >
              오늘
            </button>
            {!required && (
              <button
                type="button"
                className="text-button"
                onClick={() => choose("")}
              >
                선택 지우기
              </button>
            )}
          </div>
        </Modal>
      )}
    </span>
  );
}

export function ResponsiveTable({
  children,
  className = "",
  ...rest
}: TableHTMLAttributes<HTMLTableElement>) {
  const headers: string[] = [];
  function collect(node: ReactNode) {
    Children.forEach(node, (n) => {
      if (isValidElement<{ children?: ReactNode }>(n)) {
        if (n.type === "th") headers.push(text(n.props.children));
        else collect(n.props.children);
      }
    });
  }
  collect(children);
  function visit(node: ReactNode): ReactNode {
    return Children.map(node, (n) => {
      if (!isValidElement<{ children?: ReactNode }>(n)) return n;
      if (n.type === "tr") {
        let index = 0;
        return cloneElement(
          n,
          {},
          Children.map(n.props.children, (c) =>
            isValidElement<{ colSpan?: number }>(c) && c.type === "td"
              ? cloneElement(c, {
                  "data-label": headers[index++],
                  "data-wide": (c.props.colSpan ?? 1) > 1,
                } as object)
              : c,
          ),
        );
      }
      return n.props.children
        ? cloneElement(n, {}, visit(n.props.children))
        : n;
    });
  }
  return (
    <table {...rest} className={`responsive-table ${className}`}>
      {visit(children)}
    </table>
  );
}

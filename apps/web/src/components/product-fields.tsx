"use client";
import { useId, useState } from "react";
import { adjustPrice, categoryOptions } from "@/lib/merchant-language";
import { Select } from "./controls";

export function ProductCategoryField({
  value,
  disabled,
}: {
  value?: string;
  disabled?: boolean;
}) {
  return (
    <label>
      상품 종류
      <Select
        name="category"
        aria-label="상품 종류"
        defaultValue={value ?? ""}
        required
        disabled={disabled}
      >
        <option value="" disabled>
          종류를 선택해주세요
        </option>
        {categoryOptions(value ? [{ category: value }] : []).map((category) => (
          <option key={category} value={category}>
            {category}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function PriceField({
  name,
  label,
  defaultValue,
  disabled,
}: {
  name: string;
  label: string;
  defaultValue?: number;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(
    defaultValue === undefined ? "" : String(defaultValue),
  );
  const id = useId(),
    hint = useId();
  function step(direction: 1 | -1) {
    setValue((current) => adjustPrice(current, direction));
  }
  return (
    <div className="price-field">
      <label htmlFor={id}>{label}</label>
      <div className="price-control">
        <button
          type="button"
          disabled={disabled || value === "" || Number(value) <= 0}
          aria-label={`${label} 100원 내리기`}
          onClick={() => step(-1)}
        >
          −
        </button>
        <div className="price-value">
          <input
            id={id}
            name={name}
            type="number"
            inputMode="numeric"
            min="0"
            max="1000000"
            step="1"
            required
            disabled={disabled}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                step(e.key === "ArrowUp" ? 1 : -1);
              }
            }}
            aria-describedby={hint}
            placeholder="0"
          />
          <span aria-hidden="true">원</span>
        </div>
        <button
          type="button"
          disabled={disabled || Number(value) >= 1000000}
          aria-label={`${label} 100원 올리기`}
          onClick={() => step(1)}
        >
          +
        </button>
      </div>
      <small id={hint}>
        {value !== "" && Number.isFinite(Number(value))
          ? `${Number(value).toLocaleString("ko-KR")}원 · `
          : ""}
        버튼은 100원씩, 직접 입력은 1원까지
      </small>
    </div>
  );
}

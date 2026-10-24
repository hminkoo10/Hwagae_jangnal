"use client";
import { Fragment, useId, useState } from "react";

export type MerchantStore = {
  id: string;
  name: string;
  city: string;
  last_sales_date: string | null;
  product_count: number;
};
export type Contract = {
  id: string;
  email: string;
  merchant_name: string;
  starts_on: string;
  ends_on: string;
  status: "active" | "suspended";
  enabled: boolean;
  user_id: string | null;
  access_status: string;
  stores: MerchantStore[];
};
export type ExistingMerchant = {
  id: string;
  name: string;
  email: string;
  stores?: MerchantStore[];
};
export type MerchantRow = {
  id: string;
  name: string;
  email: string;
  accessStatus: string;
  stores: MerchantStore[];
  lastSales: string | null;
  contract: Contract | null;
  existing: ExistingMerchant | null;
};
export const merchantStatuses: Record<string, string> = {
  active: "이용 중",
  invited: "가입 대기",
  scheduled: "계약 시작 전",
  expired: "계약 만료",
  suspended: "이용 중지",
  unlinked: "계약 미연결",
};

export function selectMerchantRows(
  contracts: Contract[],
  existing: ExistingMerchant[],
  query: string,
  status: string,
  sort: string,
): MerchantRow[] {
  const rows: MerchantRow[] = [
    ...contracts.map((c) => ({
      id: `contract-${c.id}`,
      name: c.merchant_name,
      email: c.email,
      accessStatus: c.access_status,
      stores: c.stores,
      contract: c,
      existing: null,
      lastSales: null,
    })),
    ...existing.map((m) => ({
      id: `merchant-${m.id}`,
      name: m.name,
      email: m.email,
      accessStatus: "unlinked",
      stores: m.stores ?? [],
      contract: null,
      existing: m,
      lastSales: null,
    })),
  ];
  for (const row of rows)
    row.lastSales =
      row.stores
        .map((s) => s.last_sales_date)
        .filter((s): s is string => !!s)
        .sort()
        .at(-1) ?? null;
  const normalized = query.trim().toLocaleLowerCase();
  return rows
    .filter(
      (row) =>
        (status === "all" || row.accessStatus === status) &&
        `${row.name} ${row.email} ${row.stores.map((s) => `${s.name} ${s.city}`).join(" ")}`
          .toLocaleLowerCase()
          .includes(normalized),
    )
    .sort((a, b) => {
      if (sort === "expiry") {
        const result = (a.contract?.ends_on ?? "9999-12-31").localeCompare(
          b.contract?.ends_on ?? "9999-12-31",
        );
        if (result) return result;
      }
      if (sort === "sales") {
        const result = (b.lastSales ?? "").localeCompare(a.lastSales ?? "");
        if (result) return result;
      }
      return (
        a.name.localeCompare(b.name, "ko-KR") || a.email.localeCompare(b.email)
      );
    });
}

function account(row: MerchantRow) {
  return row.contract && !row.contract.user_id
    ? "가입 전"
    : row.contract && !row.contract.enabled
      ? "사용 중지"
      : "사용 허용";
}

export function MerchantManagementTable({
  rows,
  busy,
  today,
  onManage,
  onInvite,
  onConnect,
}: {
  rows: MerchantRow[];
  busy: boolean;
  today: string;
  onManage: (contract: Contract) => void;
  onInvite: (contract: Contract) => void;
  onConnect: (merchant: ExistingMerchant) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const prefix = useId();
  const toggle = (id: string) =>
    setExpanded((current) => (current === id ? null : id));
  return (
    <div className="operator-table-wrap">
      <table className="operator-table">
        <caption className="visually-hidden">
          점주별 계약·계정·매장 관리 목록
        </caption>
        <thead>
          <tr>
            <th scope="col" className="merchant-name-col">
              점주
            </th>
            <th scope="col" className="merchant-period-col">
              계약 기간
            </th>
            <th scope="col" className="merchant-status-col">
              이용 상태
            </th>
            <th scope="col" className="merchant-account-col">
              계정
            </th>
            <th scope="col" className="merchant-store-col">
              매장
            </th>
            <th scope="col" className="merchant-sales-col">
              최근 판매 기록
            </th>
            <th scope="col" className="merchant-action-col">
              관리
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => {
              const open = expanded === row.id,
                detailId = `${prefix}-${row.id}`;
              return (
                <Fragment key={row.id}>
                  <tr
                    className={open ? "merchant-row expanded" : "merchant-row"}
                  >
                    <th scope="row" className="merchant-name-col">
                      <button
                        className="merchant-expand"
                        type="button"
                        aria-expanded={open}
                        aria-controls={open ? detailId : undefined}
                        aria-label={`${row.name} 상세 ${open ? "접기" : "보기"}`}
                        onClick={() => toggle(row.id)}
                      >
                        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                        <strong>{row.name}</strong>
                      </button>
                      <span className="merchant-email">{row.email}</span>
                    </th>
                    <td className="merchant-period-col">
                      {row.contract ? (
                        <>
                          <span>{row.contract.starts_on}</span>
                          <span className="muted">
                            ~ {row.contract.ends_on}
                          </span>
                        </>
                      ) : (
                        <span className="muted">계약 미등록</span>
                      )}
                    </td>
                    <td className="merchant-status-col">
                      <span
                        className={`pill ${row.accessStatus === "active" ? "mint" : row.accessStatus === "expired" || row.accessStatus === "suspended" ? "amber" : "neutral"}`}
                      >
                        {merchantStatuses[row.accessStatus] ?? "상태 확인"}
                      </span>
                    </td>
                    <td className="merchant-account-col">{account(row)}</td>
                    <td className="merchant-store-col">
                      <button
                        type="button"
                        className="merchant-store-count"
                        aria-label={`${row.name} 매장 ${row.stores.length}개 상세`}
                        aria-expanded={open}
                        aria-controls={open ? detailId : undefined}
                        onClick={() => toggle(row.id)}
                      >
                        {row.stores.length}개
                      </button>
                    </td>
                    <td className="merchant-sales-col">
                      {row.lastSales ?? "기록 없음"}
                    </td>
                    <td className="merchant-action-col">
                      <div className="operator-table-actions">
                        {row.contract ? (
                          <>
                            <button
                              className="button secondary small"
                              type="button"
                              disabled={busy}
                              aria-label={`${row.name} 계약·계정 관리`}
                              onClick={() => onManage(row.contract!)}
                            >
                              관리
                            </button>
                            {!row.contract.user_id && (
                              <button
                                className="text-button"
                                type="button"
                                disabled={
                                  busy ||
                                  row.contract.status !== "active" ||
                                  row.contract.ends_on < today
                                }
                                aria-label={`${row.name} 초대 링크 재발급`}
                                onClick={() => onInvite(row.contract!)}
                              >
                                초대 재발급
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={busy}
                            onClick={() => onConnect(row.existing!)}
                          >
                            계약 연결
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="merchant-detail-row">
                      <td colSpan={7}>
                        <section
                          id={detailId}
                          aria-label={`${row.name} 상세`}
                          className="merchant-detail"
                        >
                          <div className="merchant-detail-summary">
                            <div>
                              <span>계약 기간</span>
                              <strong>
                                {row.contract
                                  ? `${row.contract.starts_on} ~ ${row.contract.ends_on}`
                                  : "계약 미등록 · 기존 계정 이용 중"}
                              </strong>
                            </div>
                            <div>
                              <span>계정 상태</span>
                              <strong>{account(row)}</strong>
                            </div>
                            <div>
                              <span>최근 판매 기록</span>
                              <strong>{row.lastSales ?? "기록 없음"}</strong>
                            </div>
                          </div>
                          <h3>등록 매장 {row.stores.length}개</h3>
                          {row.stores.length ? (
                            <ul className="merchant-detail-stores">
                              {row.stores.map((s) => (
                                <li key={s.id}>
                                  <strong>{s.name}</strong>
                                  <span>{s.city}</span>
                                  <small>
                                    상품 {s.product_count}개 · 최근 판매{" "}
                                    {s.last_sales_date ?? "기록 없음"}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="helper">등록된 매장이 없어요.</p>
                          )}
                        </section>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          ) : (
            <tr>
              <td colSpan={7} className="merchant-table-empty">
                조건에 맞는 점주가 없어요. 검색어나 상태 필터를 확인하세요.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

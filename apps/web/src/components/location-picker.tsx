"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export type Location = {
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
};
type Candidate = {
  address: string;
  latitude: number;
  longitude: number;
  precision: string;
};
export function LocationPicker({
  token,
  onChange,
}: {
  token: string;
  onChange: (location: Location | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [location, setLocation] = useState<Location | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState({
    city: "",
    latitude: "",
    longitude: "",
    timezone: "Asia/Seoul",
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function search() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const data = await api<{ results: Candidate[] }>(
        `/locations/search?q=${encodeURIComponent(query.trim())}`,
        token,
        { signal: c.signal },
      );
      if (c.signal.aborted) return;
      setResults(data.results);
      if (!data.results.length)
        setError(
          "주소를 찾지 못했어요. 도로명·지역을 함께 입력하거나 좌표를 직접 입력하세요.",
        );
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : "위치 검색에 실패했어요.");
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  async function choose(item: Candidate) {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ timezone: string }>(
        `/locations/resolve?latitude=${item.latitude}&longitude=${item.longitude}`,
        token,
        { signal: c.signal },
      );
      if (c.signal.aborted) return;
      const next = {
        city: item.address.slice(0, 80),
        latitude: item.latitude,
        longitude: item.longitude,
        timezone: data.timezone,
      };
      setLocation(next);
      setDraft({
        ...next,
        latitude: String(next.latitude),
        longitude: String(next.longitude),
      });
      onChange(next);
      setResults([]);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : "시간대를 확인하지 못했어요.",
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  function edit(field: keyof Location, value: string) {
    const next = { ...draft, [field]: value };
    setDraft(next);
    const ready =
      next.city.trim() &&
      next.timezone.trim() &&
      next.latitude.trim() &&
      next.longitude.trim() &&
      Number.isFinite(Number(next.latitude)) &&
      Number.isFinite(Number(next.longitude));
    const resolved = ready
      ? {
          city: next.city,
          timezone: next.timezone,
          latitude: Number(next.latitude),
          longitude: Number(next.longitude),
        }
      : null;
    setLocation(resolved);
    onChange(resolved);
  }
  return (
    <div className="stack">
      <label>
        매장 주소·장소
        <input
          value={query}
          onChange={(e) => {
            controller.current?.abort();
            setBusy(false);
            setQuery(e.target.value);
            setResults([]);
            setLocation(null);
            setDraft({
              city: "",
              latitude: "",
              longitude: "",
              timezone: "Asia/Seoul",
            });
            onChange(null);
          }}
          placeholder="도로명 주소 또는 매장명과 지역"
          maxLength={150}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (query.trim().length >= 2) void search();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="button secondary"
        disabled={busy || query.trim().length < 2}
        onClick={() => void search()}
      >
        {busy ? "위치 확인 중…" : "주소로 위치 찾기"}
      </button>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <ul className="location-results">
        {results.map((item, i) => (
          <li key={i}>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void choose(item)}
            >
              <span>
                {item.address}
                <small>{item.precision}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {location && (
        <div className="location-selected">
          <strong>{location.city}</strong>
          <p className="helper">
            위도 {location.latitude.toFixed(6)} · 경도{" "}
            {location.longitude.toFixed(6)}
            <br />
            {location.timezone}
          </p>
          <a
            href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=18/${location.latitude}/${location.longitude}`}
            target="_blank"
            rel="noreferrer"
          >
            지도에서 매장 위치 확인
          </a>
        </div>
      )}
      <button
        className="text-button"
        type="button"
        onClick={() => setManual(!manual)}
      >
        {manual ? "직접 입력 닫기" : "좌표·시간대 직접 입력"}
      </button>
      {manual && (
        <div className="form-grid">
          <label>
            지역·주소
            <input
              required
              value={draft.city}
              maxLength={80}
              onChange={(e) => edit("city", e.target.value)}
            />
          </label>
          <label>
            시간대
            <input
              required
              value={draft.timezone}
              onChange={(e) => edit("timezone", e.target.value)}
            />
          </label>
          <label>
            위도
            <input
              required
              type="number"
              step="any"
              min="-90"
              max="90"
              value={draft.latitude}
              onChange={(e) => edit("latitude", e.target.value)}
            />
          </label>
          <label>
            경도
            <input
              required
              type="number"
              step="any"
              min="-180"
              max="180"
              value={draft.longitude}
              onChange={(e) => edit("longitude", e.target.value)}
            />
          </label>
        </div>
      )}
      <p className="helper">
        주소 검색:{" "}
        <a href="https://photon.komoot.io/" target="_blank" rel="noreferrer">
          Photon
        </a>{" "}
        · ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap contributors
        </a>
        . 검색 결과를 고르면 좌표와 시간대를 자동 입력해요. 지역 중심점으로
        검색될 수 있으니 매장 위치를 확인하세요.
      </p>
    </div>
  );
}

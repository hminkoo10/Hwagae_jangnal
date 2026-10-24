import type { Weather } from "@/lib/api";

export function WeatherSource({ weather }: { weather: Weather }) {
  const openMeteo = /open[ -]?meteo/i.test(weather.source);
  return (
    <details className="weather-source">
      <summary>날씨 정보</summary>
      <p>
        날씨를 가져온 곳:{" "}
        {openMeteo ? (
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
            Open-Meteo
          </a>
        ) : (
          weather.source
        )}
      </p>
      {openMeteo && <p>전 세계의 날씨 예보를 제공하는 서비스예요.</p>}
      <p>
        {weather.source} · {weather.note}
      </p>
      <p>
        {new Date(weather.fetched_at).toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
        })}{" "}
        한국 시간 조회{weather.cached ? " · 저장된 자료" : ""}
      </p>
      {weather.message && <p>{weather.message}</p>}
    </details>
  );
}

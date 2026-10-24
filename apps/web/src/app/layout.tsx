import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "화개장날 | 개발 환경",
  description: "화개장터 팀의 날씨 기반 발주 안내 웹앱 개발 환경",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

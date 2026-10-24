import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "화개장날 | 내일 장사, 오늘부터 가볍게",
  description:
    "판매의 흐름을 읽고 재고를 확인해 필요한 만큼 준비하는 사장님 웹앱",
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

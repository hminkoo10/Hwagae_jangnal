import type { Metadata, Viewport } from "next";
import { NativeShell } from "@/components/native-shell";
import "./globals.css";
import "./responsive.css";

export const metadata: Metadata = {
  title: "화개장날 | 내일 장사, 오늘부터 가볍게",
  description:
    "판매의 흐름을 읽고 재고를 확인해 필요한 만큼 준비하는 사장님 웹앱",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <NativeShell>{children}</NativeShell>
      </body>
    </html>
  );
}

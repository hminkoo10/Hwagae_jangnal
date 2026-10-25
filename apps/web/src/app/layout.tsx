import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { NativeShell } from "@/components/native-shell";
import "./globals.css";
import "./responsive.css";
import "./typography.css";
import "./design.css";
import "./assistant.css";
import "./usability.css";
import "./forecast.css";
import "./staff.css";
import "./motion.css";

const suit = localFont({
  src: "./fonts/SUIT-Variable.woff2",
  variable: "--font-suit",
  weight: "100 900",
  display: "swap",
});

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
    <html lang="ko" className={suit.variable}>
      <body>
        <NativeShell>{children}</NativeShell>
      </body>
    </html>
  );
}

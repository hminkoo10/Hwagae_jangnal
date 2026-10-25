import type { Metadata } from "next";
import AdminApplication from "@/components/admin-application";

// 매장 앱 빌드에서는 이 경로를 빼고, 운영자 앱 빌드에서는 첫 화면(/)으로 쓴다(scripts/build-mobile.mjs).
export const metadata: Metadata = {
  title: "화개장날 | 서비스 운영자",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminApplication />;
}

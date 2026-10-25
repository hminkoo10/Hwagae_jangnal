import type { Metadata } from "next";
import AdminApplication from "@/components/admin-application";

// 서비스 운영자 전용 화면. 모바일 앱 빌드에서는 이 경로를 뺀다(scripts/build-mobile.mjs).
export const metadata: Metadata = {
  title: "화개장날 | 서비스 운영자",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminApplication />;
}

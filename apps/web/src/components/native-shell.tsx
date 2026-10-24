"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { hasPendingRequests } from "@/lib/api";

export const NATIVE_BACK_EVENT = "hwagae:native-back";

export function NativeShell({ children }: { children: ReactNode }) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    document.documentElement.classList.add("native-app");
    let disposed = false;
    const listeners: PluginListenerHandle[] = [];
    async function keep(listener: Promise<PluginListenerHandle>) {
      const handle = await listener;
      if (disposed) await handle.remove();
      else listeners.push(handle);
    }
    void (async () => {
      const { Network } = await import("@capacitor/network");
      await keep(
        Network.addListener("networkStatusChange", (status) => {
          if (!disposed) setOffline(!status.connected);
        }),
      );
      const status = await Network.getStatus();
      if (!disposed) setOffline(!status.connected);
      if (Capacitor.getPlatform() !== "android" || disposed) return;
      const { App } = await import("@capacitor/app");
      await keep(
        App.addListener("backButton", () => {
          if (hasPendingRequests()) return;
          const dialog = [
            ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
          ].at(-1);
          if (dialog) {
            dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
            return;
          }
          const back = new Event(NATIVE_BACK_EVENT, { cancelable: true });
          if (window.dispatchEvent(back)) void App.minimizeApp();
        }),
      );
    })().catch(() => {
      // A plugin unavailable in a browser preview must not hide the web app.
      if (!disposed) setOffline(!navigator.onLine);
    });
    return () => {
      disposed = true;
      document.documentElement.classList.remove("native-app");
      for (const listener of listeners) void listener.remove();
    };
  }, []);

  return (
    <>
      {offline && (
        <div className="native-offline-banner" role="status">
          인터넷 연결이 끊겼어요. 연결 후 다시 시도해주세요.
        </div>
      )}
      {children}
    </>
  );
}

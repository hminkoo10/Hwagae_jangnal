import { Capacitor } from "@capacitor/core";

// Cache files stay available while the receiving app copies them. The OS may
// clear this cache later; never request access to the user's whole storage.
export async function shareNativeFile(blob: Blob, filename: string): Promise<"browser" | "shared" | "cancelled"> {
  if (!Capacitor.isNativePlatform()) return "browser";
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const safeName = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  const folder = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const file = await Filesystem.writeFile({
    path: `hwagae-exports/${folder}/${safeName || "hwagae-export"}`,
    data: btoa(binary),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({
      title: filename,
      dialogTitle: "발주서 저장 · 공유",
      files: [file.uri],
    });
  } catch (error) {
    // Both native implementations use this exact rejection for a dismissed
    // share sheet. It is handled, not a failed export or browser fallback.
    if (error instanceof Error && error.message === "Share canceled") return "cancelled";
    throw error;
  }
  return "shared";
}

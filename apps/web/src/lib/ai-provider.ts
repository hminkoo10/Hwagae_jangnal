export type AiProtocol = "chat_completions" | "responses" | "anthropic";

export function protocolForAddress(
  address: string,
  selected: AiProtocol,
): AiProtocol {
  try {
    return new URL(address).hostname === "api.anthropic.com"
      ? "anthropic"
      : selected;
  } catch {
    return selected;
  }
}

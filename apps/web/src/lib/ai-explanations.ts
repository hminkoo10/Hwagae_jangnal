import { api } from "./api";

type Explanation = {
  text: string;
  connection: { name: string; model: string };
  fallback_used: boolean;
  attempts: { id: string; name: string; status: string }[];
};
const pending = new Map<string, Promise<Explanation>>();

export function explainOrder(token: string, storeId: string, recommendationId: string) {
  const key = JSON.stringify([token, storeId, recommendationId]);
  const cached = pending.get(key);
  if (cached) return cached;
  const request = api<Explanation>(`/stores/${storeId}/ai/explain/${recommendationId}`, token,
    { method: "POST", timeoutMs: 80000 });
  pending.set(key, request);
  if (pending.size > 40) pending.delete(pending.keys().next().value!);
  request.catch(() => { if (pending.get(key) === request) pending.delete(key); });
  return request;
}

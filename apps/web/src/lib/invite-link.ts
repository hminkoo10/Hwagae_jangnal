export type InviteKind = "owner" | "staff";
export type Invite = { token: string; kind: InviteKind };

// Owner and staff invites open in the store app (kr.milky.hwagae), registered on Android and iOS.
export const STORE_APP_SCHEME = "kr.milky.hwagae";
const PARAM: Record<InviteKind, string> = { owner: "invite", staff: "staff-invite" };

function fromParams(params: URLSearchParams): Invite | null {
  const owner = params.get(PARAM.owner);
  const staff = params.get(PARAM.staff);
  if (owner) return { token: owner, kind: "owner" };
  if (staff) return { token: staff, kind: "staff" };
  return null;
}

/** Web links carry the token in the fragment: /#invite=… or /#staff-invite=… */
export function inviteFromHash(hash: string) {
  return fromParams(new URLSearchParams(hash.replace(/^#/, "")));
}

/** App links: kr.milky.hwagae://invite?invite=… */
export function inviteFromAppUrl(url: string) {
  if (!url.startsWith(`${STORE_APP_SCHEME}://invite`)) return null;
  const query = url.split("?")[1]?.split("#")[0] ?? "";
  return fromParams(new URLSearchParams(query));
}

export function appInviteUrl({ token, kind }: Invite) {
  return `${STORE_APP_SCHEME}://invite?${PARAM[kind]}=${encodeURIComponent(token)}`;
}

export function inviteHash({ token, kind }: Invite) {
  return `${PARAM[kind]}=${encodeURIComponent(token)}`;
}

/** The same invite on the web, marked so it does not hand off to the app again. */
export function webInviteUrl(origin: string, invite: Invite) {
  return `${origin}/?noapp=1#${inviteHash(invite)}`;
}

/** Chrome opens the app if installed, otherwise the fallback page (which then stays on the web form). */
export function androidInviteIntent({ token, kind }: Invite, fallback: string) {
  return `intent://invite?${PARAM[kind]}=${encodeURIComponent(token)}#Intent;scheme=${STORE_APP_SCHEME};package=${STORE_APP_SCHEME};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

export function mobilePlatform(userAgent: string, touchPoints: number): "android" | "ios" | null {
  if (/Android/i.test(userAgent)) return "android";
  // iPadOS reports a Mac user agent; touch support tells them apart.
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)) return "ios";
  return null;
}

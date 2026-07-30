import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

export type PersistenceActor = {
  /** Stable tenant boundary for persisted application data. */
  tenantId: string;
  /** Trusted display identity, derived from the hosting authentication header. */
  displayName: string;
  email: string;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  return chatGPTUserFromHeaders(requestHeaders);
}

/**
 * Pure header parser kept separate from Next's request context so the trust
 * boundary can be unit tested.
 *
 * These headers are authoritative only behind Sites/ChatGPT ingress, which
 * strips client-supplied copies before setting the authenticated identity.
 */
export function chatGPTUserFromHeaders(
  requestHeaders: Pick<Headers, "get">,
): ChatGPTUser | null {
  const email = normalizeEmail(requestHeaders.get(USER_EMAIL_HEADER));
  if (!email) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export async function getPersistenceActor(): Promise<PersistenceActor | null> {
  const user = await getChatGPTUser();
  if (!user) return null;
  return {
    tenantId: `email:${user.email}`,
    displayName: user.displayName,
    email: user.email,
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    !/^[^@\s]+@[^@\s]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

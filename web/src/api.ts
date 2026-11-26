import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-secretbox": "1" };
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) {
    headers["content-type"] = "application/octet-stream";
    payload = body as Uint8Array<ArrayBuffer>;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? res.statusText);
  }
  if (res.headers.get("content-type")?.includes("application/octet-stream")) {
    return new Uint8Array(await res.arrayBuffer()) as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => call<T>("DELETE", path),
};

// --- Types returned by the server ------------------------------------------

export type Me = {
  id: string;
  nickname: string;
  memberRecipient: string | null;
  passkey: { id: string; transports: string[]; hasEnvelope: boolean };
};

export type BoxSummary = { id: string; name: string; role: Role; item_count: number; member_count: number };
export type Role = "admin" | "reader";

export type BoxDetail = {
  box: { id: string; name: string; recipient: string; keyVersion: number; keyHistory: string | null };
  me: { userId: string; role: Role; keyCopy: string };
  members: { userId: string; nickname: string; recipient: string; role: Role; joinedAt: number }[];
  items: { id: string; name: string; size: number; source: string; createdAt: number; addedBy: string | null }[];
  invites: { id: string; label: string; role: Role; status: string; expiresAt: number; usedBy: string | null }[];
  ingestTokens: { label: string; createdAt: number }[];
};

export type InviteInfo = {
  boxId: string;
  boxName: string;
  label: string;
  role: Role;
  invitedBy: string;
  status: "open" | "used" | "expired" | "canceled";
  expiresAt: number;
};

// --- Passkey ceremonies (login identity; PRF is enabled for encryption) ------

export async function registerPasskey(nickname: string): Promise<void> {
  const { flowId, options } = await api.post<{ flowId: string; options: any }>("/api/register/options", { nickname });
  const response = await startRegistration({ optionsJSON: options });
  await api.post("/api/register/verify", { flowId, response });
}

export async function signInWithPasskey(): Promise<void> {
  const { flowId, options } = await api.post<{ flowId: string; options: any }>("/api/login/options");
  const response = await startAuthentication({ optionsJSON: options });
  await api.post("/api/login/verify", { flowId, response });
}

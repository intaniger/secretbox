export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** `key` is the box's access key, for member requests. There are no cookies. */
async function call<T>(method: string, path: string, key?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // the browser sets the multipart content type
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: "omit" });
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
  get: <T>(path: string, key?: string) => call<T>("GET", path, key),
  post: <T>(path: string, body: unknown, key?: string) => call<T>("POST", path, key, body),
  del: <T>(path: string, key: string) => call<T>("DELETE", path, key),
};

// --- What the server returns. Every "...Locked" field is a base64 age file. ---

export type BoxResponse = {
  id: string;
  publicKey: string;
  nameLocked: string;
  hasAddKey: boolean;
  members: { credentialId: string; nameLocked: string; createdAt: number }[];
  /** `labelLocked` is null for data from an outside system. `size` is the locked size. */
  items: { id: string; labelLocked: string | null; size: number; createdAt: number }[];
  invites: { id: string; nameLocked: string; expiresAt: number }[];
};

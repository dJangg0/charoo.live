let csrf = "";
export const getCsrf = () => csrf;
export const setCsrf = (value: string) => {
  csrf = value;
};
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const retryAfter = response.headers.get("Retry-After") ?? "";
    const delay = /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - Date.now();
    throw new ApiError(
      result?.error ||
        (response.status === 429
          ? "Too many requests. Try again shortly."
          : "Unable to connect"),
      response.status,
      Number.isFinite(delay) ? Math.max(0, delay) : 0,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

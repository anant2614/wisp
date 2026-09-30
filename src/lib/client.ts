export async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-poppet': '1', ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const post = <T = any>(url: string, body?: unknown) =>
  api<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

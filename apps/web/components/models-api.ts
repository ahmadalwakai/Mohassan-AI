export async function modelsRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? (response.status === 429 ? "طلبات كثيرة متتابعة. انتظر قليلًا." : "تعذر إتمام الطلب."));
  }
  return body as T;
}

/** Fail the density fixture immediately if the server refuses a setup request. */
export async function densityApi<T = Record<string, unknown>>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result?.ok === false) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(result)}`);
  return result as T;
}

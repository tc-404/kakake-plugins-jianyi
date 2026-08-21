/** HTTP 访问：对齐 Secluded `$访问` / MK `fetchAPI`，供 .ka `访问(...)` 调用 */

export type HttpAccessResult = {
  成功: boolean;
  状态码: number;
  内容: string;
  错误: string;
};

const DEFAULT_TIMEOUT_MS = 15000;

function fail(err: string, status = 0): HttpAccessResult {
  return { 成功: false, 状态码: status, 内容: '', 错误: err };
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[String(k)] = String(v);
    }
    return out;
  }
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parseHeaders(parsed);
    }
  } catch {
    /* ignore */
  }
  return {};
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function prepareBody(
  method: string,
  body: unknown,
  headers: Record<string, string>,
): string | undefined {
  if (method === 'GET' || body == null || body === '') return undefined;

  if (typeof body === 'object' && !Array.isArray(body)) {
    if (!hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    return JSON.stringify(body);
  }

  const s = String(body);
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    if (!hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    return s;
  }

  if (!hasHeader(headers, 'Content-Type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return s;
}

/**
 * `访问(方法, 网址)`
 * `访问("GET", 网址, 请求头?)`
 * `访问("POST", 网址, 请求体, 请求头?)`
 *
 * 请求头可为对象或 JSON 字符串；POST 请求体为对象时按 JSON 发送（对齐 MK fetchAPI），
 * 为 `a=b&c=d` 字符串时按表单发送（对齐 Secluded `$访问 POST`）。
 */
export async function httpAccess(
  methodRaw: unknown,
  urlRaw: unknown,
  arg3?: unknown,
  arg4?: unknown,
  opts?: { timeoutMs?: number; logger?: { warn?: (...a: unknown[]) => void } },
): Promise<HttpAccessResult> {
  const method = String(methodRaw ?? '').trim().toUpperCase();
  const url = String(urlRaw ?? '').trim();
  if (!method || (method !== 'GET' && method !== 'POST')) {
    return fail('访问 方法须为 GET 或 POST');
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return fail('访问 需要有效的 http(s) 网址');
  }

  let bodyRaw: unknown;
  let headersRaw: unknown;
  if (method === 'GET') {
    headersRaw = arg3;
  } else {
    bodyRaw = arg3;
    headersRaw = arg4;
  }

  const headers = parseHeaders(headersRaw);
  const body = prepareBody(method, bodyRaw, headers);
  const timeoutMs = Math.max(1, Number(opts?.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      opts?.logger?.warn?.(
        `[mkjianyi] 访问失败: HTTP ${res.status} ${method} ${url.slice(0, 120)}`,
      );
      return {
        成功: false,
        状态码: res.status,
        内容: text,
        错误: `HTTP ${res.status}`,
      };
    }
    return {
      成功: true,
      状态码: res.status,
      内容: text,
      错误: '',
    };
  } catch (e) {
    const msg = e instanceof Error
      ? (e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : e.message)
      : String(e);
    opts?.logger?.warn?.(`[mkjianyi] 访问异常:`, msg);
    return fail(msg);
  } finally {
    clearTimeout(timer);
  }
}

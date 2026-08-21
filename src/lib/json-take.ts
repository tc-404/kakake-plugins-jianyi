/** 解析 JSON 文本，可选按路径取值（对齐 Secluded `$JSON 解析`） */

function walkJsonPath(root: unknown, path: unknown[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null) return '';
    if (typeof seg === 'number' && Number.isFinite(seg) && Array.isArray(cur)) {
      const idx = Math.trunc(seg);
      if (idx < 0 || idx >= cur.length) return '';
      cur = cur[idx];
      continue;
    }
    const key = String(seg ?? '').trim();
    if (!key) return '';
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return '';
      cur = cur[idx];
      continue;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key];
      continue;
    }
    return '';
  }
  return cur == null ? '' : cur;
}

/**
 * `取JSON(文本)` → 解析后的对象/数组/标量；失败返回 `""`
 * `取JSON(文本, 键或下标, …)` → 沿路径取值
 */
export function takeJson(raw: unknown, ...path: unknown[]): unknown {
  const text = String(raw ?? '').trim();
  if (!text) return path.length ? '' : '';
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return '';
  }
  if (!path.length) return root;
  return walkJsonPath(root, path);
}

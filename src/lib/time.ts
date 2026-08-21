/**
 * .ka [时间] / [转时间:…] 本地时区格式化
 */

export const DEFAULT_TIME_PATTERN = 'YYYY-MM-DD HH:mm:ss';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 按模板输出；占位 YYYY/MM/DD/HH/mm/ss，其余原样 */
export function formatDateByPattern(date: Date, pattern: string = DEFAULT_TIME_PATTERN): string {
  const y = String(date.getFullYear());
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  const map: Record<string, string> = {
    YYYY: y,
    MM: mo,
    DD: d,
    HH: h,
    mm: mi,
    ss: s,
  };
  return String(pattern ?? DEFAULT_TIME_PATTERN).replace(/YYYY|MM|DD|HH|mm|ss/g, (tok) => map[tok] ?? tok);
}

export type TimestampUnit = 'ms' | 's';

/** 时间戳 → Date；非法返回 null */
export function parseTimestampToDate(unit: TimestampUnit, raw: unknown): Date | null {
  let n: number;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = raw;
  } else if (typeof raw === 'string') {
    const t = raw.replace(/\s+/g, '');
    if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    n = Number(t);
    if (!Number.isFinite(n)) return null;
  } else {
    return null;
  }
  const ms = unit === 's' ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * .ka [时间] / [时间:后缀] 格式化（本地时区）
 * 后缀可为：年/月/日/时/分/秒、时间戳毫秒/秒，或自定义模板（YYYY MM DD HH mm ss，按需选用）
 */
export function formatKaTime(mode: string, now: Date = new Date()): string {
  const m = String(mode ?? '').trim();

  if (!m) {
    return formatDateByPattern(now, DEFAULT_TIME_PATTERN);
  }

  switch (m) {
    case '时间戳毫秒':
      return String(now.getTime());
    case '时间戳秒':
      return String(Math.floor(now.getTime() / 1000));
    case '年':
      return String(now.getFullYear());
    case '月':
      return pad2(now.getMonth() + 1);
    case '日':
      return pad2(now.getDate());
    case '时':
      return pad2(now.getHours());
    case '分':
      return pad2(now.getMinutes());
    case '秒':
      return pad2(now.getSeconds());
    default:
      // 自定义模板：占位任选，如 YYYY-MM-DD / YYYY年MM月 / HH:mm
      if (/YYYY|MM|DD|HH|mm|ss/.test(m)) {
        return formatDateByPattern(now, m);
      }
      throw new Error(`未知时间格式: ${m}`);
  }
}

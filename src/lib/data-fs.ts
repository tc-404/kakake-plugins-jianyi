/**
 * 插件数据读写（对齐 MK readA/writeA/readB/writeB）。
 * 相对路径默认落在 dataPath；数据文件/、默认资源/ 落在 pluginPath。
 */
import fs from 'node:fs';
import path from 'node:path';

export type DataFsLogger = {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type DataFsRoots = {
  dataPath: string;
  pluginPath?: string;
  logger?: DataFsLogger;
};

function cleanRel(raw: string): string {
  return String(raw ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

function isBundledRel(rel: string): boolean {
  return (
    rel === '数据文件'
    || rel.startsWith('数据文件/')
    || rel === '默认资源'
    || rel.startsWith('默认资源/')
  );
}

function rawSafe(s: string): string {
  return String(s).slice(0, 200);
}

/** 解析后必须落在 root 下（禁止 ../ 逃逸） */
function assertUnderRoot(abs: string, root: string, label: string): string {
  const resolved = path.resolve(abs);
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label}路径越界: ${rawSafe(abs)}`);
  }
  return resolved;
}

/**
 * 解析读写路径。
 * - 绝对路径：原样（不做根校验，便于高级用法）
 * - 数据文件/、默认资源/：相对 pluginPath
 * - 其它相对路径：相对 dataPath
 */
export function resolveDataFsPath(roots: DataFsRoots, filename: string): string {
  const raw = String(filename ?? '').trim();
  if (!raw) throw new Error('路径为空');

  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }

  const rel = cleanRel(raw);
  if (isBundledRel(rel)) {
    const pluginPath = String(roots.pluginPath ?? '').trim();
    if (!pluginPath) throw new Error('缺少 pluginPath，无法解析捆绑资源路径');
    return assertUnderRoot(path.join(pluginPath, rel), pluginPath, '捆绑');
  }

  const dataPath = String(roots.dataPath ?? '').trim();
  if (!dataPath) throw new Error('缺少 dataPath，无法解析数据路径');
  return assertUnderRoot(path.join(dataPath, rel), dataPath, '数据');
}

/** 整文件读取；不存在或失败 → "" */
export function readA(roots: DataFsRoots, filename: string): string {
  try {
    const filePath = resolveDataFsPath(roots, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    roots.logger?.error?.(`[mkjianyi] 读文件 ${filename} 失败:`, error);
  }
  return '';
}

/** 整文件覆盖写；自动建目录 */
export function writeA(roots: DataFsRoots, filename: string, content: string): boolean {
  try {
    const filePath = resolveDataFsPath(roots, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(content ?? ''), 'utf-8');
    return true;
  } catch (error) {
    roots.logger?.error?.(`[mkjianyi] 写文件 ${filename} 失败:`, error);
    return false;
  }
}

/** JSON 对象键读取；缺文件/缺键 → defaultValue（默认 ""） */
export function readB(
  roots: DataFsRoots,
  filename: string,
  key: string,
  defaultValue: unknown = '',
): unknown {
  try {
    const filePath = resolveDataFsPath(roots, filename);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      const k = String(key);
      if (k in data && data[k] !== null && data[k] !== undefined) {
        return data[k];
      }
    }
  } catch (error) {
    roots.logger?.error?.(`[mkjianyi] 读 ${filename} 失败:`, error);
  }
  return defaultValue;
}

/** JSON 对象键合并写；损坏 JSON 当 {} */
export function writeB(
  roots: DataFsRoots,
  filename: string,
  key: string,
  value: unknown,
): boolean {
  try {
    const filePath = resolveDataFsPath(roots, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let data: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      } catch {
        data = {};
      }
    }
    data[String(key)] = value;
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    return true;
  } catch (error) {
    roots.logger?.error?.(`[mkjianyi] 写 ${filename} 失败:`, error);
    return false;
  }
}

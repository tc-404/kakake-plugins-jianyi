import path from 'node:path';

export const SCRIPTS_DIR_NAME = '文本类插件';
/** 插件内本地资源目录（构建时一并拷贝） */
export const IMAGES_DIR_NAME = '数据文件';

export function resolveScriptsRoot(pluginPath: string): string {
  return path.join(pluginPath, SCRIPTS_DIR_NAME);
}

/**
 * 解析插件内路径：绝对路径原样规范化；相对路径相对 pluginPath（插件根）。
 * 例：数据文件/cover.png → {pluginPath}/数据文件/cover.png
 */
export function resolvePluginRelativePath(pluginPath: string, relOrAbs: string): string {
  const base = String(pluginPath ?? '').trim();
  if (!base) throw new Error('缺少 pluginPath，无法解析相对路径');
  const raw = String(relOrAbs ?? '').trim();
  if (!raw) throw new Error('路径为空');
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  return path.resolve(base, rel);
}

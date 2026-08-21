import fs from 'node:fs';
import path from 'node:path';
import { parseKaSource } from './parser.js';
import type { KaLoadedScript } from './types.js';

const KA_EXT = /\.ka$/i;
/** 无 watch 时的兜底：最多隔这么久才允许再扫盘 */
const FALLBACK_SCAN_INTERVAL_MS = 3000;

function walkKaFiles(dir: string, baseDir: string, out: { absPath: string; relPath: string }[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkKaFiles(abs, baseDir, out);
      continue;
    }
    if (entry.isFile() && KA_EXT.test(entry.name)) {
      out.push({
        absPath: abs,
        relPath: path.relative(baseDir, abs).split(path.sep).join('/'),
      });
    }
  }
}

export class KaScriptRegistry {
  private cache = new Map<string, KaLoadedScript>();
  /** 热路径直接返回，避免每条消息扫盘 */
  private list: KaLoadedScript[] = [];
  private scriptsDir = '';
  private dirty = true;
  private ready = false;
  private lastScanAt = 0;
  private watchSupported = false;
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  setScriptsDir(dir: string): void {
    if (this.scriptsDir === dir) return;
    this.stopWatch();
    this.scriptsDir = dir;
    this.cache.clear();
    this.list = [];
    this.dirty = true;
    this.ready = false;
    this.startWatch();
  }

  getScriptsDir(): string {
    return this.scriptsDir;
  }

  /** 标记需要下次 ensure 时重扫（文件变更） */
  markDirty(): void {
    this.dirty = true;
  }

  private startWatch(): void {
    const dir = this.scriptsDir;
    if (!dir) return;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.watcher = fs.watch(dir, { recursive: true }, () => {
        // 合并抖动：保存时可能连打多次
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          this.dirty = true;
        }, 80);
      });
      this.watcher.on('error', () => {
        this.watchSupported = false;
        this.stopWatch();
      });
      this.watchSupported = true;
    } catch {
      this.watchSupported = false;
      this.watcher = null;
    }
  }

  stopWatch(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    this.watchSupported = false;
  }

  /**
   * 热路径：未 dirty 时直接返回内存列表（零扫盘）。
   * dirty / 首次 / 无 watch 超时 时才扫盘解析。
   */
  ensure(logger?: { warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }): {
    scripts: KaLoadedScript[];
    refreshed: boolean;
  } {
    const now = Date.now();
    if (this.ready && !this.dirty) {
      if (this.watchSupported || now - this.lastScanAt < FALLBACK_SCAN_INTERVAL_MS) {
        return { scripts: this.list, refreshed: false };
      }
      // 无 watch：到期被动扫一次
      this.dirty = true;
    }

    this.list = this.scan(logger);
    this.dirty = false;
    this.ready = true;
    this.lastScanAt = now;
    return { scripts: this.list, refreshed: true };
  }

  /** 强制扫盘（init 用） */
  forceRefresh(logger?: { warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }): KaLoadedScript[] {
    this.dirty = true;
    return this.ensure(logger).scripts;
  }

  private scan(logger?: { warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }): KaLoadedScript[] {
    const dir = this.scriptsDir;
    if (!dir) {
      this.cache.clear();
      return [];
    }

    let dirOk = false;
    try {
      dirOk = fs.existsSync(dir);
    } catch {
      dirOk = false;
    }
    if (!dirOk) {
      this.cache.clear();
      return [];
    }

    const found: { absPath: string; relPath: string }[] = [];
    walkKaFiles(dir, dir, found);

    const alive = new Set<string>();
    for (const f of found) {
      alive.add(f.relPath);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(f.absPath).mtimeMs;
      } catch {
        continue;
      }

      const prev = this.cache.get(f.relPath);
      if (prev && prev.mtimeMs === mtimeMs && prev.absPath === f.absPath && prev.ast !== undefined) {
        continue;
      }

      let source = '';
      try {
        source = fs.readFileSync(f.absPath, 'utf-8');
      } catch (e) {
        logger?.warn?.(`[mkjianyi] 读取失败 ${f.relPath}:`, (e as Error).message);
        this.cache.set(f.relPath, {
          relPath: f.relPath,
          absPath: f.absPath,
          mtimeMs,
          source: '',
          ast: null,
          parseError: (e as Error).message,
        });
        continue;
      }

      try {
        const ast = parseKaSource(source);
        this.cache.set(f.relPath, {
          relPath: f.relPath,
          absPath: f.absPath,
          mtimeMs,
          source,
          ast,
        });
        logger?.info?.(`[mkjianyi] 已加载子插件 ${f.relPath}`);
      } catch (e) {
        const msg = (e as Error).message;
        logger?.warn?.(`[mkjianyi] 解析失败 ${f.relPath}: ${msg}`);
        this.cache.set(f.relPath, {
          relPath: f.relPath,
          absPath: f.absPath,
          mtimeMs,
          source,
          ast: null,
          parseError: msg,
        });
      }
    }

    for (const key of [...this.cache.keys()]) {
      if (!alive.has(key)) this.cache.delete(key);
    }

    return found
      .map((f) => this.cache.get(f.relPath))
      .filter((x): x is KaLoadedScript => !!x);
  }
}

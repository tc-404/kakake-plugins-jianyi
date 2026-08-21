import { resolve, dirname } from 'path';
import { defineConfig } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { GF_PLUGIN_DIR_NAME, KA_SCRIPTS_DIR, IMAGES_DIR } from './scripts/plugin-constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = GF_PLUGIN_DIR_NAME;

const nodeModules = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
].flat();

function copyDirRecursive(src: string, dest: string) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function copyAssetsPlugin() {
  return {
    name: 'copy-mkjianyi-assets',
    writeBundle() {
      const outDir = resolve(__dirname, OUT_DIR);

      const scriptsSrc = resolve(__dirname, KA_SCRIPTS_DIR);
      const scriptsDest = resolve(outDir, KA_SCRIPTS_DIR);
      if (fs.existsSync(scriptsSrc)) {
        if (fs.existsSync(scriptsDest)) fs.rmSync(scriptsDest, { recursive: true, force: true });
        copyDirRecursive(scriptsSrc, scriptsDest);
        console.log('[mkjianyi] copied', KA_SCRIPTS_DIR, '->', scriptsDest);
      } else {
        console.warn('[mkjianyi] missing', KA_SCRIPTS_DIR);
      }

      const imagesSrc = resolve(__dirname, IMAGES_DIR);
      const imagesDest = resolve(outDir, IMAGES_DIR);
      if (fs.existsSync(imagesSrc)) {
        if (fs.existsSync(imagesDest)) fs.rmSync(imagesDest, { recursive: true, force: true });
        copyDirRecursive(imagesSrc, imagesDest);
        console.log('[mkjianyi] copied', IMAGES_DIR, '->', imagesDest);
      } else {
        console.warn('[mkjianyi] missing', IMAGES_DIR);
        if (!fs.existsSync(imagesDest)) fs.mkdirSync(imagesDest, { recursive: true });
      }

      const kaMtsxSrc = resolve(__dirname, 'syntax', 'ka.mtsx');
      if (fs.existsSync(kaMtsxSrc)) {
        if (!fs.existsSync(imagesDest)) fs.mkdirSync(imagesDest, { recursive: true });
        fs.copyFileSync(kaMtsxSrc, resolve(imagesDest, 'ka.mtsx'));
        console.log('[mkjianyi] copied syntax/ka.mtsx ->', resolve(imagesDest, 'ka.mtsx'));
      } else {
        console.warn('[mkjianyi] missing syntax/ka.mtsx');
      }

      const pluginJson = resolve(__dirname, 'plugin.json');      if (fs.existsSync(pluginJson)) {
        fs.copyFileSync(pluginJson, resolve(outDir, 'plugin.json'));
      }

      const pkgPath = resolve(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const distPkg = {
          name: pkg.name,
          plugin: pkg.plugin,
          version: pkg.version,
          type: pkg.type,
          main: pkg.main,
          description: pkg.description,
          author: pkg.author,
          license: pkg.license,
          keywords: pkg.keywords,
        };
        fs.writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify(distPkg, null, 2)}\n`);
      }

      const docsSrc = resolve(__dirname, '插件文档.md');
      if (fs.existsSync(docsSrc)) {
        fs.copyFileSync(docsSrc, resolve(outDir, '插件文档.md'));
      }
    },
  };
}

export default defineConfig({
  resolve: { conditions: ['node', 'default'] },
  build: {
    sourcemap: false,
    target: 'esnext',
    minify: 'esbuild',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [...nodeModules],
      output: { inlineDynamicImports: true },
    },
    outDir: OUT_DIR,
    emptyOutDir: true,
  },
  plugins: [nodeResolve(), copyAssetsPlugin()],
});

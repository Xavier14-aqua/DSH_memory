#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROFILE = valueOf('--profile', process.env.DSH_PROFILE || 'desktop');
const DSH_HOME = path.resolve(valueOf('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const DRY = args.includes('--dry-run');
const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
const pluginRoot = path.join(DSH_HOME, 'plugins', 'dsh-memory');
const moduleLink = path.join(profileDir, 'node_modules', 'dsh-memory');
const packageFile = path.join(profileDir, 'package.json');
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const BEGIN = '# === dsh-memory BEGIN ===';
const END = '# === dsh-memory END ===';
const markerRe = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`, 'g');
const sameTarget = (link, target) => {
  try { return fs.realpathSync(link).toLowerCase() === fs.realpathSync(target).toLowerCase(); } catch { return false; }
};
const removeLink = (link, target) => {
  if (!fs.existsSync(link)) return;
  if (!sameTarget(link, target)) throw new Error(`拒绝删除非本项目链接：${link}`);
  console.log(`${DRY ? '[dry] ' : ''}- ${link}`);
  if (!DRY) fs.rmSync(link, { recursive: true, force: true });
};

if (fs.existsSync(patchFile)) {
  const original = fs.readFileSync(patchFile, 'utf8');
  const next = original.replace(markerRe, '').trimEnd() + '\n';
  if (next !== original) {
    console.log(`${DRY ? '[dry] ' : ''}- Cordis 注册区块：${patchFile}`);
    if (!DRY) {
      fs.copyFileSync(patchFile, `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.writeFileSync(patchFile, next, 'utf8');
    }
  }
}
if (fs.existsSync(packageFile)) {
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const current = String(pkg.dependencies?.['dsh-memory'] ?? '');
  if (current.includes('/plugins/dsh-memory') || current.includes('\\plugins\\dsh-memory')) {
    delete pkg.dependencies['dsh-memory'];
    console.log(`${DRY ? '[dry] ' : ''}- profile 依赖：${packageFile}`);
    if (!DRY) fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
}
removeLink(moduleLink, pluginRoot);
removeLink(pluginRoot, REPO);
console.log('卸载完成。数据目录和 config.json 已保留。');

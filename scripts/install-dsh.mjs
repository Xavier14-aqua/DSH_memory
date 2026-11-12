#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PROFILE = valueOf('--profile', process.env.DSH_PROFILE || 'desktop');
const DSH_HOME = path.resolve(valueOf('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const DRY = args.includes('--dry-run');

if (!/^[A-Za-z0-9._-]+$/.test(PROFILE) || PROFILE === '.' || PROFILE === '..') {
  throw new Error(`非法 profile 名称：${PROFILE}`);
}

const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
const pluginRoot = path.join(DSH_HOME, 'plugins', 'dsh-memory');
const moduleLink = path.join(profileDir, 'node_modules', 'dsh-memory');
const packageFile = path.join(profileDir, 'package.json');
const patchFile = path.join(profileDir, 'cordis.patch.yml');
const BEGIN = '# === dsh-memory BEGIN ===';
const END = '# === dsh-memory END ===';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function backup(file) {
  if (!fs.existsSync(file) || DRY) return;
  fs.copyFileSync(file, `${file}.bak-${stamp()}`);
}
function sameTarget(link, target) {
  try {
    return fs.realpathSync(link).toLowerCase() === fs.realpathSync(target).toLowerCase();
  } catch { return false; }
}
function ensureLink(link, target) {
  if (fs.existsSync(link)) {
    if (sameTarget(link, target)) return console.log(`= 链接已正确：${link}`);
    throw new Error(`目标位置已存在且不指向本仓库：${link}。请人工确认，安装器不会覆盖。`);
  }
  console.log(`${DRY ? '[dry] ' : ''}+ 链接：${link} -> ${target}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
function replaceBlock(text, block) {
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`, 'g');
  const clean = String(text || '').replace(re, '').trimEnd();
  return `${clean}${clean ? '\n\n' : ''}${block}\n`;
}

if (!DRY) fs.mkdirSync(profileDir, { recursive: true });
ensureLink(pluginRoot, REPO);
ensureLink(moduleLink, pluginRoot);

let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
if (fs.existsSync(packageFile)) pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
pkg.dependencies['dsh-memory'] = `link:${pluginRoot.replace(/\\/g, '/')}`;
console.log(`${DRY ? '[dry] ' : ''}+ 注册 profile 依赖：${packageFile}`);
if (!DRY) {
  backup(packageFile);
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

const yamlPath = REPO.replace(/'/g, "''").replace(/\\/g, '/');
const block = `${BEGIN}\n# 由 DSH_memory/scripts/install-dsh.mjs 维护，请勿手改区块内部。\n- insert:\n    - id: memory\n      name: dsh-memory\n      config:\n        memDir: '${yamlPath}'\n${END}`;
const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
console.log(`${DRY ? '[dry] ' : ''}+ 注册 Cordis 插件：${patchFile}`);
if (!DRY) {
  backup(patchFile);
  const temp = `${patchFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, replaceBlock(original, block), 'utf8');
  fs.renameSync(temp, patchFile);
}

console.log(`安装完成（profile=${PROFILE}）。重启 DSH 后运行：node memory.mjs doctor`);

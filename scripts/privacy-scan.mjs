#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'data', 'groups', 'members', 'persona', 'logs', '.state', '.backups']);
const allowedExt = new Set(['.js', '.mjs', '.json', '.md', '.bat', '.gitignore', '.yml', '.yaml']);
const legacyDeploymentPattern = new RegExp(`D:\\\\${['big', 'blue', 'fish'].join('')}`, 'i');
const rules = [
  ['Windows 用户目录', /C:\\Users\\[^\\\s]+/i],
  ['维护者旧部署路径', legacyDeploymentPattern],
  ['疑似长令牌', /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/],
  ['私钥', /BEGIN [A-Z ]*PRIVATE KEY/]
];
const findings = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (item.name === 'privacy-scan.mjs') continue;
    else if (allowedExt.has(path.extname(item.name)) || item.name === '.gitignore') {
      const text = fs.readFileSync(file, 'utf8');
      for (const [label, re] of rules) {
        const match = re.exec(text);
        if (match) findings.push(`${path.relative(ROOT, file)}: ${label} (${match[0].slice(0, 80)})`);
      }
    }
  }
}
walk(ROOT);
if (findings.length) {
  console.error('隐私扫描失败：\n' + findings.map((line) => `- ${line}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('隐私扫描通过：未发现本机用户路径、旧部署路径、常见令牌或私钥。');
}

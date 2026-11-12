#!/usr/bin/env node
// 记忆库工具 v0.11.4
//
// 命令：
//   node memory.mjs status                  总览（群/成员/timeline/人设/是否待同步/一致性告警）
//   node memory.mjs sync [--dry]            只把 profile.md 的 boot 块（≤300 字）推向 initial-prompts.json
//   node memory.mjs context --key group:X [--detail full] [--limit 12] [--state 路径]
//   node memory.mjs migrate [--dry]         v0.3 → v0.4 结构迁移（成员全局化 + meta.json + timeline 模板）
//   node memory.mjs member:list
//   node memory.mjs member:add <QQ> <群名片>
//   node memory.mjs member:fact <QQ> "<事实>" [--scope group|global] [--group 群号] [--source 来源] [--confidence 0.9]
//
// 环境变量：
//   MEMORY_ROOT     记忆库根目录（默认 = 本脚本所在目录）
//   QQBRIDGE_HOME   qq-bridge 根目录（默认 <QQbridge 路径>）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildContext, extractBootBlock, loadMembers, readJsonFile, readTextFile } from './core/context.mjs';
import { readCursor, listAudits, readAudit, rollbackAudit, dedupeMemberFacts } from './core/consolidate.mjs';
import { readMetrics, summarizeMetrics } from './core/metrics.mjs';
import { readPendingQueue } from './core/pending.mjs';
import { evaluatePendingTrigger } from './core/batching.mjs';
import { listTransactions, recoverPreparedTransactions } from './core/transaction.mjs';
import { createFactRecord, migrateMembersToSchema3 } from './core/facts.mjs';
import { analyzeToolUsage, applyToolPrunePlan, writeToolUsageReport } from './core/tool-usage.mjs';
import { loadMemoryConfig } from './core/config.mjs';
import { inspectQQbridgeCompatibility, QQBRIDGE_COMPATIBILITY } from './adapters/qqbridge-dsh.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 代码在 src\，仓库根在上一级；测试时可用 MEMORY_ROOT 覆盖。
const MEM_REPO = process.env.MEMORY_ROOT ? path.resolve(process.env.MEMORY_ROOT) : path.resolve(SCRIPT_DIR, '..');
const MEM_CFG = loadMemoryConfig(MEM_REPO);
// 代码仓库与数据根可以分开；默认仍指向同一个目录，保持现有部署兼容。
const MEM_ROOT = MEM_CFG.dataDir;
const BRIDGE_ROOT = MEM_CFG.bridge.home;

const GROUPS_DIR = path.join(MEM_ROOT, 'groups');
const MEMBERS_DIR = path.join(MEM_ROOT, 'members');
const PERSONA_DIR = path.join(MEM_ROOT, 'persona');
const BACKUP_DIR = path.join(MEM_ROOT, '.backups');
const STATE_DIR = path.join(BRIDGE_ROOT, 'state');
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const CONFIG_FILE = path.join(BRIDGE_ROOT, 'config.json');
const CONSOLE_TOKEN_FILE = path.join(STATE_DIR, 'console-token');
const ROLES_DIR = path.join(BRIDGE_ROOT, 'roles');

const BOOT_MAX_CHARS = 300;

// ── 基础工具 ────────────────────────────────────────────────────────────────
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const monthTag = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `${path.basename(file)}.${stamp()}.bak`);
  fs.copyFileSync(file, target);
  return target;
}

function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

const atomicWriteJson = (file, obj) => atomicWriteText(file, JSON.stringify(obj, null, 2) + '\n');

// ── 桥接侧 ──────────────────────────────────────────────────────────────────
const readConfig = () => readJsonFile(CONFIG_FILE, {}) || {};

function maxInjectChars() {
  const raw = Number(readConfig()?.socialV2?.initialPromptMaxChars);
  return Number.isFinite(raw) && raw > 0 ? Math.min(8000, Math.max(100, Math.round(raw))) : 2000;
}

const consolePort = () => {
  const p = Number(readConfig()?.consolePort);
  return Number.isFinite(p) && p > 0 ? p : 3100;
};

function consoleToken() {
  try {
    return fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function httpCall({ method, urlPath, body, timeoutMs = 1500 }) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: consolePort(),
        path: urlPath,
        method,
        timeout: timeoutMs,
        headers: {
          'x-console-token': consoleToken(),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`));
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('响应不是 JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function bridgeStatus() {
  try {
    const r = await httpCall({ method: 'GET', urlPath: '/api/status', timeoutMs: 1200 });
    return { running: true, mode: r?.mode ?? null, allowGroups: r?.allowGroups ?? [] };
  } catch (error) {
    return { running: false, error: String(error?.message ?? error) };
  }
}

// ── 记忆库读取 ──────────────────────────────────────────────────────────────
function listGroups() {
  let entries = [];
  try {
    entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

const groupKey = (gid) => `group:${gid}`;

const profilePath = (gid) => path.join(GROUPS_DIR, gid, 'profile.md');
const metaPath = (gid) => path.join(GROUPS_DIR, gid, 'meta.json');
const memberPath = (qq) => path.join(MEMBERS_DIR, `${qq}.json`);

function readGroupMeta(gid) {
  return readJsonFile(metaPath(gid), null);
}

function membersInGroup(gid) {
  return loadMembers(MEM_ROOT).filter((m) => m?.groups && m.groups[gid]);
}

function timelineMonths(gid) {
  try {
    return fs
      .readdirSync(path.join(GROUPS_DIR, gid, 'timeline'))
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

// ── 人设底线单一真源（A）────────────────────────────────────────────────────
const BASE_START = '<!-- base:start -->';
const BASE_END = '<!-- base:end -->';

function roleName() {
  const st = readJsonFile(path.join(STATE_DIR, 'current-role.json'), null);
  return st?.role ? String(st.role) : '';
}

function renderBaseBlock(baseMarkdown) {
  const lines = String(baseMarkdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => !/^\s*>/.test(l))
    .filter((l) => !/<!--/.test(l));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 把 persona/base.md 写进 roles/<当前角色>.md 的 base 块；返回状态。 */
function applyRoleBase({ dry } = {}) {
  const name = roleName();
  if (!name) return { status: 'skip', reason: '没有启用角色（state\\current-role.json 里 role 为空）' };
  const roleFile = path.join(ROLES_DIR, `${name}.md`);
  const baseMd = readTextFile(path.join(PERSONA_DIR, 'base.md'));
  const block = renderBaseBlock(baseMd);
  if (!block) return { status: 'skip', reason: 'persona\\base.md 是空的' };
  const current = readTextFile(roleFile, '');
  if (!current) return { status: 'skip', reason: `找不到 ${roleFile}` };

  let md = current;
  const wrapped = `${BASE_START}\n${block}\n${BASE_END}`;
  const marked = /<!--\s*base:start\s*-->[\s\S]*?<!--\s*base:end\s*-->/;
  if (marked.test(md)) {
    md = md.replace(marked, wrapped);
  } else {
    const headingRe = /^##\s+.*底线.*$/m;
    const m = headingRe.exec(md);
    if (m) {
      const afterHeading = m.index + m[0].length;
      const rest = md.slice(afterHeading);
      const nextIdx = rest.search(/^##\s+/m);
      const end = nextIdx >= 0 ? afterHeading + nextIdx : md.length;
      md = md.slice(0, afterHeading) + '\n' + wrapped + '\n\n' + md.slice(end);
    } else {
      md = md.trimEnd() + `\n\n## 底线（由 persona\\base.md 自动生成，勿手改）\n${wrapped}\n`;
    }
  }

  const changed = current !== md;
  if (changed && !dry) {
    backupFile(roleFile);
    atomicWriteText(roleFile, md.endsWith('\n') ? md : md + '\n');
  }
  return {
    status: changed ? (dry ? 'will-write' : 'written') : 'in-sync',
    role: name,
    file: roleFile,
    blockChars: block.length
  };
}

function parseProfileTable(markdown) {
  const text = String(markdown ?? '');
  const grab = (label) => {
    const m = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm').exec(text);
    return m ? m[1].trim() : '';
  };
  const name = grab('群名');
  const countRaw = grab('人数');
  const countMatch = /(\d+)/.exec(countRaw);
  return { name, memberCount: countMatch ? Number(countMatch[1]) : 0 };
}

// ── 命令：status ────────────────────────────────────────────────────────────
async function cmdStatus() {
  const bridge = await bridgeStatus();
  const stored = readJsonFile(INITIAL_PROMPTS_FILE, {}) || {};
  const groups = listGroups();
  const members = loadMembers(MEM_ROOT);
  const max = maxInjectChars();

  console.log('桥接：' + (bridge.running ? `运行中（模式 ${bridge.mode}，允许群 ${(bridge.allowGroups || []).join(',') || '无'}）` : '未运行（sync 将直接写 state/initial-prompts.json）'));
  console.log(`记忆库：${MEM_ROOT}`);
  console.log(`注入上限：${max} 字（boot 块本身限制 ${BOOT_MAX_CHARS} 字）`);
  console.log(`全局成员档：${members.length} 个`);
  console.log('');

  for (const gid of groups) {
    const meta = readGroupMeta(gid);
    const boot = extractBootBlock(readTextFile(profilePath(gid)));
    const cur = stored[groupKey(gid)]?.text ?? '';
    const inGroup = membersInGroup(gid).length;
    const months = timelineMonths(gid);
    const statusLabel = !boot ? '**没有 boot 块**' : cur === boot ? '已同步' : '**待同步**';
    console.log(`群 ${gid}  ${meta?.name ?? '（无 meta.json）'}`);
    console.log(`  boot：${boot.length} 字 / 当前注入 ${cur.length} 字 → ${statusLabel}`);
    console.log(`  成员：全局档案里属于本群的 ${inGroup} 个`);
    console.log(`  时间线：${months.length ? months.join(', ') : '（还没有）'}`);
    const cursor = readCursor(MEM_ROOT, groupKey(gid));
    const curLabel = cursor.lastAt ? new Date(cursor.lastAt).toLocaleString('zh-CN', { hour12: false }) : '从未整理';
    console.log(`  整理游标：seq ${cursor.lastSeq || 0}（${curLabel}）`);
    if (boot.length > BOOT_MAX_CHARS) console.log(`  ⚠ boot 块超过 ${BOOT_MAX_CHARS} 字，sync 会截断`);
    if (!meta) console.log('  ⚠ 缺 meta.json（跑 migrate 生成）');
    console.log('');
  }

  // 人设
  const base = readTextFile(path.join(PERSONA_DIR, 'base.md'));
  const dynamic = readTextFile(path.join(PERSONA_DIR, 'dynamic.md'));
  console.log(`人设：base.md ${base.length} 字，dynamic.md ${dynamic.length} 字`);
  const roleState = applyRoleBase({ dry: true });
  if (roleState.status === 'skip') {
    console.log(`  ⚠ 人设底线未同步：${roleState.reason}`);
  } else if (roleState.status === 'in-sync') {
    console.log(`  ✓ 人设底线已同步到 roles\\${roleState.role}.md（${roleState.blockChars} 字，由 persona\\base.md 生成）`);
  } else {
    console.log(`  ⚠ 人设底线待同步：roles\\${roleState.role}.md 与 persona\\base.md 不一致，跑 node memory.mjs sync`);
  }

  // 成员明细
  if (members.length) {
    console.log('');
    console.log('成员档：');
    for (const m of members) {
      const gs = Object.keys(m.groups ?? {});
      const facts = (m.global?.facts?.length ?? 0) + gs.reduce((n, g) => n + (m.groups?.[g]?.facts?.length ?? 0), 0);
      console.log(`  ${m.qq} ${m.displayName ?? ''}  群 ${gs.join(',') || '-'}  事实 ${facts} 条`);
    }
  }
}

// ── 命令：sync ──────────────────────────────────────────────────────────────
async function cmdSync({ dry }) {
  const groups = listGroups();
  if (!groups.length) {
    console.log('（memory/groups 下还没有群）');
    return;
  }
  const bridge = await bridgeStatus();
  const now = Date.now();
  const plan = [];
  for (const gid of groups) {
    let boot = extractBootBlock(readTextFile(profilePath(gid)));
    if (!boot) {
      console.log(`- ${groupKey(gid)} 跳过：profile.md 里没有 <!-- boot:start/end --> 块`);
      continue;
    }
    if (boot.length > BOOT_MAX_CHARS) {
      boot = boot.slice(0, BOOT_MAX_CHARS - 1) + '…';
      console.log(`  ⚠ ${groupKey(gid)} boot 块超长，已截到 ${BOOT_MAX_CHARS} 字`);
    }
    plan.push({ key: groupKey(gid), text: boot });
  }

  if (!plan.length) {
    console.log('没有可同步的内容');
    return;
  }

  if (dry) {
    for (const p of plan) {
      console.log(`--- ${p.key}（${p.text.length} 字）---`);
      console.log(p.text);
      console.log('');
    }
    const role = applyRoleBase({ dry: true });
    console.log(`人设底线：${role.status === 'skip' ? '跳过（' + role.reason + '）' : role.status === 'in-sync' ? '已同步' : `会写入 roles\\${role.role}.md（${role.blockChars} 字）`}`);
    console.log('（--dry：未写入）');
    return;
  }

  if (bridge.running) {
    let ok = 0;
    for (const p of plan) {
      try {
        await httpCall({ method: 'POST', urlPath: '/api/socialV2/initial-prompt', body: { key: p.key, text: p.text } });
        console.log(`✓ ${p.key} 已通过控制台 API 写入（${p.text.length} 字）`);
        ok += 1;
      } catch (error) {
        console.log(`✗ ${p.key} 写入失败：${error.message}`);
      }
    }
    const role = applyRoleBase();
    console.log(`人设底线：${role.status === 'skip' ? '跳过（' + role.reason + '）' : role.status === 'written' ? `已写入 roles\\${role.role}.md` : '本来就是同步的'}`);
    console.log(`\n完成：${ok}/${plan.length}（桥接在运行，已热更新）`);
    return;
  }

  const stored = readJsonFile(INITIAL_PROMPTS_FILE, {}) || {};
  const backup = backupFile(INITIAL_PROMPTS_FILE);
  for (const p of plan) {
    const prev = stored[p.key];
    stored[p.key] = { text: p.text, createdAt: Number(prev?.createdAt) || now, updatedAt: now };
    console.log(`✓ ${p.key} 写入（${p.text.length} 字）`);
  }
  atomicWriteJson(INITIAL_PROMPTS_FILE, stored);
  console.log(`\n已写入 ${plan.length} 个群 → ${INITIAL_PROMPTS_FILE}`);
  if (backup) console.log(`原文件已备份 → ${backup}`);
  const role = applyRoleBase();
  console.log(`人设底线：${role.status === 'skip' ? '跳过（' + role.reason + '）' : role.status === 'written' ? `已写入 roles\\${role.role}.md` : '本来就是同步的'}`);
  console.log('提示：群背景只在会话首次唤醒（bootstrap）注入；已有会话要 /reset 才会重灌。');
}

// ── 命令：context ───────────────────────────────────────────────────────────
async function cmdContext({ key, query, intent, detail, includeRecent, limit, state }) {
  if (!key) throw new Error('用法：node memory.mjs context --key group:1234567890 [--query "上次发生什么"] [--intent timeline] [--detail full] [--include-recent]');
  let messages = [];
  const stateFile = state ? path.resolve(state) : SOCIAL_V2_FILE;
  const st = readJsonFile(stateFile, null);
  if (st?.conversations?.[key]?.recentMessages) {
    messages = st.conversations[key].recentMessages;
  }
  const conf = MEM_CFG.context;
  const mode = ['tiny', 'brief', 'full'].includes(detail) ? detail : conf.defaultDetail;
  const out = buildContext({
    memDir: MEM_ROOT,
    key,
    query: query ?? '',
    intent: intent ?? 'auto',
    detail: mode,
    includeRecent: includeRecent === true,
    limit: limit ? Number(limit) : conf.windowMessages,
    messages,
    maxChars: mode === 'tiny' ? conf.tinyChars : mode === 'full' ? conf.fullChars : conf.maxChars,
    sectionBudgets: conf
  });
  console.log(out.text);
  console.log('');
  console.log(`[${out.chars} 字]${out.truncated ? ` 已裁剪：${out.dropped.join('/')}` : ''} 分段长度：${JSON.stringify(out.sections)}`);
}

// ── 命令：审计 / 回滚 / 去重 ────────────────────────────────────────────────
function cmdAudit(limit = 15) {
  const items = listAudits(MEM_ROOT, limit);
  if (!items.length) {
    console.log('还没有整理审计记录（.state\\audit）');
    return;
  }
  console.log(`最近 ${items.length} 次整理：`);
  for (const a of items) {
    const when = new Date(a.at).toLocaleString('zh-CN', { hour12: false });
    const points = (a.timeline ?? []).reduce((n, t) => n + (t.points?.length ?? 0), 0);
    console.log(`  ${a.id}  ${when}  ${a.key}  消息 ${a.messages?.count ?? 0} 条（seq ${a.messages?.fromSeq}-${a.messages?.toSeq}）`);
    console.log(`      时间线 +${points}  事实 +${(a.facts ?? []).length}  人设 ${a.persona ? '更新' : '未变'}${a.rolledBackAt ? '  （已回滚）' : ''}`);
  }
}

function cmdRollback(id) {
  const target = id || 'latest';
  const audit = readAudit(MEM_ROOT, target);
  if (!audit) {
    console.log(`没有找到审计记录：${target}`);
    return;
  }
  const r = rollbackAudit({ memDir: MEM_ROOT, id: audit.id });
  if (!r.ok) {
    console.log('回滚失败：' + r.error);
    return;
  }
  console.log(`已回滚 ${r.auditId}：时间线 -${r.removed.timeline}，事实 -${r.removed.facts}，活跃度 -${r.removed.interactions}，人设${r.persona}`);
}

function cmdTransactions({ recover = false } = {}) {
  if (recover) {
    const recovered = recoverPreparedTransactions(MEM_ROOT);
    console.log(`已恢复 ${recovered.length} 个 prepared 事务（全部按 before 回滚）。`);
  }
  const items = listTransactions(MEM_ROOT, { limit: 20 });
  if (!items.length) return console.log('还没有补丁事务（.state\\transactions）。');
  for (const tx of items) {
    console.log(`  ${tx.id}  ${tx.status}  files=${tx.files?.length ?? 0}  ${new Date(tx.preparedAt).toLocaleString('zh-CN', { hour12: false })}`);
  }
}

function cmdDedupe({ threshold, dry }) {
  const t = Number(threshold);
  const th = Number.isFinite(t) && t > 0.5 && t <= 1 ? t : 0.8;
  const r = dedupeMemberFacts({ memDir: MEM_ROOT, threshold: th, dry: Boolean(dry) });
  console.log(`扫描 ${r.files} 个成员档，近重复事实 ${r.removed} 条（阈值 ${th}${dry ? '，--dry 未写入' : ''}）`);
  for (const d of r.details.slice(0, 20)) console.log(`  ${d.qq} [${d.scope}] 删「${d.dropped}」← 保留「${d.kept}」`);
  if (r.details.length > 20) console.log(`  …还有 ${r.details.length - 20} 条`);
}

// ── 命令：migrate ───────────────────────────────────────────────────────────
function migrateMemberFile(oldPath, gid) {
  const m = readJsonFile(oldPath, null);
  if (!m) return null;
  const qq = String(m.qq ?? path.basename(oldPath, '.json'));
  const target = memberPath(qq);
  const existing = readJsonFile(target, null);

  const globalFacts = [];
  const groupFacts = [];
  for (const f of Array.isArray(m.facts) ? m.facts : []) {
    const fact = {
      id: String(f?.id ?? `f-${qq}-${globalFacts.length + groupFacts.length + 1}`),
      text: String(f?.text ?? ''),
      date: String(f?.date ?? ''),
      source: String(f?.source ?? ''),
      scope: String(f?.scope ?? 'group'),
      confidence: Number.isFinite(Number(f?.confidence)) ? Number(f.confidence) : 0.8,
      status: String(f?.status ?? 'active')
    };
    if (!fact.text) continue;
    (fact.scope === 'global' ? globalFacts : groupFacts).push(fact);
  }

  const obj = existing || { schema: 2, qq: Number(qq), displayName: m.displayName ?? '', aliases: [], global: { tags: [], traits: [], avoid: [], facts: [] }, groups: {} };
  obj.schema = 2;
  obj.qq = Number(qq);
  obj.displayName = obj.displayName || m.displayName || String(qq);
  if (!Array.isArray(obj.aliases)) obj.aliases = [];
  if (!obj.global) obj.global = { tags: [], traits: [], avoid: [], facts: [] };
  if (!Array.isArray(obj.global.facts)) obj.global.facts = [];
  if (!obj.groups) obj.groups = {};
  obj.global.facts = [...globalFacts, ...obj.global.facts];
  const prevGroup = obj.groups[gid] ?? {};
  obj.groups[gid] = {
    alias: m.displayName ?? prevGroup.alias ?? '',
    relation: m.relation ?? prevGroup.relation ?? '',
    firstSeen: m.firstSeen ?? prevGroup.firstSeen ?? '',
    lastSeen: m.lastSeen ?? prevGroup.lastSeen ?? '',
    interactions: Number(m.interactions ?? prevGroup.interactions ?? 0),
    facts: [...groupFacts, ...(Array.isArray(prevGroup.facts) ? prevGroup.facts : [])]
  };
  return { target, obj, qq };
}

function cmdMigrate({ dry }) {
  const groups = listGroups();
  const report = [];
  const backups = [];

  for (const gid of groups) {
    // 1) meta.json
    const meta = readGroupMeta(gid);
    if (!meta) {
      const parsed = parseProfileTable(readTextFile(profilePath(gid)));
      const obj = {
        schema: 1,
        group: Number(gid),
        name: parsed.name || `群 ${gid}`,
        memberCount: parsed.memberCount || 0,
        updatedAt: Date.now()
      };
      report.push(`+ groups/${gid}/meta.json（${obj.name}，${obj.memberCount} 人）`);
      if (!dry) atomicWriteJson(metaPath(gid), obj);
    }

    // 2) timeline 模板
    const month = monthTag();
    const tlFile = path.join(GROUPS_DIR, gid, 'timeline', `${month}.md`);
    if (!fs.existsSync(tlFile)) {
      const name = readGroupMeta(gid)?.name ?? parsed(gid);
      const content = `# ${month} · ${name}\n\n## ${today()}\n- （v0.5 起由整理会话自动写入；现在留空）\n`;
      report.push(`+ groups/${gid}/timeline/${month}.md（模板）`);
      if (!dry) atomicWriteText(tlFile, content);
    }

    // 3) 旧版按群成员档 → 全局
    const oldDir = path.join(GROUPS_DIR, gid, 'members');
    if (fs.existsSync(oldDir)) {
      for (const f of fs.readdirSync(oldDir)) {
        if (!/^\d+\.json$/.test(f)) continue;
        const oldPath = path.join(oldDir, f);
        const migrated = migrateMemberFile(oldPath, gid);
        if (!migrated) continue;
        report.push(`→ groups/${gid}/members/${f} ⇒ members/${migrated.qq}.json`);
        if (!dry) {
          if (fs.existsSync(migrated.target)) backups.push(backupFile(migrated.target));
          atomicWriteJson(migrated.target, migrated.obj);
        }
      }
      if (!dry) {
        fs.rmSync(oldDir, { recursive: true, force: true });
        report.push(`- 删除旧目录 groups/${gid}/members/`);
      }
    }
  }

  // 4) persona
  for (const [file, content] of [
    ['base.md', null],
    ['dynamic.md', null]
  ]) {
    const p = path.join(PERSONA_DIR, file);
    if (!fs.existsSync(p)) report.push(`! persona/${file} 缺失（请手工补）`);
  }

  if (!report.length) {
    console.log('已经是 v0.4 结构，无需迁移。');
    return;
  }
  for (const line of report) console.log(line);
  if (backups.length) console.log(`\n备份：${backups.join(', ')}`);
  console.log(dry ? '\n（--dry：未写入）' : '\n迁移完成。');
}

const parsed = (gid) => readGroupMeta(gid)?.name ?? `群 ${gid}`;

// ── 命令：成员 ──────────────────────────────────────────────────────────────
function cmdMemberList() {
  const members = loadMembers(MEM_ROOT);
  if (!members.length) {
    console.log('还没有成员档（memory/members/*.json）');
    return;
  }
  console.log(`全局成员档 ${members.length} 个：`);
  for (const m of members) {
    const gs = Object.entries(m.groups ?? {})
      .map(([g, v]) => `${g}(${v?.relation || '未标关系'})`)
      .join(' ');
    const facts = (m.global?.facts?.length ?? 0) + Object.values(m.groups ?? {}).reduce((n, g) => n + (g?.facts?.length ?? 0), 0);
    console.log(`  ${m.qq}  ${m.displayName ?? ''}  事实 ${facts} 条  群：${gs || '-'}`);
  }
}

function cmdMemberAdd(qq, name, { force }) {
  if (!/^\d+$/.test(String(qq ?? ''))) throw new Error('用法：node memory.mjs member:add <QQ> <群名片> [--force]');
  const file = memberPath(qq);
  if (fs.existsSync(file) && !force) throw new Error(`已有档案：${file}（要覆盖加 --force）`);
  const obj = {
    schema: 3,
    factSchema: 3,
    qq: Number(qq),
    displayName: String(name ?? qq),
    aliases: [],
    global: { tags: [], traits: [], avoid: [], facts: [] },
    groups: {}
  };
  if (fs.existsSync(file)) backupFile(file);
  atomicWriteJson(file, obj);
  console.log(`已创建：${file}`);
}

function cmdMemberFact(qq, text, opts) {
  if (!/^\d+$/.test(String(qq ?? '')) || !text) {
    throw new Error('用法：node memory.mjs member:fact <QQ> "<事实>" [--scope group|global] [--group 群号] [--source 来源] [--confidence 0.9]');
  }
  const file = memberPath(qq);
  const obj = readJsonFile(file, null);
  if (!obj) throw new Error(`没有这个成员档：${file}（先 member:add）`);
  const scope = opts.scope === 'global' ? 'global' : 'group';
  const gid = String(opts.group ?? '');
  if (scope === 'group' && !gid) throw new Error('scope=group 时必须给 --group 群号');
  const confidence = Number(opts.confidence);
  const date = today();
  const fact = createFactRecord({
    memDir: MEM_ROOT,
    schema: Number(obj.schema) || 2,
    id: `f-${date.replace(/-/g, '')}-${String(scope === 'global' ? (obj.global?.facts?.length ?? 0) + 1 : (obj.groups?.[gid]?.facts?.length ?? 0) + 1).padStart(2, '0')}`,
    text: String(text),
    scope,
    groupId: gid,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.8
  });
  if (opts.source) fact.source = String(opts.source);
  if (scope === 'global') {
    obj.global = obj.global ?? { tags: [], traits: [], avoid: [], facts: [] };
    obj.global.facts = Array.isArray(obj.global.facts) ? obj.global.facts : [];
    obj.global.facts.unshift(fact);
  } else {
    obj.groups = obj.groups ?? {};
    obj.groups[gid] = obj.groups[gid] ?? { alias: '', relation: '', firstSeen: date, lastSeen: date, interactions: 0, facts: [] };
    obj.groups[gid].facts = Array.isArray(obj.groups[gid].facts) ? obj.groups[gid].facts : [];
    obj.groups[gid].facts.unshift(fact);
    obj.groups[gid].lastSeen = date;
  }
  backupFile(file);
  atomicWriteJson(file, obj);
  console.log(`已追加（${scope}${scope === 'group' ? `/${gid}` : ''}）→ ${file}`);
}

function cmdInit() {
  const configFile = path.join(MEM_REPO, 'config.json');
  const exampleFile = path.join(MEM_REPO, 'config.example.json');
  if (!fs.existsSync(configFile)) {
    if (!fs.existsSync(exampleFile)) throw new Error(`缺少示例配置：${exampleFile}`);
    fs.copyFileSync(exampleFile, configFile);
    console.log(`已创建配置：${configFile}`);
  } else {
    console.log(`保留现有配置：${configFile}`);
  }
  const cfg = loadMemoryConfig(MEM_REPO);
  const dirs = [
    cfg.dataDir,
    path.join(cfg.dataDir, 'groups'),
    path.join(cfg.dataDir, 'members'),
    path.join(cfg.dataDir, 'persona'),
    path.join(cfg.dataDir, 'logs'),
    path.join(cfg.dataDir, '.state', 'pending'),
    path.join(cfg.dataDir, '.state', 'audit'),
    path.join(cfg.dataDir, '.state', 'transactions'),
    path.join(cfg.dataDir, '.backups')
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  const templates = [
    [path.join(cfg.dataDir, 'persona', 'base.md'), '# 安全底线\n\n- 不泄露本地路径、凭据、令牌或其他会话的信息。\n'],
    [path.join(cfg.dataDir, 'persona', 'dynamic.md'), '# 动态人设\n\n']
  ];
  for (const [file, content] of templates) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8');
  }
  console.log(`数据目录已初始化：${cfg.dataDir}`);
  console.log('下一步：编辑 config.json 的 bridge.home，然后运行 node memory.mjs doctor。');
}

function cmdDoctor() {
  const rows = [];
  const add = (ok, label, detail = '') => rows.push({ ok: Boolean(ok), label, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major > 22 || (major === 22 && minor >= 13), 'Node.js >= 22.13', process.versions.node);
  const configFile = path.join(MEM_REPO, 'config.json');
  add(fs.existsSync(configFile), 'config.json', fs.existsSync(configFile) ? configFile : '先运行 node memory.mjs init');

  const cfg = loadMemoryConfig(MEM_REPO);
  add(fs.existsSync(cfg.dataDir), '数据目录', cfg.dataDir);
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const probe = path.join(cfg.dataDir, `.doctor-write-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    add(true, '数据目录可写', cfg.dataDir);
  } catch (error) {
    add(false, '数据目录可写', error?.message ?? String(error));
  }

  const bridge = inspectQQbridgeCompatibility(cfg);
  add(bridge.ok, `QQbridge（要求 >= ${QQBRIDGE_COMPATIBILITY.minimumVersion}）`, bridge.packageError || `${bridge.home}；检测版本 ${bridge.version || '未知'}`);
  for (const item of bridge.files) add(item.exists, `QQbridge/${item.relative}`, item.path);
  add(fs.existsSync(cfg.bridge.socialV2), 'social-v2 消息源', cfg.bridge.socialV2);
  add(fs.existsSync(cfg.bridge.sessions), 'QQ 会话绑定', cfg.bridge.sessions);
  add(fs.existsSync(cfg.bridge.consoleTokenFile), 'QQbridge 控制台令牌', cfg.bridge.consoleTokenFile);

  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  const profileDir = path.join(dshHome, 'profiles', profile);
  const pluginLink = path.join(profileDir, 'node_modules', 'dsh-memory');
  const cordis = path.join(profileDir, 'cordis.patch.yml');
  add(fs.existsSync(profileDir), `DSH profile (${profile})`, profileDir);
  add(fs.existsSync(pluginLink), 'DSH memory 插件链接', pluginLink);
  let registered = false;
  try { registered = fs.readFileSync(cordis, 'utf8').includes('=== dsh-memory BEGIN ==='); } catch {}
  add(registered, 'DSH cordis 注册', cordis);

  for (const row of rows) console.log(`${row.ok ? '✅' : '❌'} ${row.label}${row.detail ? ` — ${row.detail}` : ''}`);
  const failed = rows.filter((row) => !row.ok).length;
  console.log(`\n诊断结果：${rows.length - failed} 通过，${failed} 项待处理。`);
  if (failed) process.exitCode = 2;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') flags.dry = true;
    else if (a === '--recover') flags.recover = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--key') flags.key = argv[++i];
    else if (a === '--detail') flags.detail = argv[++i];
    else if (a === '--query') flags.query = argv[++i];
    else if (a === '--intent') flags.intent = argv[++i];
    else if (a === '--include-recent') flags.includeRecent = true;
    else if (a === '--limit') flags.limit = argv[++i];
    else if (a === '--state') flags.state = argv[++i];
    else if (a === '--scope') flags.scope = argv[++i];
    else if (a === '--group') flags.group = argv[++i];
    else if (a === '--source') flags.source = argv[++i];
    else if (a === '--confidence') flags.confidence = argv[++i];
    else if (a === '--threshold') flags.threshold = argv[++i];
    else if (a === '--days') flags.days = argv[++i];
    else if (a === '--observation-days') flags.observationDays = argv[++i];
    else if (a === '--limit') flags.limit = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function cmdMetrics(days = 7) {
  const cfg = MEM_CFG;
  const span = Math.max(1, Math.min(365, Number(days) || 7));
  const records = readMetrics(cfg.dataDir, { days: span, keepFiles: cfg.metrics.keepFiles });
  const s = summarizeMetrics(records);
  const u = s.consolidate.usage;
  console.log(`匿名运行指标（近 ${span} 天，共 ${records.length} 条）`);
  console.log(`记忆读取：${s.reads.total} 次；成功 ${s.reads.success}，拒绝 ${s.reads.denied}，失败 ${s.reads.failed}`);
  console.log(`  tiny/brief/full=${s.reads.tiny}/${s.reads.brief}/${s.reads.full}；成功平均 ${s.reads.avgChars} 字；裁剪 ${s.reads.truncated} 次；缓存复用 ${s.reads.cached} 次`);
  console.log(`后台整理：${s.consolidate.total} 次；成功 ${s.consolidate.success}，跳过 ${s.consolidate.skipped}，失败 ${s.consolidate.failed}（解析失败 ${s.consolidate.parseFailed}）`);
  console.log(`  送入整理模型 ${s.consolidate.rawMessages} 条（有效 ${s.consolidate.informativeMessages}）；当前 pending ${s.consolidate.pendingDepth} 条`);
  console.log(`  时间线 +${s.consolidate.timelinePoints}；事实 +${s.consolidate.memberFacts}；日期钳制 ${s.consolidate.dateClamped}`);
  console.log(`  整理会话退役：batch ${s.consolidate.sessionRetired?.batches ?? 0} / step ${s.consolidate.sessionRetired?.steps ?? 0} / token ${s.consolidate.sessionRetired?.tokens ?? 0}`);
  console.log(`  token：未命中 ${u.cacheMiss}，缓存命中 ${u.cacheHit}，缓存写入 ${u.cacheWrite}，输出 ${u.output}，推理 ${u.reasoning}`);
}

function cmdPending(key = '') {
  const print = (queue) => {
    const decision = evaluatePendingTrigger(queue, MEM_CFG.consolidate);
    const levels = queue.pending.reduce((out, item) => {
      out[item.level] = (out[item.level] ?? 0) + 1;
      return out;
    }, {});
    const oldest = queue.pending.length ? Math.min(...queue.pending.map((item) => Number(item.enqueuedAt) || Date.now())) : 0;
    console.log(
      `${queue.key}  gen=${queue.generation} scan=${queue.scan.seq} pending=${queue.pending.length}`
      + `（normal=${levels.normal ?? 0}, important=${levels.important ?? 0}）`
      + ` inflight=${queue.inflight?.batchId ?? '-'} failures=${queue.failures.count}`
      + ` next=${decision.ready ? decision.trigger : decision.reason}`
      + `${oldest ? ` oldest=${Math.round((Date.now() - oldest) / 60000)}m` : ''}`
    );
  };
  if (key) return print(readPendingQueue(MEM_ROOT, key));
  const dir = path.join(MEM_ROOT, '.state', 'pending');
  let files = [];
  try { files = fs.readdirSync(dir).filter((file) => /^(?:group|private)-\d+\.json$/.test(file)).sort(); } catch {}
  if (!files.length) return console.log('还没有 pending 队列（worker 升级后扫描一次才会创建）。');
  for (const file of files) {
    const queue = readJsonFile(path.join(dir, file), null);
    if (queue?.key) print(queue);
  }
}

function cmdMigrateSchema3({ dry = false, observationDays = MEM_CFG.facts.observationDays } = {}) {
  const days = Math.max(1, Math.min(90, Number(observationDays) || MEM_CFG.facts.observationDays));
  const result = migrateMembersToSchema3({ memDir: MEM_ROOT, dry, observationDays: days });
  console.log(`schema 2→3：扫描 ${result.scanned}，迁移 ${result.migrated}，跳过 ${result.skipped}${dry ? '（--dry 未写入）' : ''}`);
  if (result.migrated) console.log(`${dry ? '计划备份到' : '迁移前备份'}：${result.backupDir}`);
  if (!dry && result.migrated) console.log(`旧字段兼容写入观察期：${days} 天；到期后 schema 3 自动停止写 date/source/scope。`);
}

function cmdToolUsage({ apply = false, days = 30 } = {}) {
  const bridgeConfigFile = path.join(MEM_CFG.bridge.home, 'config.json');
  const bridgeConfig = readJsonFile(bridgeConfigFile, {}) || {};
  const report = analyzeToolUsage({
    stateDir: path.dirname(MEM_CFG.bridge.socialV2),
    days: Math.max(1, Number(days) || 30),
    minObservationDays: MEM_CFG.toolUsage.observationDays,
    minTotalCalls: MEM_CFG.toolUsage.minTotalCalls,
    enabledFlags: bridgeConfig.socialV2?.tools ?? {}
  });
  const reportFile = writeToolUsageReport(MEM_ROOT, report);
  console.log(`工具调用：${report.totalCalls} 次 / ${report.sessions} 会话 / 观察跨度 ${report.observedDays} 天`);
  for (const [tool, row] of Object.entries(report.byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 20)) {
    console.log(`  ${String(row.calls).padStart(5)}  ${tool}  success=${row.success} failed=${row.failed}`);
  }
  console.log(`裁剪判定：${report.decision}（门槛 ${report.thresholds.minObservationDays} 天且 ${report.thresholds.minTotalCalls} 次）`);
  console.log(`候选开关：${report.candidates.join(', ') || '无'}；报告：${reportFile}`);
  if (apply) {
    const result = applyToolPrunePlan({ memDir: MEM_ROOT, bridgeConfigFile, report });
    console.log(`已关闭 ${result.changed} 个工具开关${result.backup ? `；桥接配置备份：${result.backup}` : ''}`);
  }
}

const HELP = `记忆库工具 v0.11.4

  node memory.mjs init
  node memory.mjs doctor
  node memory.mjs status
  node memory.mjs metrics [--days 7]
  node memory.mjs tool-usage [--days 30] [--apply]
  node memory.mjs pending [--key group:1234567890]
  node memory.mjs sync [--dry]
  node memory.mjs context --key group:1234567890 [--query "上次发生什么"] [--intent auto] [--detail tiny|brief|full] [--include-recent]
  node memory.mjs migrate [--dry]
  node memory.mjs migrate:schema3 [--dry] [--observation-days 14]
  node memory.mjs audit [--limit 15]
  node memory.mjs rollback [审计ID|latest]
  node memory.mjs transactions [--recover]
  node memory.mjs dedupe [--threshold 0.8] [--dry]
  node memory.mjs member:list
  node memory.mjs member:add <QQ> <群名片> [--force]
  node memory.mjs member:fact <QQ> "<事实>" [--scope group|global] [--group 群号] [--source 来源] [--confidence 0.9]

群档写在哪：groups/<群号>/profile.md 的 <!-- boot:start --> … <!-- boot:end -->（≤300 字）
成员档：members/<QQ>.json（schema 3；读取兼容 schema 2）
`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);
  const cmd = rest[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'init') return cmdInit();
  if (cmd === 'doctor') return cmdDoctor();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'metrics') return cmdMetrics(flags.days);
  if (cmd === 'tool-usage') return cmdToolUsage({ apply: Boolean(flags.apply), days: flags.days });
  if (cmd === 'pending') return cmdPending(flags.key);
  if (cmd === 'sync') return cmdSync({ dry: Boolean(flags.dry) });
  if (cmd === 'context') return cmdContext(flags);
  if (cmd === 'migrate') return cmdMigrate({ dry: Boolean(flags.dry) });
  if (cmd === 'migrate:schema3') return cmdMigrateSchema3({ dry: Boolean(flags.dry), observationDays: flags.observationDays });
  if (cmd === 'audit') return cmdAudit(Number(flags.limit) || 15);
  if (cmd === 'rollback') return cmdRollback(rest[1]);
  if (cmd === 'transactions') return cmdTransactions({ recover: Boolean(flags.recover) });
  if (cmd === 'dedupe') return cmdDedupe({ threshold: flags.threshold, dry: Boolean(flags.dry) });
  if (cmd === 'member:list') return cmdMemberList();
  if (cmd === 'member:add') return cmdMemberAdd(rest[1], rest[2], flags);
  if (cmd === 'member:fact') return cmdMemberFact(rest[1], rest[2], flags);
  throw new Error(`未知命令：${cmd}\n\n${HELP}`);
}

main().catch((error) => {
  console.error('错误：' + (error?.message ?? error));
  process.exitCode = 1;
});

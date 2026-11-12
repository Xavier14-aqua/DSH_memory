// 记忆库上下文组装（v0.10.0）：作用域过滤 → 本地检索 → 分区预算。
//
// 被两处调用：
//   1) memory.mjs context  —— 本地预览/调试
//   2) DSH 插件 memory_context
//
// 设计约束：
//   - 只读文件，不写任何东西；运行期数据（消息窗口）由调用方传入，本模块不碰 social-v2.json。
//   - 只返回「当前会话 + 全局公开」的信息，绝不读别的群的内容。
//   - 输出是纯文本，按优先级拼装，超预算时从低优先级开始整段丢弃。
import fs from 'node:fs';
import path from 'node:path';
import { mentionedMemberIds, rankMemoryCandidates } from './retrieval.mjs';
import { normalizeMemberFacts } from './facts.mjs';

// ── 小工具 ──────────────────────────────────────────────────────────────────
export function readTextFile(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return fallback;
  }
}

export function readJsonFile(file, fallback = null) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const normalize = (s) =>
  String(s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const isPlaceholder = (line) => /^_待补充|^_（|^_\(/.test(String(line).trim());

// ── 解析 ────────────────────────────────────────────────────────────────────
export function parseKey(key) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1], id: m[2] };
}

/** 取 profile.md 里 <!-- boot:start --> … <!-- boot:end --> 之间的内容 */
export function extractBootBlock(markdown) {
  const md = String(markdown ?? '').replace(/\r\n/g, '\n');
  const m = /<!--\s*boot:start\s*-->([\s\S]*?)<!--\s*boot:end\s*-->/.exec(md);
  return m ? normalize(m[1]) : '';
}

/** 按 `## 标题` 取小节正文，跳过 _待补充_ 占位行 */
export function extractSection(markdown, keywords) {
  const md = String(markdown ?? '').replace(/\r\n/g, '\n');
  const sections = md.split(/^##\s+/m).slice(1);
  const out = [];
  for (const sec of sections) {
    const title = sec.split('\n')[0].trim();
    if (!keywords.some((k) => title.includes(k))) continue;
    const body = sec
      .split('\n')
      .slice(1)
      .filter((line) => !isPlaceholder(line))
      .join('\n');
    const clean = normalize(body);
    if (clean) out.push(clean);
  }
  return out.join('\n');
}

export function loadMembers(memDir) {
  const dir = path.join(memDir, 'members');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue;
    const m = readJsonFile(path.join(dir, e.name), null);
    if (m && typeof m === 'object') out.push(normalizeMemberFacts(m));
  }
  return out;
}

function findMember(members, { qq, name }) {
  const byQQ = members.find((m) => String(m.qq) === String(qq));
  if (byQQ) return byQQ;
  // userId/QQ 是可信身份；存在时绝不能因同名/同群名片回落到另一个人的档案。
  if (String(qq ?? '').trim()) return null;
  if (!name) return null;
  return (
    members.find((m) => m.displayName === name) ||
    members.find((m) => Array.isArray(m.aliases) && m.aliases.includes(name)) ||
    members.find((m) => m.groups && Object.values(m.groups).some((g) => g?.alias === name)) ||
    null
  );
}

function memberFactsForGroup(member, gid, limit) {
  if (!member) return [];
  const facts = [];
  const globalFacts = Array.isArray(member.global?.facts) ? member.global.facts : [];
  for (const f of globalFacts) {
    if (String(f?.scope ?? 'global') === 'global' && (f.status ?? 'active') === 'active') facts.push(f);
  }
  const groupFacts = gid && member.groups?.[gid]?.facts;
  if (Array.isArray(groupFacts)) {
    for (const f of groupFacts) {
      if ((f.status ?? 'active') === 'active') facts.push(f);
    }
  }
  // 新→旧
  facts.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const t = String(f?.text ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

/** 读最近几天的 timeline（跨月时会读上一个月） */
export function readTimeline(memDir, gid, { days = 2, now = Date.now(), maxPoints = 5 } = {}) {
  if (!gid) return { days: [], month: '' };
  const current = new Date(now);
  const months = [];
  for (let i = 0; i < 2; i += 1) {
    const d = new Date(current.getFullYear(), current.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const collected = [];
  for (const month of months) {
    const md = readTextFile(path.join(memDir, 'groups', gid, 'timeline', `${month}.md`));
    if (!md) continue;
    const blocks = md.split(/^##\s+/m).slice(1);
    for (const block of blocks) {
      const lines = block.split('\n');
      const date = lines[0].trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const points = lines
        .slice(1)
        .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
        .filter((l) => l && !isPlaceholder(l) && !/^（v0\.5/.test(l));
      if (points.length) collected.push({ date, points: points.slice(0, maxPoints) });
    }
    if (collected.length >= days) break;
  }
  collected.sort((a, b) => b.date.localeCompare(a.date));
  return { days: collected.slice(0, days) };
}

export function readDynamicPersona(memDir) {
  const md = readTextFile(path.join(memDir, 'persona', 'dynamic.md'));
  if (!md) return '';
  const lines = md
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))        // 标题
    .filter((l) => !/^\s*>/.test(l))        // 说明用的引用块
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l && !isPlaceholder(l))
    // 模板占位（"最近口头禅：（待生成）"）不算内容
    .filter((l) => !/（待生成）|\(待生成\)|^更新时间/.test(l));
  const text = normalize(lines.join('\n'));
  return text;
}

function formatClock(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function readAllTimelinePoints(memDir, gid) {
  if (!gid) return [];
  const dir = path.join(memDir, 'groups', gid, 'timeline');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const file of files.slice(0, 12)) {
    const md = readTextFile(path.join(dir, file));
    for (const block of md.split(/^##\s+/m).slice(1)) {
      const lines = block.split('\n');
      const date = lines[0].trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      for (const line of lines.slice(1)) {
        const text = line.replace(/^\s*[-*]\s*/, '').trim();
        if (text && !isPlaceholder(text) && !/^（v0\.5/.test(text)) out.push({ date, text });
      }
    }
  }
  return out;
}

function queryFromMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-3)
    .map((m) => String(m?.text ?? m?.plain ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function aliasesOf(member, gid) {
  return [member?.displayName, ...(Array.isArray(member?.aliases) ? member.aliases : []), gid && member?.groups?.[gid]?.alias]
    .map((s) => String(s ?? '').trim()).filter(Boolean);
}

function scopedFacts(member, gid) {
  const out = [];
  for (const fact of member?.global?.facts ?? []) {
    if (String(fact?.scope ?? 'global') === 'global') out.push({ ...fact, scope: 'global' });
  }
  if (gid) for (const fact of member?.groups?.[gid]?.facts ?? []) out.push({ ...fact, scope: 'group', groupId: gid });
  return out;
}

function fitSection(title, rows, budget) {
  const cap = Math.max(0, Math.floor(Number(budget) || 0));
  if (!rows.length || cap <= title.length + 2) return { text: '', count: 0, dropped: rows.length };
  let text = title;
  let count = 0;
  for (const row of rows) {
    const prefix = '\n';
    const room = cap - text.length - prefix.length;
    if (room < 8) break;
    const line = String(row);
    text += prefix + (line.length > room ? line.slice(0, Math.max(1, room - 1)) + '…' : line);
    count += 1;
    if (line.length > room) break;
  }
  return { text, count, dropped: Math.max(0, rows.length - count) };
}

function allocateBudgets(total, requested) {
  const names = Object.keys(requested).filter((name) => requested[name] > 0);
  const available = Math.max(0, total - 70 - Math.max(0, names.length - 1));
  const requestedTotal = names.reduce((n, name) => n + requested[name], 0) || 1;
  const scale = Math.min(2, available / requestedTotal);
  return Object.fromEntries(names.map((name) => [name, Math.max(24, Math.floor(requested[name] * scale))]));
}

/** 作用域过滤永远发生在 rankMemoryCandidates 之前。 */
export function buildContext({
  memDir,
  key,
  query = '',
  intent = 'auto',
  detail = 'brief',
  includeRecent = false,
  limit = 12,
  messages = [],
  maxChars = 650,
  sectionBudgets = {},
  now = Date.now()
} = {}) {
  const parsed = parseKey(key);
  const emptyStats = { memberFacts: 0, timelinePoints: 0, messageCount: 0, cacheHit: false };
  if (!memDir || !parsed) return { text: '【记忆库】会话标识无效，按当前提示词回答即可。', chars: 30, truncated: false, dropped: [], sections: {}, stats: emptyStats, retrieval: { intent: 'general', candidates: 0, selected: 0 } };

  const mode = ['tiny', 'brief', 'full'].includes(detail) ? detail : 'brief';
  // 生产配置最小 200；测试/诊断仍允许显式给更小预算，保持旧 CLI 契约。
  const totalBudget = Math.max(50, Math.min(4000, Number(maxChars) || 650));
  const winLimit = Math.min(30, Math.max(1, Number(limit) || 12));
  const gid = parsed.kind === 'group' ? parsed.id : null;
  const allMessages = Array.isArray(messages) ? messages : [];
  const effectiveQuery = String(query ?? '').trim() || queryFromMessages(allMessages);
  const members = loadMembers(memDir);
  const lastIncoming = [...allMessages].reverse().find((m) => m && !m.isSelf);
  const speaker = lastIncoming ? { name: String(lastIncoming.sender ?? ''), qq: String(lastIncoming.userId ?? '') } : null;
  const speakerMember = speaker ? findMember(members, { qq: speaker.qq, name: speaker.name }) : null;
  const mentionPool = gid ? members.filter((member) => member?.groups?.[gid]) : members;
  const mentioned = mentionedMemberIds(mentionPool, effectiveQuery, gid);
  const allowedIds = new Set(mentioned);
  if (speakerMember?.qq) allowedIds.add(String(speakerMember.qq));
  // 私聊只允许该私聊对象的全局事实；群聊只允许当前说话人和查询明确点名的人。
  if (parsed.kind === 'private') {
    allowedIds.clear();
    allowedIds.add(parsed.id);
  }

  let groupMeta = null;
  let profile = '';
  if (gid) {
    groupMeta = readJsonFile(path.join(memDir, 'groups', gid, 'meta.json'), null);
    profile = readTextFile(path.join(memDir, 'groups', gid, 'profile.md'));
  }
  const candidates = [];
  if (gid) {
    const bootLines = extractBootBlock(profile).split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^【本群】/.test(line) && !/memory_context|先调|调用.*记忆/.test(line));
    for (const text of bootLines) candidates.push({ type: 'rule', text, scope: 'group', groupId: gid, importance: 1, confidence: 1 });
    const taboo = extractSection(profile, ['忌讳']);
    if (taboo) candidates.push({ type: 'rule', text: `忌讳：${taboo}`, scope: 'group', groupId: gid, importance: 1, confidence: 1 });
    const vibe = extractSection(profile, ['群定位', '氛围', '常见梗']);
    if (vibe) candidates.push({ type: 'vibe', text: vibe, scope: 'group', groupId: gid, importance: 0.6, confidence: 1 });
    for (const point of readAllTimelinePoints(memDir, gid)) candidates.push({ type: 'timeline', ...point, scope: 'group', groupId: gid, importance: 0.6, confidence: 0.8 });
  }

  for (const member of members) {
    const memberId = String(member?.qq ?? '');
    if (!allowedIds.has(memberId)) continue;
    const aliases = aliasesOf(member, gid);
    const label = member?.groups?.[gid]?.alias || member?.displayName || aliases[0] || '成员';
    const relation = gid ? String(member?.groups?.[gid]?.relation ?? '') : '';
    const tags = (Array.isArray(member?.global?.tags) ? member.global.tags : []).slice(0, 4).map(String);
    const profileBits = [relation && `关系：${relation}`, tags.length && `标签：${tags.join('、')}`, member?.owner === true && '管理员本人'].filter(Boolean);
    if (profileBits.length) candidates.push({ type: relation ? 'relationship' : 'member', text: profileBits.join('｜'), label, memberId, aliases, relation, scope: gid ? 'group' : 'global', groupId: gid, importance: 0.8, confidence: 1 });
    for (const fact of scopedFacts(member, gid)) {
      const relationship = /关系|吵架|和好|冷战|朋友|熟人|对象|同学|同事/.test(String(fact.text ?? ''));
      candidates.push({ ...fact, type: relationship ? 'relationship' : 'member', label, memberId, aliases, relation });
    }
  }

  const persona = readDynamicPersona(memDir);
  if (persona) candidates.push({ type: 'persona', text: persona, importance: 0.4, confidence: 1 });
  const ranked = rankMemoryCandidates({ candidates, query: effectiveQuery, intent, detail: mode, speakerId: speakerMember?.qq ?? speaker?.qq ?? '', mentionedIds: mentioned, gid, now });

  const selected = ranked.selected;
  const rules = selected.filter((c) => c.type === 'rule' || c.type === 'vibe').map((c) => `· ${clip(c.text, mode === 'full' ? 180 : 100)}`);
  const memberRows = selected.filter((c) => c.type === 'member' || c.type === 'relationship').map((c) => `· ${c.label || '成员'}：${clip(c.text, mode === 'full' ? 100 : 70)}`);
  const timelineRows = selected.filter((c) => c.type === 'timeline').map((c) => `· ${String(c.date ?? '').slice(5)}：${clip(c.text, mode === 'full' ? 120 : 80)}`);
  const personaRows = selected.filter((c) => c.type === 'persona').map((c) => `· ${clip(c.text, mode === 'full' ? 180 : 90)}`);
  const window = includeRecent ? allMessages.slice(-winLimit) : [];
  const recentRows = window.map((m) => `· ${formatClock(m.time)} ${m.isSelf ? '你' : String(m.sender ?? '?')}：${clip(m.text ?? m.plain ?? '', mode === 'full' ? 100 : 60)}`);

  const baseBudgets = {
    rules: Number(sectionBudgets.rulesChars) || 100,
    member: Number(sectionBudgets.memberChars) || 260,
    timeline: Number(sectionBudgets.timelineChars) || 220,
    persona: Number(sectionBudgets.personaChars) || 70,
    recent: includeRecent ? (Number(sectionBudgets.recentChars) || 180) : 0
  };
  const budgets = allocateBudgets(totalBudget, baseBudgets);
  const built = [
    ['规矩/群情', fitSection('【规矩/群情】', rules, budgets.rules)],
    ['人物', fitSection('【人物】', memberRows, budgets.member)],
    ['时间线', fitSection('【时间线】', timelineRows, budgets.timeline)],
    ['动态人设', fitSection('【现在的你】', personaRows, budgets.persona)],
    ['消息', fitSection(`【最近 ${window.length} 条】`, recentRows, budgets.recent)]
  ];
  const groupName = groupMeta?.name || (gid ? '当前群' : '');
  const header = gid ? `【群】${groupName}` : '【会话】私聊';
  const sections = [{ name: '会话', text: header }, ...built.filter(([, part]) => part.text).map(([name, part]) => ({ name, text: part.text }))];
  const dropped = built.filter(([, part]) => part.dropped > 0).map(([name]) => name);
  let text = sections.map((section) => section.text).join('\n');
  if (text.length > totalBudget) {
    text = text.slice(0, totalBudget - 1) + '…';
    dropped.push('硬截断');
  }
  const part = (name) => built.find(([n]) => n === name)?.[1];
  return {
    text,
    chars: text.length,
    truncated: dropped.length > 0,
    dropped,
    sections: Object.fromEntries(sections.map((section) => [section.name, section.text.length])),
    stats: {
      memberFacts: part('人物')?.count ?? 0,
      timelinePoints: part('时间线')?.count ?? 0,
      messageCount: part('消息')?.count ?? 0,
      cacheHit: false
    },
    retrieval: { intent: ranked.intent, candidates: candidates.length, selected: selected.length, mentionedMembers: mentioned.size }
  };
}

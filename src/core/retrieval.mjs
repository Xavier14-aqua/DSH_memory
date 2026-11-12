// v0.10.0 本地记忆检索：先做作用域过滤，再做意图识别、评分、近重复去除和 Top-K。
// 本模块不读写文件，候选必须由 context.mjs 按当前会话范围构造后传入。

export const INTENTS = Object.freeze(['auto', 'member', 'timeline', 'rules', 'relationship', 'general']);

const STOP_WORDS = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '一下', '一个', '我们', '你们', '他们', '她们',
  '是不是', '有没有', '可以', '还是', '就是', '然后', '现在', '今天', '这里', '那里', '知道',
  'the', 'and', 'that', 'with', 'this', 'from'
]);

const INTENT_PATTERNS = [
  ['rules', /群规|规矩|忌讳|雷区|能不能|可不可以|允许|禁止|别提|话题|该不该/],
  ['timeline', /上次|之前|以前|过去|当时|后来|发生|哪天|什么时候|最近|还记得|为什么.*(?:生气|难过|走|退)/],
  ['relationship', /关系|熟不熟|认识|吵架|闹翻|和好|冷战|站队|喜欢谁|讨厌谁/],
  ['member', /是谁|什么人|喜欢|讨厌|习惯|爱好|职业|工作|性格|生日|住哪|在哪|他|她|这人/]
];

// “还记得我什么”说的是当前人物画像，不是群事件时间线。必须在通用 timeline
// 规则之前判定，否则私聊没有 timeline 候选时会把本人的全部事实过滤掉。
const SELF_MEMORY_MEMBER = /(?:还?记得我(?:什么|哪些|多少|吗)?|对我(?:有)?什么印象|对我的印象|了解我(?:什么|多少)?|关于我(?:知道|记得)?什么|去(?:记忆)?库里(?:翻|查|看)|翻翻(?:记忆)?库)/;

export function inferIntent(query, requested = 'auto') {
  const explicit = String(requested ?? 'auto').toLowerCase();
  if (INTENTS.includes(explicit) && explicit !== 'auto') return explicit;
  const text = String(query ?? '').trim();
  if (SELF_MEMORY_MEMBER.test(text)) return 'member';
  for (const [intent, re] of INTENT_PATTERNS) if (re.test(text)) return intent;
  return 'general';
}

export function extractTerms(value) {
  const text = String(value ?? '').toLowerCase()
    .replace(/能不能|可不可以|有没有|是不是|为什么|上次|之前|以前|过去|当时|后来|发生|最近|还记得|群规|规矩|忌讳|雷区|关系|是谁/g, ' ')
    .replace(/\s+/g, ' ');
  const terms = new Set();
  for (const token of text.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(token)) terms.add(token);
  }
  for (const chunk of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (!STOP_WORDS.has(chunk) && chunk.length <= 8) terms.add(chunk);
    for (let i = 0; i + 1 < chunk.length; i += 1) {
      const pair = chunk.slice(i, i + 2);
      if (!STOP_WORDS.has(pair)) terms.add(pair);
    }
  }
  return terms;
}

function aliasesOf(member, gid) {
  return [
    String(member?.qq ?? ''),
    String(member?.displayName ?? ''),
    ...(Array.isArray(member?.aliases) ? member.aliases.map(String) : []),
    String(gid && member?.groups?.[gid]?.alias || '')
  ].map((s) => s.trim()).filter(Boolean);
}

export function mentionedMemberIds(members, query, gid) {
  const text = String(query ?? '').toLowerCase();
  const found = new Set();
  for (const member of Array.isArray(members) ? members : []) {
    for (const alias of aliasesOf(member, gid)) {
      const normalized = alias.toLowerCase();
      if ((/^\d+$/.test(normalized) || normalized.length >= 2) && text.includes(normalized)) {
        found.add(String(member.qq));
        break;
      }
    }
  }
  return found;
}

function dateMs(value) {
  const n = Date.parse(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function freshScore(value, now) {
  const at = dateMs(value);
  if (!at) return 0;
  const days = Math.max(0, (now - at) / 86_400_000);
  if (days <= 7) return 15;
  if (days <= 30) return 12;
  if (days <= 180) return 8;
  if (days <= 365) return 4;
  return 0;
}

function overlapScore(queryTerms, text) {
  if (!queryTerms.size) return 0;
  const candidateTerms = extractTerms(text);
  let hits = 0;
  for (const term of queryTerms) if (candidateTerms.has(term)) hits += 1;
  return Math.min(30, hits * 8);
}

function bigrams(value) {
  const text = String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

export function textSimilarity(a, b) {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (!aa.size || !bb.size) return String(a).trim() === String(b).trim() ? 1 : 0;
  let common = 0;
  for (const pair of aa) if (bb.has(pair)) common += 1;
  return (2 * common) / (aa.size + bb.size);
}

function activeCandidate(candidate, now) {
  if (!candidate || !String(candidate.text ?? '').trim()) return false;
  if (String(candidate.status ?? 'active') !== 'active') return false;
  if (candidate.supersededBy) return false;
  const expires = dateMs(candidate.expiresAt);
  return !expires || expires > now;
}

function scoreCandidate(candidate, { query, queryTerms, intent, speakerId, mentionedIds, gid, now }) {
  let score = overlapScore(queryTerms, candidate.text);
  const memberId = String(candidate.memberId ?? '');
  if (memberId && memberId === speakerId) score += 50;
  if (memberId && mentionedIds.has(memberId)) score += 40;
  if (candidate.aliases?.some((alias) => String(alias).length >= 2 && String(query).toLowerCase().includes(String(alias).toLowerCase()))) score += 40;
  if (candidate.scope === 'group' && String(candidate.groupId ?? '') === String(gid ?? '')) score += 10;
  score += freshScore(candidate.date ?? candidate.createdAt, now);
  const importance = candidate.importance == null ? 0.5 : Number(candidate.importance);
  const confidence = candidate.confidence == null ? 0.5 : Number(candidate.confidence);
  score += Math.round(Math.max(0, Math.min(1, Number.isFinite(importance) ? importance : 0.5)) * 10);
  score += Math.round(Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5)) * 10);

  const typeIntent = {
    member: 'member',
    timeline: 'timeline',
    rule: 'rules',
    relationship: 'relationship'
  }[candidate.type];
  if (intent !== 'general' && typeIntent === intent) score += 30;
  if (intent === 'relationship' && candidate.type === 'member' && candidate.relation) score += 20;
  if (intent === 'general') {
    if (candidate.type === 'member') score += 8;
    if (candidate.type === 'rule') score += 5;
  }
  const ageDays = candidate.date ? (now - dateMs(candidate.date)) / 86_400_000 : 0;
  if (Number(candidate.confidence) > 0 && Number(candidate.confidence) < 0.5 && ageDays > 180) score -= 20;
  return score;
}

const LIMITS = {
  tiny: { member: 2, timeline: 1, rule: 1, relationship: 1, persona: 1, vibe: 1 },
  brief: { member: 5, timeline: 3, rule: 2, relationship: 2, persona: 1, vibe: 1 },
  full: { member: 8, timeline: 5, rule: 2, relationship: 3, persona: 1, vibe: 1 }
};

/**
 * 候选已经过调用方的作用域过滤；这里绝不把被过滤掉的候选重新找回来。
 */
export function rankMemoryCandidates({ candidates = [], query = '', intent = 'auto', detail = 'brief', speakerId = '', mentionedIds = new Set(), gid = '', now = Date.now() } = {}) {
  const resolvedIntent = inferIntent(query, intent);
  const queryTerms = extractTerms(query);
  const limits = LIMITS[detail] ?? LIMITS.brief;
  const scored = candidates
    .filter((candidate) => activeCandidate(candidate, now))
    .map((candidate, order) => {
      const lexical = overlapScore(queryTerms, candidate.text);
      return {
        ...candidate,
        score: scoreCandidate(candidate, { query, queryTerms, intent: resolvedIntent, speakerId: String(speakerId), mentionedIds, gid, now }),
        _lexical: lexical,
        _order: order
      };
    })
    .sort((a, b) => b.score - a.score || freshScore(b.date, now) - freshScore(a.date, now) || a._order - b._order);

  const counts = new Map();
  const selected = [];
  for (const candidate of scored) {
    const expected = { member: 'member', relationship: 'relationship', timeline: 'timeline', rule: 'rules' }[candidate.type];
    if (resolvedIntent !== 'general' && expected && expected !== resolvedIntent && candidate._lexical === 0) {
      const namedPerson = (candidate.type === 'member' || candidate.type === 'relationship') && mentionedIds.has(String(candidate.memberId ?? ''));
      if (!namedPerson) continue;
    }
    if (resolvedIntent !== 'general' && (candidate.type === 'persona' || candidate.type === 'vibe') && candidate._lexical === 0) continue;
    const bucket = candidate.type === 'relationship' ? 'member' : candidate.type;
    if ((counts.get(bucket) ?? 0) >= (limits[bucket] ?? 0)) continue;
    if (selected.some((prior) => prior.type === candidate.type && textSimilarity(prior.text, candidate.text) >= 0.82)) continue;
    selected.push(candidate);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return { intent: resolvedIntent, selected };
}

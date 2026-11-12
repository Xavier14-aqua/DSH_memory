// DSH 插件：把长期记忆以一个只读工具 `memory_context` 暴露给 QQ 会话。
//
// 为什么是插件而不是 MCP：
//   MCP 进程是所有会话共用的，拿不到"这次调用来自哪个会话"；
//   而插件工具的 execute(args, exec) 里 exec.agent.id 是 DSH 给的**可信会话 ID**，
//   模型既看不到也改不了，天然满足"群会话只能读本群"的要求。
//
// 注册方式（阶段 2 才会做）：
//   在 ~/.dsh/profiles/desktop/cordis.patch.yml 里 insert 一行，指向本文件。
//   该插件是全局的；非 QQ 会话调用它会拿到"不在记忆库范围内"。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildContext } from '../core/context.mjs';
import { loadMemoryConfig } from '../core/config.mjs';
import { anonymizeConversation, appendMetric } from '../core/metrics.mjs';
import { readMessages, readSessions } from '../source/social-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const name = 'memory';
export const inject = ['tools'];

/** qqb-g-1234567890-<32hex> / qqb-p-9876543210-<32hex> */
const SESSION_ID_RE = /^qqb-(g|p)-(\d{1,20})-[0-9a-f]{32}$/i;

/**
 * 从可信会话 ID 解出 conversationKey，并用 sessions.json 复核。
 * 复核的目的：防止有人手工创建 qqb-g-<别的群号>-xxxx 的会话来读别人的群。
 * @returns {{ key: string } | { error: string }}
 */
function resolveKey(sessionId) {
  const m = SESSION_ID_RE.exec(String(sessionId ?? ''));
  if (!m) return { error: 'not-qq-session' };
  const key = `${m[1].toLowerCase() === 'g' ? 'group' : 'private'}:${m[2]}`;
  return { key };
}

function verifyAgainstBridge(cfg, sessionId, key) {
  const { sessions, error } = readSessions(cfg.bridge.sessions);
  // 身份复核必须失败关闭：sessions.json 是桥接签发会话身份的唯一可信绑定。
  // 文件缺失、损坏或正处于替换窗口时宁可暂时不提供记忆，也不能只凭可伪造的
  // qqb-g/qqb-p 外形放行跨群读取。
  if (error) return { ok: false, reason: 'sessions-unavailable' };
  const bound = String(sessions?.[key] ?? '');
  if (!bound) return { ok: false, reason: 'unbound' };
  if (bound !== String(sessionId)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

const NOT_IN_SCOPE = '当前会话不在记忆库范围内。按提示词正常聊天即可，不要编造别人的信息。';
const contextCache = new Map();

function memoryVersion(memDir, key) {
  const m = /^(group|private):(\d+)$/.exec(String(key));
  const files = [path.join(memDir, 'persona', 'dynamic.md')];
  if (m?.[1] === 'group') {
    files.push(path.join(memDir, 'groups', m[2], 'profile.md'), path.join(memDir, 'groups', m[2], 'meta.json'));
    try {
      for (const file of fs.readdirSync(path.join(memDir, 'groups', m[2], 'timeline')).sort()) files.push(path.join(memDir, 'groups', m[2], 'timeline', file));
    } catch {}
  }
  try {
    for (const file of fs.readdirSync(path.join(memDir, 'members')).sort()) if (/^\d+\.json$/.test(file)) files.push(path.join(memDir, 'members', file));
  } catch {}
  return files.map((file) => {
    try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return '-'; }
  }).join('|');
}

function getCached(key) {
  const hit = contextCache.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    if (hit) contextCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value, cfg) {
  contextCache.set(key, { value, expiresAt: Date.now() + cfg.context.cacheTtlMs });
  while (contextCache.size > cfg.context.cacheEntries) contextCache.delete(contextCache.keys().next().value);
}

export function apply(ctx, config = {}) {
  const memDir = path.resolve(String(config.memDir || REPO));

  ctx.tools.register({
    name: 'memory_context',
    description:
      '按需检索当前会话的长期记忆（只读）。【回复前强制调用】只要用户询问自己或任何其他人的身份、关系、印象、旧称、经历或历史事件，'
      + '例如“你记得X吗”“认识X吗”“X是谁”“对X什么印象”“X干过什么”“上次X怎么了”“还记得那件事吗”，都必须先调用；提问者是谁不影响调用。'
      + '把用户原问题原样放进 query；人物问题用 intent=member，事件经过用 timeline，不确定就用 auto。'
      + '用户问“你对我有什么印象”“还记得我什么”“了解我多少”，或明确要求“去库里翻翻/查记忆库”时同样必须先调用。'
      + '在工具返回前，禁止直接回答“不记得/不知道/没印象”，也不得只凭近期聊天猜测；工具无结果后才可如实说没有记录。不得声称查过却不调用。'
      + '普通问候、表情、简单问答和确定不依赖历史的聊天不要调用。'
      + '同一条用户消息对相同 query 最多调用一次；通过 qq_wait_for_messages 收到新的用户消息后，若新问题依赖记忆，可以再次调用。返回内容已做作用域过滤、相关性排序和预算裁剪。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: '传当前用户原问题。询问自己或别人是否记得、是谁、印象、旧称、经历、历史事件及查库类问题时不得省略' },
        intent: { type: 'string', enum: ['auto', 'member', 'timeline', 'rules', 'relationship', 'general'], description: '可选检索意图，默认 auto' },
        detail: { type: 'string', enum: ['tiny', 'brief', 'full'], description: 'tiny=极简；brief=默认；full=明确追溯时展开' },
        includeRecent: { type: 'boolean', description: '默认 false；仅诊断或完整追溯时重复带近期消息' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'includeRecent=true 时的消息条数，默认 12' }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }]
    },
    timeoutMs: 5000,
    execute: async (args, exec) => {
      const started = Date.now();
      let metricDir = memDir;
      let metricOptions = {};
      let metricConversation = 'hmac:unknown';
      const emit = (event) => appendMetric(metricDir, {
        type: 'memory-read',
        conversation: metricConversation,
        durationMs: Date.now() - started,
        ...event
      }, metricOptions);
      try {
        const cfg = loadMemoryConfig(memDir);
        metricDir = cfg.dataDir;
        metricOptions = cfg.metrics;
        const sessionId = String(exec?.agent?.id ?? '');
        const resolved = resolveKey(sessionId);
        if (resolved.error) {
          try { metricConversation = anonymizeConversation(metricDir, `out-of-scope:${sessionId}`); } catch {}
          emit({ status: 'denied', reason: 'not-qq-session', detail: 'brief' });
          return { text: NOT_IN_SCOPE };
        }

        metricConversation = anonymizeConversation(metricDir, resolved.key);

        const verify = verifyAgainstBridge(cfg, sessionId, resolved.key);
        if (!verify.ok) {
          // 只记日志，不向模型解释原因（避免信息泄露）
          try {
            const logFile = path.join(cfg.dataDir, 'logs', 'plugin.log');
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.appendFileSync(logFile, `${new Date().toISOString()} deny ${metricConversation} ${verify.reason}\n`);
          } catch {}
          emit({ status: 'denied', reason: verify.reason, detail: 'brief' });
          return { text: NOT_IN_SCOPE };
        }

        const { messages, error: sourceError } = readMessages(cfg.bridge.socialV2, resolved.key);
        if (sourceError) throw new Error('message-source-unavailable');
        const detail = ['tiny', 'brief', 'full'].includes(args?.detail) ? args.detail : cfg.context.defaultDetail;
        const intent = ['auto', 'member', 'timeline', 'rules', 'relationship', 'general'].includes(args?.intent) ? args.intent : 'auto';
        const query = String(args?.query ?? '').slice(0, 300);
        const includeRecent = args?.includeRecent === true;
        const limitRaw = Number(args?.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : cfg.context.windowMessages;
        const lastSeq = Number(messages[messages.length - 1]?.seq) || 0;
        const turnIdentity = String(exec?.turn?.id ?? exec?.turnId ?? `seq:${lastSeq}`);
        const queryHash = crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);
        const version = memoryVersion(cfg.dataDir, resolved.key);
        const cacheKey = [sessionId, turnIdentity, lastSeq, queryHash, intent, detail, includeRecent ? limit : 0, version].join('|');
        const cached = getCached(cacheKey);
        if (cached) {
          emit({
            status: 'success', reason: 'ok', detail, returnedChars: cached.chars,
            memberFacts: cached.stats?.memberFacts, timelinePoints: cached.stats?.timelinePoints,
            messageCount: cached.stats?.messageCount, truncated: cached.truncated,
            cached: true, intent: cached.retrieval?.intent
          });
          return { text: cached.text };
        }
        const maxChars = detail === 'tiny' ? cfg.context.tinyChars : detail === 'full' ? cfg.context.fullChars : cfg.context.maxChars;
        const out = buildContext({
          memDir: cfg.dataDir,
          key: resolved.key,
          query,
          intent,
          detail,
          includeRecent,
          limit,
          messages,
          maxChars,
          sectionBudgets: cfg.context
        });
        setCached(cacheKey, out, cfg);
        emit({
          status: 'success',
          reason: 'ok',
          detail,
          returnedChars: out.chars,
          memberFacts: out.stats?.memberFacts,
          timelinePoints: out.stats?.timelinePoints,
          messageCount: out.stats?.messageCount,
          truncated: out.truncated,
          cached: false,
          intent: out.retrieval?.intent
        });
        return { text: out.text };
      } catch {
        // 工具绝不抛异常：失败就降级成一句提示，聊天照常进行
        emit({ status: 'failed', reason: 'exception', detail: ['tiny', 'brief', 'full'].includes(args?.detail) ? args.detail : 'brief' });
        return { text: '记忆库暂时不可用。按提示词正常聊天即可。' };
      }
    }
  });
}

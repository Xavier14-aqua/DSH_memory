// 记忆库配置加载（阶段 1）
//
// 配置来源优先级：环境变量 > 仓库根目录 config.json > 内置默认值。
// 真实 config.json 不进 git（见 .gitignore），仓库里只提交 config.example.json。
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file, fallback = null) => {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`配置文件不可读或不是合法 JSON：${file}（${error?.message ?? error}）`);
    }
    return fallback;
  }
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * @param {string} memDir 记忆库仓库根目录
 */
export function loadMemoryConfig(memDir) {
  const file = readJson(path.join(memDir, 'config.json'), {}) || {};
  // 未配置时只尝试仓库旁边的 QQbridge，绝不回落到维护者机器上的绝对路径。
  const home = process.env.QQBRIDGE_HOME || file.bridge?.home || path.join(memDir, '..', 'QQbridge');
  const bridgeHome = path.isAbsolute(String(home))
    ? path.normalize(String(home))
    : path.resolve(memDir, String(home));
  const rel = (value, fallback) => path.resolve(bridgeHome, String(value || fallback));
  const dataValue = String(file.dataDir || memDir);
  const dataDir = path.isAbsolute(dataValue) ? path.normalize(dataValue) : path.resolve(memDir, dataValue);
  const clientValue = String(file.worker?.dshClientPath || path.join(bridgeHome, 'src', 'dsh-client.js'));
  const dshClientPath = path.isAbsolute(clientValue) ? path.normalize(clientValue) : path.resolve(bridgeHome, clientValue);

  return {
    memDir,
    dataDir,
    bridge: {
      home: bridgeHome,
      socialV2: rel(file.bridge?.socialV2, 'state/social-v2.json'),
      sessions: rel(file.bridge?.sessions, 'state/sessions.json'),
      initialPrompts: rel(file.bridge?.initialPrompts, 'state/initial-prompts.json'),
      consoleTokenFile: rel(file.bridge?.consoleTokenFile, 'state/console-token'),
      rolesDir: rel(file.bridge?.rolesDir, 'roles'),
      consolePort: Number(file.bridge?.consolePort) || 3100
    },
    context: {
      defaultDetail: ['tiny', 'brief', 'full'].includes(file.context?.defaultDetail) ? file.context.defaultDetail : 'brief',
      tinyChars: clamp(file.context?.tinyChars, 200, 600, 350),
      maxChars: clamp(file.context?.maxChars, 300, 1000, 650),
      fullChars: clamp(file.context?.fullChars, 650, 2000, 1200),
      rulesChars: clamp(file.context?.rulesChars, 40, 400, 100),
      memberChars: clamp(file.context?.memberChars, 80, 800, 260),
      timelineChars: clamp(file.context?.timelineChars, 80, 800, 220),
      personaChars: clamp(file.context?.personaChars, 30, 300, 70),
      recentChars: clamp(file.context?.recentChars, 60, 600, 180),
      windowMessages: clamp(file.context?.windowMessages, 1, 30, 12),
      cacheTtlMs: clamp(file.context?.cacheTtlMs, 5_000, 600_000, 120_000),
      cacheEntries: clamp(file.context?.cacheEntries, 10, 1000, 200)
    },
    metrics: {
      enabled: file.metrics?.enabled !== false,
      maxBytes: clamp(file.metrics?.maxBytes, 64 * 1024, 100 * 1024 * 1024, 5 * 1024 * 1024),
      keepFiles: clamp(file.metrics?.keepFiles, 1, 20, 5)
    },
    facts: {
      schema: 3,
      observationDays: clamp(file.facts?.observationDays, 1, 90, 14)
    },
    toolUsage: {
      observationDays: clamp(file.toolUsage?.observationDays, 1, 90, 14),
      minTotalCalls: clamp(file.toolUsage?.minTotalCalls, 100, 100_000, 500)
    },
    consolidate: {
      enabled: file.consolidate?.enabled !== false,
      intervalMs: Math.max(300000, Number(file.consolidate?.intervalMs) || 21_600_000),
      minInformativeMessages: (() => {
        const env = Number(process.env.MEMORY_MIN_INFORMATIVE_MESSAGES ?? process.env.MEMORY_MIN_MESSAGES);
        if (Number.isFinite(env) && env > 0) return Math.round(env);
        return Math.max(1, Number(file.consolidate?.minInformativeMessages) || 30);
      })(),
      forceMessages: Math.max(1, Number(file.consolidate?.forceMessages) || 100),
      lowActivityMinMessages: Math.max(1, Number(file.consolidate?.lowActivityMinMessages) || 10),
      quietMs: (() => {
        const env = Number(process.env.MEMORY_BATCH_QUIET_MS);
        const configured = Number(file.consolidate?.quietMs);
        return Number.isFinite(env) && env >= 0 ? env : Number.isFinite(configured) && configured >= 0 ? configured : 900_000;
      })(),
      maxWaitMs: (() => {
        const env = Number(process.env.MEMORY_BATCH_MAX_WAIT_MS);
        const configured = Number(file.consolidate?.maxWaitMs);
        return Number.isFinite(env) && env >= 0 ? env : Number.isFinite(configured) && configured >= 0 ? configured : 43_200_000;
      })(),
      maxMessages: clamp(file.consolidate?.maxMessages, 30, 400, 150),
      preset: String(file.consolidate?.preset ?? ''),
      workspaceTitle: String(file.consolidate?.workspaceTitle ?? 'QQ 记忆整理'),
      timeoutMs: clamp(file.consolidate?.timeoutMs, 30_000, 600_000, 180_000)
    },
    worker: {
      pollMs: Math.max(60_000, Number(file.worker?.pollMs) || 300_000),
      dshClientPath,
      provider: String(file.worker?.provider ?? 'deepseek-official'),
      model: String(file.worker?.model ?? 'deepseek-flash'),
      reasoningEffort: String(file.worker?.reasoningEffort ?? 'max'),
      dshBaseUrl: String(file.worker?.dshBaseUrl ?? ''),
      lock: {
        heartbeatMs: clamp(file.worker?.lock?.heartbeatMs, 5_000, 300_000, 30_000),
        staleMs: clamp(file.worker?.lock?.staleMs, 30_000, 3_600_000, 180_000)
      },
      consolidationSession: {
        maxBatches: clamp(file.worker?.consolidationSession?.maxBatches, 1, 50, 4),
        maxSteps: clamp(file.worker?.consolidationSession?.maxSteps, 1, 100, 12),
        maxTokens: clamp(file.worker?.consolidationSession?.maxTokens, 10_000, 2_000_000, 100_000)
      },
      // 会话回收：长期存活的 DSH 会话上下文会涨到几十万 token，每步都要重发。
      // 桥接每次唤醒本来就带最近若干条消息，所以闲置时回收会话几乎不影响聊天连续性。
      reset: (() => {
        const envInterval = Number(process.env.MEMORY_RESET_MS);
        const envIdle = Number(process.env.MEMORY_RESET_IDLE_MS);
        const fileInterval = Number(file.worker?.reset?.intervalMs);
        const fileIdle = Number(file.worker?.reset?.idleMs);
        return {
          enabled: file.worker?.reset?.enabled !== false,
          intervalMs: Number.isFinite(envInterval) && envInterval >= 0
            ? envInterval
            : Math.max(60_000, Number.isFinite(fileInterval) && fileInterval > 0 ? fileInterval : 6 * 3_600_000),
          idleMs: Number.isFinite(envIdle) && envIdle >= 0
            ? envIdle
            : Math.max(0, Number.isFinite(fileIdle) ? fileIdle : 20 * 60_000)
        };
      })()
    }
  };
}

// v0.9.3 匿名运行指标：只写结构化计数，不写聊天内容、QQ/群号或会话令牌。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = Object.freeze({ enabled: true, maxBytes: 5 * 1024 * 1024, keepFiles: 5 });
const METRIC_TYPES = new Set(['memory-read', 'consolidate']);

function optionsOf(options = {}) {
  return {
    enabled: options.enabled !== false,
    maxBytes: Math.round(Math.max(64 * 1024, Number(options.maxBytes) || DEFAULTS.maxBytes)),
    keepFiles: Math.round(Math.min(20, Math.max(1, Number(options.keepFiles) || DEFAULTS.keepFiles)))
  };
}

function statePath(dataDir, name) {
  return path.join(path.resolve(dataDir), '.state', name);
}

function loadOrCreateSecret(dataDir) {
  const file = statePath(dataDir, 'metrics-secret');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(value)) return value;
  } catch {}

  const value = crypto.randomBytes(32).toString('hex');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, value + '\n', 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return value;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(existing)) throw new Error('metrics-secret-invalid');
    return existing;
  }
}

/** 同一数据目录内稳定、跨安装不可关联的会话代号。 */
export function anonymizeConversation(dataDir, conversationKey) {
  const secret = loadOrCreateSecret(dataDir);
  return `hmac:${crypto.createHmac('sha256', secret).update(String(conversationKey)).digest('hex').slice(0, 20)}`;
}

function finiteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

// 明确白名单，避免调用方日后无意把 text/key/error/sessionId 写进指标。
function sanitize(event) {
  if (!event || !METRIC_TYPES.has(event.type)) throw new Error('metric-type-invalid');
  const base = {
    schema: 1,
    at: new Date().toISOString(),
    type: event.type,
    conversation: /^hmac:[0-9a-f]{20}$/.test(String(event.conversation ?? '')) ? event.conversation : 'hmac:unknown',
    status: ['success', 'failed', 'skipped', 'denied'].includes(event.status) ? event.status : 'failed',
    durationMs: finiteInt(event.durationMs)
  };
  if (event.type === 'memory-read') {
    return {
      ...base,
      detail: ['tiny', 'brief', 'full'].includes(event.detail) ? event.detail : 'brief',
      returnedChars: finiteInt(event.returnedChars),
      memberFacts: finiteInt(event.memberFacts),
      timelinePoints: finiteInt(event.timelinePoints),
      messageCount: finiteInt(event.messageCount),
      truncated: event.truncated === true,
      cached: event.cached === true,
      intent: ['member', 'timeline', 'rules', 'relationship', 'general'].includes(event.intent) ? event.intent : 'general',
      reason: ['ok', 'not-qq-session', 'sessions-unavailable', 'unbound', 'mismatch', 'exception'].includes(event.reason)
        ? event.reason : 'exception'
    };
  }
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
  return {
    ...base,
    reason: ['ok', 'too-few', 'no-visible-message', 'no-informative', 'pending-too-few', 'waiting-min-informative', 'waiting-max-wait', 'waiting-quiet', 'source-unavailable', 'session-unavailable', 'prompt-rejected', 'parse-failed', 'exception'].includes(event.reason)
      ? event.reason : 'exception',
    rawMessages: finiteInt(event.rawMessages),
    informativeMessages: finiteInt(event.informativeMessages),
    pendingDepth: finiteInt(event.pendingDepth),
    scannedMessages: finiteInt(event.scannedMessages),
    trigger: ['threshold', 'recovery', 'quiet', 'force', 'max-wait'].includes(event.trigger) ? event.trigger : '',
    timelinePoints: finiteInt(event.timelinePoints),
    memberFacts: finiteInt(event.memberFacts),
    interactions: finiteInt(event.interactions),
    dateClamped: finiteInt(event.dateClamped),
    personaUpdated: event.personaUpdated === true,
    sequenceReset: event.sequenceReset === true,
    gapDetected: event.gapDetected === true,
    sessionRetiredBy: ['batches', 'steps', 'tokens'].includes(event.sessionRetiredBy) ? event.sessionRetiredBy : '',
    usage: {
      cacheMiss: finiteInt(usage.cacheMiss),
      cacheHit: finiteInt(usage.cacheHit),
      cacheWrite: finiteInt(usage.cacheWrite),
      output: finiteInt(usage.output),
      reasoning: finiteInt(usage.reasoning)
    }
  };
}

function rotate(file, keepFiles) {
  try {
    if (fs.existsSync(`${file}.${keepFiles}`)) fs.unlinkSync(`${file}.${keepFiles}`);
    for (let i = keepFiles - 1; i >= 1; i -= 1) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  } catch {
    // 两个进程可能同时越过阈值；轮转失败时仍允许追加，不影响聊天与整理主链路。
  }
}

export function appendMetric(dataDir, event, options = {}) {
  const cfg = optionsOf(options);
  if (!cfg.enabled) return false;
  try {
    const file = statePath(dataDir, 'metrics.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(sanitize(event)) + '\n';
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size + Buffer.byteLength(line) > cfg.maxBytes) rotate(file, cfg.keepFiles);
    fs.appendFileSync(file, line, { encoding: 'utf8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

export function readMetrics(dataDir, { days = 7, keepFiles = DEFAULTS.keepFiles, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 7) * 86_400_000;
  const base = statePath(dataDir, 'metrics.jsonl');
  const retained = Math.round(Math.max(1, Number(keepFiles) || 5));
  const files = [base, ...Array.from({ length: retained }, (_, i) => `${base}.${i + 1}`)];
  const records = [];
  for (const file of files) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const at = Date.parse(row.at);
        if (row.schema === 1 && METRIC_TYPES.has(row.type) && Number.isFinite(at) && at >= cutoff) records.push(row);
      } catch {}
    }
  }
  return records;
}

export function summarizeMetrics(records) {
  const reads = records.filter((r) => r.type === 'memory-read');
  const jobs = records.filter((r) => r.type === 'consolidate');
  const sum = (arr, pick) => arr.reduce((n, row) => n + finiteInt(pick(row)), 0);
  const successfulReads = reads.filter((r) => r.status === 'success');
  const successfulJobs = jobs.filter((r) => r.status === 'success');
  const latestJob = jobs.reduce((latest, row) => Date.parse(row.at) > Date.parse(latest?.at ?? 0) ? row : latest, null);
  const usage = {
    cacheMiss: sum(jobs, (r) => r.usage?.cacheMiss),
    cacheHit: sum(jobs, (r) => r.usage?.cacheHit),
    cacheWrite: sum(jobs, (r) => r.usage?.cacheWrite),
    output: sum(jobs, (r) => r.usage?.output),
    reasoning: sum(jobs, (r) => r.usage?.reasoning)
  };
  return {
    reads: {
      total: reads.length,
      success: successfulReads.length,
      denied: reads.filter((r) => r.status === 'denied').length,
      failed: reads.filter((r) => r.status === 'failed').length,
      tiny: reads.filter((r) => r.detail === 'tiny').length,
      brief: reads.filter((r) => r.detail === 'brief').length,
      full: reads.filter((r) => r.detail === 'full').length,
      avgChars: successfulReads.length ? Math.round(sum(successfulReads, (r) => r.returnedChars) / successfulReads.length) : 0,
      truncated: reads.filter((r) => r.truncated).length,
      cached: reads.filter((r) => r.cached).length
    },
    consolidate: {
      total: jobs.length,
      success: successfulJobs.length,
      skipped: jobs.filter((r) => r.status === 'skipped').length,
      failed: jobs.filter((r) => r.status === 'failed').length,
      parseFailed: jobs.filter((r) => r.reason === 'parse-failed').length,
      // too-few 会在每次轮询重复看见同一批候选消息，不能把它们反复算成模型输入。
      rawMessages: sum(jobs.filter((r) => r.status === 'success' || r.reason === 'parse-failed'), (r) => r.rawMessages),
      informativeMessages: sum(jobs.filter((r) => r.status === 'success' || r.reason === 'parse-failed'), (r) => r.informativeMessages),
      pendingDepth: finiteInt(latestJob?.pendingDepth),
      timelinePoints: sum(successfulJobs, (r) => r.timelinePoints),
      memberFacts: sum(successfulJobs, (r) => r.memberFacts),
      dateClamped: sum(successfulJobs, (r) => r.dateClamped),
      sessionRetired: {
        batches: jobs.filter((r) => r.sessionRetiredBy === 'batches').length,
        steps: jobs.filter((r) => r.sessionRetiredBy === 'steps').length,
        tokens: jobs.filter((r) => r.sessionRetiredBy === 'tokens').length
      },
      usage
    }
  };
}

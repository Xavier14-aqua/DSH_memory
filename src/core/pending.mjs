// v0.10.1 持久输入队列：scan 与消息正文/分类/尝试历史一起原子落盘。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyMessage, isInformative } from '../worker/filter.mjs';

const HISTORY_LIMIT = 100;
const BATCH_HISTORY_LIMIT = 50;

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeKey(key) {
  const match = /^(group|private):(\d{1,20})$/.exec(String(key ?? ''));
  if (!match) throw new Error('pending-key-invalid');
  return `${match[1]}-${match[2]}`;
}

export function pendingQueueFile(memDir, key) {
  return path.join(path.resolve(memDir), '.state', 'pending', `${safeKey(key)}.json`);
}

function history(queue, event) {
  queue.history.push({ at: Date.now(), ...event });
  if (queue.history.length > HISTORY_LIMIT) queue.history.splice(0, queue.history.length - HISTORY_LIMIT);
}

function newQueue(key, { initialSeq = 0, initialAt = 0 } = {}) {
  return {
    schema: 1,
    key,
    generation: 0,
    scan: { seq: Math.max(0, Number(initialSeq) || 0), at: Number(initialAt) || 0, lastMessageAt: 0 },
    source: { firstSeq: 0, lastSeq: 0, lastMessageAt: 0 },
    pending: [],
    inflight: null,
    recovery: { pending: false, sequenceResets: 0, gaps: 0, lastIssue: null },
    stats: { scanned: 0, ignored: 0, low: 0, normal: 0, important: 0, enqueued: 0, committed: 0 },
    memory: { lastCommittedAt: Number(initialAt) || 0, lastBatchId: '', lastCommittedGeneration: 0, lastCommittedSeq: Math.max(0, Number(initialSeq) || 0) },
    failures: { count: 0, lastAt: 0, lastReason: '' },
    batches: [],
    history: [{ at: Date.now(), type: 'created', initialSeq: Math.max(0, Number(initialSeq) || 0) }],
    updatedAt: Date.now()
  };
}

function normalizeQueue(value, key, init) {
  if (!value || value.schema !== 1 || value.key !== key || !Array.isArray(value.pending)) return newQueue(key, init);
  value.generation = Math.max(0, Number(value.generation) || 0);
  value.scan = { seq: 0, at: 0, lastMessageAt: 0, ...(value.scan ?? {}) };
  value.source = { firstSeq: 0, lastSeq: 0, lastMessageAt: 0, ...(value.source ?? {}) };
  value.recovery = { pending: false, sequenceResets: 0, gaps: 0, lastIssue: null, ...(value.recovery ?? {}) };
  value.stats = { scanned: 0, ignored: 0, low: 0, normal: 0, important: 0, enqueued: 0, committed: 0, ...(value.stats ?? {}) };
  value.memory = { lastCommittedAt: 0, lastBatchId: '', lastCommittedGeneration: 0, lastCommittedSeq: 0, ...(value.memory ?? {}) };
  value.failures = { count: 0, lastAt: 0, lastReason: '', ...(value.failures ?? {}) };
  value.batches = Array.isArray(value.batches) ? value.batches : [];
  value.history = Array.isArray(value.history) ? value.history : [];
  return value;
}

export function readPendingQueue(memDir, key, init = {}) {
  return normalizeQueue(readJson(pendingQueueFile(memDir, key)), key, init);
}

function storedMessage(message, classification, generation, now, recovery) {
  const seq = Number(message.seq);
  return {
    id: `g${generation}:s${seq}`,
    generation,
    seq,
    messageId: message.messageId ?? message.id ?? null,
    sender: String(message.sender ?? ''),
    userId: String(message.userId ?? ''),
    text: classification.text.slice(0, 2000),
    time: Number(message.time) || now,
    isSelf: message.isSelf === true,
    level: classification.level,
    filterReason: classification.reason,
    recovery: recovery === true,
    enqueuedAt: now,
    attempts: 0,
    lastAttemptAt: 0,
    lastError: ''
  };
}

/** 扫描 social-v2 当前窗口；scan 与 pending 在同一次原子写中提交。 */
export function scanIntoPending({ memDir, key, messages = [], initialSeq = 0, initialAt = 0, now = Date.now(), classifier = classifyMessage } = {}) {
  const file = pendingQueueFile(memDir, key);
  const queue = readPendingQueue(memDir, key, { initialSeq, initialAt });
  const visible = (Array.isArray(messages) ? messages : [])
    .filter((message) => Number.isFinite(Number(message?.seq)) && Number(message.seq) > 0)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const firstSeq = Number(visible[0]?.seq) || 0;
  const sourceLastSeq = Number(visible[visible.length - 1]?.seq) || 0;
  const sourceLastAt = visible.reduce((max, message) => Math.max(max, Number(message?.time) || 0), 0);
  let sequenceReset = false;
  let gap = null;

  if (sourceLastSeq > 0 && Number(queue.scan.seq) > 0 && sourceLastSeq < Number(queue.scan.seq)) {
    sequenceReset = true;
    queue.generation += 1;
    queue.recovery.sequenceResets += 1;
    queue.scan.seq = 0;
    queue.scan.at = now;
    queue.recovery.lastIssue = { type: 'sequence-reset', generation: queue.generation, previousScanSeq: Number(queue.source.lastSeq) || 0, firstSeq, sourceLastSeq, at: now };
    history(queue, { type: 'sequence-reset', generation: queue.generation, firstSeq, sourceLastSeq });
  }

  const expected = Number(queue.scan.seq) + 1;
  if (firstSeq > expected) {
    gap = { from: expected, to: firstSeq - 1, reason: sequenceReset ? 'sequence-reset-window' : 'source-window-gap' };
    queue.recovery.gaps += 1;
    queue.recovery.lastIssue = { type: 'gap', generation: queue.generation, ...gap, at: now };
    history(queue, { type: 'gap', generation: queue.generation, ...gap });
  }

  const known = new Set(queue.pending.map((item) => item.id));
  const fresh = visible.filter((message) => Number(message.seq) > Number(queue.scan.seq));
  const counts = { scanned: 0, ignored: 0, low: 0, normal: 0, important: 0, enqueued: 0 };
  let previous = null;
  for (const message of fresh) {
    const classification = classifier(message, { previous });
    previous = message;
    const statKey = classification.level === 'ignore' ? 'ignored' : classification.level;
    counts.scanned += 1;
    counts[statKey] = (counts[statKey] ?? 0) + 1;
    queue.stats.scanned += 1;
    queue.stats[statKey] = (queue.stats[statKey] ?? 0) + 1;
    if (isInformative(classification.level)) {
      const stored = storedMessage(message, classification, queue.generation, now, Boolean(sequenceReset || gap));
      if (!known.has(stored.id)) {
        queue.pending.push(stored);
        known.add(stored.id);
        counts.enqueued += 1;
        queue.stats.enqueued += 1;
      }
    }
    queue.scan.seq = Number(message.seq);
    queue.scan.at = now;
    queue.scan.lastMessageAt = Math.max(Number(queue.scan.lastMessageAt) || 0, Number(message.time) || now);
  }
  queue.source = { firstSeq, lastSeq: sourceLastSeq, lastMessageAt: sourceLastAt };
  queue.recovery.pending = queue.pending.some((item) => item.recovery === true);
  queue.updatedAt = now;
  if (fresh.length || sequenceReset || gap) history(queue, { type: 'scan', generation: queue.generation, ...counts, scanSeq: queue.scan.seq, pending: queue.pending.length });
  atomicWrite(file, queue);
  return { queue, counts, sequenceReset, gap, firstSeq, sourceLastSeq };
}

export function pendingBatch(queue, maxMessages = 120) {
  const first = queue?.pending?.[0];
  if (!first) return [];
  const generation = first.generation;
  return queue.pending.filter((item) => item.generation === generation).slice(0, Math.max(1, Number(maxMessages) || 120));
}

function batchIdOf(key, items) {
  return `pb-${crypto.createHash('sha256').update(`${key}|${items.map((item) => item.id).join('|')}`).digest('hex').slice(0, 20)}`;
}

/** prompt 前持久化 attempt；崩溃或模型失败时消息仍留在 pending。 */
export function beginPendingBatch({ memDir, key, maxMessages = 120, trigger = 'threshold', now = Date.now() } = {}) {
  const file = pendingQueueFile(memDir, key);
  const queue = readPendingQueue(memDir, key);
  const items = pendingBatch(queue, maxMessages);
  if (!items.length) return { queue, batchId: '', items: [] };
  const batchId = batchIdOf(key, items);
  const ids = new Set(items.map((item) => item.id));
  for (const item of queue.pending) {
    if (!ids.has(item.id)) continue;
    item.attempts = (Number(item.attempts) || 0) + 1;
    item.lastAttemptAt = now;
    item.lastError = '';
  }
  queue.inflight = { batchId, itemIds: [...ids], generation: items[0].generation, startedAt: now, trigger, attempt: Math.max(...items.map((item) => Number(item.attempts) || 1)) };
  queue.updatedAt = now;
  history(queue, { type: 'batch-start', batchId, count: items.length, trigger });
  atomicWrite(file, queue);
  return { queue, batchId, items: queue.pending.filter((item) => ids.has(item.id)) };
}

export function failPendingBatch({ memDir, key, batchId, reason = 'failed', now = Date.now() } = {}) {
  const file = pendingQueueFile(memDir, key);
  const queue = readPendingQueue(memDir, key);
  const ids = new Set(queue.inflight?.batchId === batchId ? queue.inflight.itemIds : []);
  for (const item of queue.pending) if (ids.has(item.id)) item.lastError = String(reason).slice(0, 40);
  queue.failures.count += 1;
  queue.failures.lastAt = now;
  queue.failures.lastReason = String(reason).slice(0, 40);
  queue.inflight = null;
  queue.updatedAt = now;
  history(queue, { type: 'batch-failed', batchId, count: ids.size, reason: queue.failures.lastReason });
  atomicWrite(file, queue);
  return queue;
}

export function commitPendingBatch({ memDir, key, batchId, result = {}, now = Date.now() } = {}) {
  const file = pendingQueueFile(memDir, key);
  const queue = readPendingQueue(memDir, key);
  if (queue.inflight?.batchId !== batchId) throw new Error('pending-batch-mismatch');
  const ids = new Set(queue.inflight.itemIds);
  const committed = queue.pending.filter((item) => ids.has(item.id));
  queue.pending = queue.pending.filter((item) => !ids.has(item.id));
  queue.stats.committed += committed.length;
  queue.memory.lastCommittedAt = now;
  queue.memory.lastBatchId = batchId;
  queue.memory.lastCommittedGeneration = committed[committed.length - 1]?.generation ?? queue.memory.lastCommittedGeneration;
  queue.memory.lastCommittedSeq = committed[committed.length - 1]?.seq ?? queue.memory.lastCommittedSeq;
  queue.batches.push({
    batchId,
    at: now,
    generation: committed[0]?.generation ?? 0,
    count: committed.length,
    fromSeq: committed[0]?.seq ?? 0,
    toSeq: committed[committed.length - 1]?.seq ?? 0,
    trigger: queue.inflight.trigger,
    timelinePoints: Number(result.timelinePoints) || 0,
    memberFacts: Number(result.memberFacts) || 0,
    personaUpdated: result.personaUpdated === true
  });
  if (queue.batches.length > BATCH_HISTORY_LIMIT) queue.batches.splice(0, queue.batches.length - BATCH_HISTORY_LIMIT);
  queue.inflight = null;
  queue.recovery.pending = queue.pending.some((item) => item.recovery === true);
  queue.updatedAt = now;
  history(queue, { type: 'batch-committed', batchId, count: committed.length, remaining: queue.pending.length });
  atomicWrite(file, queue);
  return { queue, committed };
}

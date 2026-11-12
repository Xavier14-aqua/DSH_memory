// v0.10.2 自适应批处理：只读取持久 pending 状态，不读取 social-v2 消息数组。

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function evaluatePendingTrigger(queue, config = {}, now = Date.now()) {
  const pending = Array.isArray(queue?.pending) ? queue.pending : [];
  const pendingCount = pending.length;
  const minInformativeMessages = Math.max(1, positive(config.minInformativeMessages, 30));
  const forceMessages = Math.max(minInformativeMessages, positive(config.forceMessages, 100));
  const lowActivityMinMessages = Math.max(1, positive(config.lowActivityMinMessages, 10));
  const quietMs = Math.max(0, positive(config.quietMs, 15 * 60_000));
  const maxWaitMs = Math.max(0, positive(config.maxWaitMs, 12 * 3_600_000));
  const lastActivityAt = Number(queue?.scan?.lastMessageAt)
    || pending.reduce((max, item) => Math.max(max, Number(item?.time) || Number(item?.enqueuedAt) || 0), 0);
  const quietForMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : 0;
  const oldestPendingAt = pending.reduce((min, item) => {
    const at = Number(item?.enqueuedAt) || Number(item?.time) || 0;
    return at > 0 && (!min || at < min) ? at : min;
  }, 0);
  const lastCommittedAt = Number(queue?.memory?.lastCommittedAt) || 0;
  const waitSince = lastCommittedAt || oldestPendingAt;
  const waitingForMs = waitSince ? Math.max(0, now - waitSince) : 0;

  const state = { pendingCount, minInformativeMessages, forceMessages, lowActivityMinMessages, quietMs, maxWaitMs, quietForMs, waitingForMs };
  if (!pendingCount) return { ...state, ready: false, trigger: '', reason: 'no-informative' };
  if (queue?.recovery?.pending === true) return { ...state, ready: true, trigger: 'recovery', reason: 'recovery' };
  if (pendingCount >= forceMessages) return { ...state, ready: true, trigger: 'force', reason: 'force' };
  if (pendingCount >= minInformativeMessages && quietForMs >= quietMs) return { ...state, ready: true, trigger: 'quiet', reason: 'quiet' };
  if (pendingCount >= lowActivityMinMessages && waitingForMs >= maxWaitMs) return { ...state, ready: true, trigger: 'max-wait', reason: 'max-wait' };
  if (pendingCount < lowActivityMinMessages) return { ...state, ready: false, trigger: '', reason: 'waiting-min-informative' };
  if (pendingCount < minInformativeMessages) return { ...state, ready: false, trigger: '', reason: 'waiting-max-wait' };
  return { ...state, ready: false, trigger: '', reason: 'waiting-quiet' };
}

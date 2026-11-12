export function usageTotal(usage = {}) {
  return ['cacheMiss', 'cacheHit', 'cacheWrite', 'output', 'reasoning']
    .reduce((sum, key) => sum + (Number(usage?.[key]) || 0), 0);
}

export function nextSessionBudget(state = {}, { steps = 1, usage = {} } = {}) {
  return {
    batches: (Number(state.batches) || 0) + 1,
    steps: (Number(state.steps) || 0) + Math.max(1, Number(steps) || 1),
    tokens: (Number(state.tokens) || 0) + usageTotal(usage)
  };
}

export function sessionRetirementReason(state = {}, limits = {}) {
  if ((Number(state.batches) || 0) >= Math.max(1, Number(limits.maxBatches) || 4)) return 'batches';
  if ((Number(state.steps) || 0) >= Math.max(1, Number(limits.maxSteps) || 12)) return 'steps';
  if ((Number(state.tokens) || 0) >= Math.max(1, Number(limits.maxTokens) || 100_000)) return 'tokens';
  return '';
}

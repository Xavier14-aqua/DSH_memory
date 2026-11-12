import fs from 'node:fs';
import path from 'node:path';

export const TOOL_FLAG_MAP = Object.freeze({
  getPrompt: ['mcp__snowluma__qq_get_prompt'],
  getUnread: ['mcp__snowluma__qq_get_unread_messages'],
  getRecent: ['mcp__snowluma__qq_get_recent_messages'],
  socialState: ['mcp__snowluma__qq_social_state'],
  markRead: ['mcp__snowluma__qq_mark_read'],
  setWakeConfig: ['mcp__snowluma__qq_set_wake_config'],
  sendBurst: ['mcp__snowluma__qq_send_burst'],
  sendMessage: ['mcp__snowluma__qq_send_message'],
  waitMessages: ['mcp__snowluma__qq_wait_for_messages'],
  feedback: ['mcp__snowluma__qq_report_feedback'],
  getMyRecent: ['mcp__snowluma__qq_get_my_recent_messages'],
  getMessageDetail: ['mcp__snowluma__qq_get_message_detail'],
  getActiveMembers: ['mcp__snowluma__qq_get_active_members'],
  memory: ['mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_memory_query', 'mcp__snowluma__qq_memory_remove', 'mcp__snowluma__qq_memory_clear'],
  slangQuery: ['mcp__snowluma__qq_slang_query'],
  slangSubmit: ['mcp__snowluma__qq_slang_submit'],
  getImages: ['mcp__snowluma__qq_get_message_images'],
  getForwardMsg: ['mcp__snowluma__qq_get_forward_msg'],
  sendPoke: ['mcp__snowluma__qq_send_poke'],
  listStickers: ['mcp__snowluma__qq_list_stickers'],
  getStickerImage: ['mcp__snowluma__qq_get_sticker_image'],
  sendSticker: ['mcp__snowluma__qq_send_sticker'],
  collectSticker: ['mcp__snowluma__qq_collect_sticker'],
  getSelfImage: ['mcp__snowluma__qq_get_self_image'],
  stickerNote: ['mcp__snowluma__qq_sticker_note'],
  sendVoice: ['mcp__snowluma__qq_send_voice', 'mcp__snowluma__qq_list_voices']
});

const PROTECTED_FLAGS = new Set(['getUnread', 'getRecent', 'socialState', 'markRead', 'setWakeConfig', 'sendMessage', 'waitMessages']);

function readRows(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

export function analyzeToolUsage({ stateDir, days = 30, now = Date.now(), minObservationDays = 14, minTotalCalls = 500, enabledFlags = {} } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 30) * 86_400_000;
  const files = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((name) => /^tool-calls\.jsonl(?:\.\d+)?$/.test(name)).map((name) => path.join(stateDir, name))
    : [];
  const rows = files.flatMap(readRows).filter((row) => Date.parse(row?.time) >= cutoff);
  const calls = rows.filter((row) => row.type === 'call' && row.tool);
  const results = rows.filter((row) => row.type === 'result' && row.tool);
  const timestamps = calls.map((row) => Date.parse(row.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const byTool = {};
  for (const row of calls) {
    const item = (byTool[row.tool] ??= { calls: 0, results: 0, success: 0, failed: 0, lastAt: '' });
    item.calls += 1;
    if (!item.lastAt || row.time > item.lastAt) item.lastAt = row.time;
  }
  for (const row of results) {
    const item = (byTool[row.tool] ??= { calls: 0, results: 0, success: 0, failed: 0, lastAt: '' });
    item.results += 1;
    if (row.ok === false) item.failed += 1; else item.success += 1;
  }
  const observedDays = timestamps.length > 1 ? (timestamps.at(-1) - timestamps[0]) / 86_400_000 : 0;
  const ready = observedDays >= minObservationDays && calls.length >= minTotalCalls;
  const flagUsage = {};
  const candidates = [];
  for (const [flag, tools] of Object.entries(TOOL_FLAG_MAP)) {
    const count = tools.reduce((sum, tool) => sum + (byTool[tool]?.calls ?? 0), 0);
    flagUsage[flag] = { calls: count, tools };
    if (ready && enabledFlags[flag] !== false && !PROTECTED_FLAGS.has(flag) && count === 0) candidates.push(flag);
  }
  return {
    schema: 1,
    generatedAt: new Date(now).toISOString(),
    days,
    observedDays: Number(observedDays.toFixed(2)),
    totalCalls: calls.length,
    sessions: new Set(calls.map((row) => row.sessionId).filter(Boolean)).size,
    ready,
    thresholds: { minObservationDays, minTotalCalls },
    byTool,
    flagUsage,
    candidates,
    decision: ready ? (candidates.length ? 'candidates-ready' : 'keep-current') : 'observe-more'
  };
}

export function writeToolUsageReport(memDir, report) {
  const file = path.join(memDir, '.state', 'tool-usage-report.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function applyToolPrunePlan({ memDir, bridgeConfigFile, report, now = Date.now() }) {
  if (!report?.ready) throw new Error('观察期或调用样本不足，拒绝裁工具');
  if (!Array.isArray(report.candidates) || !report.candidates.length) return { changed: 0, backup: '' };
  const config = JSON.parse(fs.readFileSync(bridgeConfigFile, 'utf8'));
  config.socialV2 = config.socialV2 ?? {};
  config.socialV2.tools = config.socialV2.tools ?? {};
  const backupDir = path.join(memDir, '.backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDir, `qqbridge-config.before-tool-prune.${stamp}.json`);
  fs.copyFileSync(bridgeConfigFile, backup);
  for (const flag of report.candidates) config.socialV2.tools[flag] = false;
  const tmp = `${bridgeConfigFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, bridgeConfigFile);
  return { changed: report.candidates.length, backup, flags: report.candidates };
}

import fs from 'node:fs';
import path from 'node:path';

export const PATCH_OPERATIONS = new Set(['add', 'replace', 'remove']);
export const PATCH_TARGETS = new Set(['timeline', 'member-fact', 'persona']);
const SCOPES = new Set(['global', 'group']);

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function member(memDir, qq) {
  try { return JSON.parse(fs.readFileSync(path.join(memDir, 'members', `${qq}.json`), 'utf8')); } catch { return null; }
}
function bucketFor(obj, scope, gid) {
  return scope === 'global' ? obj?.global?.facts : obj?.groups?.[gid]?.facts;
}

export function validatePatchEnvelope(envelope, { memDir = '', gid = '', messages = [] } = {}) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) errors.push('根必须是对象');
  if (Number(envelope?.schema) !== 1) errors.push('schema 必须为 1');
  if (!Array.isArray(envelope?.patches)) errors.push('patches 必须是数组');
  if ((envelope?.patches?.length ?? 0) > 40) errors.push('patches 最多 40 项');
  const seqOwners = new Map((Array.isArray(messages) ? messages : []).map((m) => [Number(m?.seq), String(m?.userId ?? '')]));
  const participants = new Set([...seqOwners.values()].filter(Boolean));

  for (const [index, raw] of (envelope?.patches ?? []).entries()) {
    const at = `patches[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${at} 必须是对象`); continue; }
    const allowed = new Set(['op', 'target', 'qq', 'scope', 'groupId', 'id', 'date', 'match', 'value']);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) errors.push(`${at}.${key} 不在 JSON Schema 中`);
    if (!PATCH_OPERATIONS.has(raw.op)) errors.push(`${at}.op 非法`);
    if (!PATCH_TARGETS.has(raw.target)) errors.push(`${at}.target 非法`);
    if (raw.target === 'timeline') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? raw.value?.date ?? ''))) errors.push(`${at} timeline 日期非法`);
      if (raw.op === 'add' && clip(raw.value?.text, 80).length < 2) errors.push(`${at} timeline add 缺少文本`);
      if (raw.op !== 'add' && clip(raw.match, 80).length < 2) errors.push(`${at} timeline replace/remove 缺少 match`);
      if (raw.op === 'replace' && clip(raw.value?.text, 80).length < 2) errors.push(`${at} timeline replace 缺少新文本`);
    }
    if (raw.target === 'member-fact') {
      const qq = String(raw.qq ?? '');
      const scope = String(raw.scope ?? '');
      const profile = /^\d{4,12}$/.test(qq) && memDir ? member(memDir, qq) : null;
      if (!/^\d{4,12}$/.test(qq)) errors.push(`${at}.qq 非法`);
      if (!SCOPES.has(scope)) errors.push(`${at}.scope 非法`);
      if (!profile && !participants.has(qq)) errors.push(`${at} QQ 不在本地成员档或本批消息`);
      if (scope === 'group' && String(raw.groupId ?? gid) !== String(gid)) errors.push(`${at} group scope 越界`);
      if (scope === 'global' && raw.groupId) errors.push(`${at} global scope 不得带 groupId`);
      if (raw.op === 'add') {
        if (clip(raw.value?.text, 80).length < 3) errors.push(`${at} fact add 缺少文本`);
        const sourceSeq = Number(raw.value?.sourceSeq ?? raw.value?.source_seq);
        if (!Number.isFinite(sourceSeq) || seqOwners.get(sourceSeq) !== qq) errors.push(`${at} sourceSeq 不属于该本地成员`);
      } else {
        const id = String(raw.id ?? '');
        if (!id) errors.push(`${at} replace/remove 缺少 id`);
        const bucket = bucketFor(profile, scope, String(gid));
        if (!Array.isArray(bucket) || !bucket.some((fact) => String(fact?.id) === id)) errors.push(`${at} 本地目标事实不存在`);
        if (raw.op === 'replace' && clip(raw.value?.text, 80).length < 3) errors.push(`${at} fact replace 缺少文本`);
      }
    }
    if (raw.target === 'persona') {
      if (raw.op === 'add') errors.push(`${at} persona 只允许 replace/remove`);
      if (raw.op === 'replace' && (!raw.value || typeof raw.value !== 'object')) errors.push(`${at} persona replace 缺少对象`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function normalizePatchEnvelope(envelope) {
  return {
    schema: 1,
    patches: (Array.isArray(envelope?.patches) ? envelope.patches : []).map((raw) => {
      const patch = { op: raw.op, target: raw.target };
      for (const key of ['qq', 'scope', 'groupId', 'id', 'date', 'match']) if (raw[key] !== undefined) patch[key] = String(raw[key]);
      if (raw.value !== undefined) patch.value = raw.value;
      return patch;
    })
  };
}


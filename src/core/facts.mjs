import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const day = (ms) => {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function normalizeFact(fact, { scope = 'global', groupId = '' } = {}) {
  const scopeRef = fact?.scopeRef && typeof fact.scopeRef === 'object' ? fact.scopeRef : null;
  const sourceRef = fact?.sourceRef && typeof fact.sourceRef === 'object' ? fact.sourceRef : null;
  const lifecycle = fact?.lifecycle && typeof fact.lifecycle === 'object' ? fact.lifecycle : null;
  const resolvedScope = String(scopeRef?.kind ?? fact?.scope ?? scope);
  const resolvedGroup = String(scopeRef?.groupId ?? groupId ?? '');
  const createdAt = String(fact?.createdAt ?? fact?.date ?? '');
  let source = String(fact?.source ?? '');
  if (!source && sourceRef?.kind === 'group') source = `group:${sourceRef.groupId ?? resolvedGroup}${sourceRef.seq ? `#seq${sourceRef.seq}` : ''}`;
  return {
    ...fact,
    id: String(fact?.id ?? ''),
    text: String(fact?.text ?? ''),
    createdAt,
    date: String(fact?.date ?? createdAt).slice(0, 10),
    source,
    sourceRef: sourceRef ?? null,
    scope: resolvedScope,
    scopeRef: scopeRef ?? { kind: resolvedScope, ...(resolvedScope === 'group' ? { groupId: resolvedGroup } : {}) },
    confidence: Number.isFinite(Number(fact?.confidence)) ? Number(fact.confidence) : 0.7,
    status: String(fact?.status ?? 'active'),
    expiresAt: String(lifecycle?.expiresAt ?? fact?.expiresAt ?? ''),
    supersededBy: String(lifecycle?.supersededBy ?? fact?.supersededBy ?? '')
  };
}

export function normalizeMemberFacts(member) {
  if (!member || typeof member !== 'object') return member;
  const out = structuredClone(member);
  out.global = out.global ?? { tags: [], traits: [], avoid: [], facts: [] };
  out.global.facts = (Array.isArray(out.global.facts) ? out.global.facts : []).map((fact) => normalizeFact(fact, { scope: 'global' }));
  out.groups = out.groups ?? {};
  for (const [gid, group] of Object.entries(out.groups)) {
    group.facts = (Array.isArray(group?.facts) ? group.facts : []).map((fact) => normalizeFact(fact, { scope: 'group', groupId: gid }));
  }
  return out;
}

export function legacyWriteEnabled(memDir, now = Date.now()) {
  const state = readJson(path.join(memDir, '.state', 'schema3-migration.json'), null);
  if (!state) return true;
  return now < (Number(state.legacyWriteUntil) || 0);
}

export function createFactRecord({ memDir, schema = 3, id, text, scope, groupId = '', sourceSeq = 0, confidence = 0.7, now = Date.now(), expiresAt = '', supersededBy = '' }) {
  const date = day(now);
  const source = sourceSeq ? `group:${groupId}#seq${sourceSeq}` : groupId ? `group:${groupId}` : '';
  if (Number(schema) < 3) {
    return { id, text, date, source, scope, confidence, status: 'active', ...(expiresAt ? { expiresAt } : {}), ...(supersededBy ? { supersededBy } : {}) };
  }
  const record = {
    id,
    text,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    sourceRef: { kind: 'group', groupId: String(groupId), ...(sourceSeq ? { seq: sourceSeq } : {}) },
    scopeRef: { kind: scope, ...(scope === 'group' ? { groupId: String(groupId) } : {}) },
    confidence,
    status: 'active',
    expiresAt: String(expiresAt || ''),
    supersededBy: String(supersededBy || '')
  };
  if (legacyWriteEnabled(memDir, now)) Object.assign(record, { date, source, scope });
  return record;
}

function toSchema3Fact(fact, options, now) {
  const normalized = normalizeFact(fact, options);
  const sourceMatch = /^group:(\d+)(?:#seq(\d+))?$/.exec(normalized.source);
  return {
    ...fact,
    id: normalized.id,
    text: normalized.text,
    createdAt: fact?.createdAt || (normalized.date ? `${normalized.date}T00:00:00.000Z` : new Date(now).toISOString()),
    updatedAt: fact?.updatedAt || new Date(now).toISOString(),
    sourceRef: normalized.sourceRef ?? (sourceMatch ? { kind: 'group', groupId: sourceMatch[1], ...(sourceMatch[2] ? { seq: Number(sourceMatch[2]) } : {}) } : { kind: 'unknown' }),
    scopeRef: normalized.scopeRef,
    confidence: normalized.confidence,
    status: normalized.status,
    expiresAt: normalized.expiresAt,
    supersededBy: normalized.supersededBy,
    date: normalized.date,
    source: normalized.source,
    scope: normalized.scope
  };
}

export function migrateMembersToSchema3({ memDir, dry = false, observationDays = 14, now = Date.now() } = {}) {
  const membersDir = path.join(memDir, 'members');
  const files = fs.existsSync(membersDir) ? fs.readdirSync(membersDir).filter((file) => /^\d+\.json$/.test(file)).sort() : [];
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupDir = path.join(memDir, '.backups', `schema2-to-3-${stamp}`, 'members');
  const report = { scanned: files.length, migrated: 0, skipped: 0, backupDir, observationDays, dry, files: [] };
  for (const name of files) {
    const file = path.join(membersDir, name);
    const obj = readJson(file, null);
    if (!obj || Number(obj.schema) >= 3) { report.skipped += 1; continue; }
    const next = structuredClone(obj);
    next.schema = 3;
    next.factSchema = 3;
    next.migratedAt = new Date(now).toISOString();
    next.global = next.global ?? { tags: [], traits: [], avoid: [], facts: [] };
    next.global.facts = (Array.isArray(next.global.facts) ? next.global.facts : []).map((fact) => toSchema3Fact(fact, { scope: 'global' }, now));
    next.groups = next.groups ?? {};
    for (const [gid, group] of Object.entries(next.groups)) {
      group.facts = (Array.isArray(group?.facts) ? group.facts : []).map((fact) => toSchema3Fact(fact, { scope: 'group', groupId: gid }, now));
    }
    report.migrated += 1;
    report.files.push(name);
    if (!dry) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, name));
      atomicJson(file, next);
    }
  }
  if (!dry && report.migrated) {
    atomicJson(path.join(memDir, '.state', 'schema3-migration.json'), {
      schema: 1,
      status: 'observing',
      migratedAt: now,
      observationDays,
      legacyWriteUntil: now + Math.max(1, Number(observationDays) || 14) * 86_400_000,
      backupDir: path.relative(memDir, backupDir).replace(/\\/g, '/'),
      migratedFiles: report.migrated
    });
  }
  return report;
}

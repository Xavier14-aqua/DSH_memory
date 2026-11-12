import fs from 'node:fs';
import path from 'node:path';

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function safeRelative(memDir, file) {
  const root = path.resolve(memDir);
  const absolute = path.resolve(file);
  const rel = path.relative(root, absolute).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`事务目标越界：${file}`);
  return rel;
}

function snapshot(memDir, file) {
  const rel = safeRelative(memDir, file);
  try {
    return { file: rel, exists: true, text: fs.readFileSync(path.resolve(memDir, rel), 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { file: rel, exists: false, text: '' };
    throw error;
  }
}

function restoreSnapshot(memDir, item) {
  const file = path.resolve(memDir, item.file);
  safeRelative(memDir, file);
  if (!item.exists) {
    try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(item.text ?? ''), 'utf8');
  fs.renameSync(tmp, file);
}

const txDir = (memDir) => path.join(memDir, '.state', 'transactions');
const txFile = (memDir, id) => path.join(txDir(memDir), `${id}.json`);

export function prepareTransaction({ memDir, id, kind = 'memory-patch', targets = [], meta = {}, now = Date.now() }) {
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('事务 ID 非法');
  const unique = [...new Set(targets.map((file) => path.resolve(file)))].sort();
  const transaction = {
    schema: 1,
    id,
    kind,
    status: 'prepared',
    preparedAt: now,
    committedAt: 0,
    rolledBackAt: 0,
    meta,
    files: unique.map((file) => ({ before: snapshot(memDir, file), after: null }))
  };
  atomicWrite(txFile(memDir, id), transaction);
  return transaction;
}

export function commitTransaction({ memDir, transaction, now = Date.now() }) {
  const committed = {
    ...transaction,
    status: 'committed',
    committedAt: now,
    files: transaction.files.map((entry) => ({ ...entry, after: snapshot(memDir, path.resolve(memDir, entry.before.file)) }))
  };
  atomicWrite(txFile(memDir, committed.id), committed);
  return committed;
}

export function rollbackTransaction({ memDir, transaction, now = Date.now(), reason = 'manual' }) {
  if (transaction.status === 'committed') {
    for (const entry of transaction.files) {
      if (!entry.after) continue;
      const current = snapshot(memDir, path.resolve(memDir, entry.before.file));
      if (current.exists !== entry.after.exists || current.text !== entry.after.text) {
        throw new Error(`事务回滚冲突：${entry.before.file} 已在提交后被修改`);
      }
    }
  }
  for (const entry of [...transaction.files].reverse()) restoreSnapshot(memDir, entry.before);
  const rolled = { ...transaction, status: 'rolled-back', rolledBackAt: now, rollbackReason: reason };
  atomicWrite(txFile(memDir, rolled.id), rolled);
  return rolled;
}

export function readTransaction(memDir, id) {
  try { return JSON.parse(fs.readFileSync(txFile(memDir, id), 'utf8')); } catch { return null; }
}

export function listTransactions(memDir, { status = '', limit = 50 } = {}) {
  let files = [];
  try { files = fs.readdirSync(txDir(memDir)).filter((file) => /^[A-Za-z0-9._-]+\.json$/.test(file)); } catch { return []; }
  return files.sort().reverse().map((file) => readTransaction(memDir, path.basename(file, '.json')))
    .filter((tx) => tx && (!status || tx.status === status)).slice(0, limit);
}

export function recoverPreparedTransactions(memDir) {
  const recovered = [];
  for (const tx of listTransactions(memDir, { status: 'prepared', limit: 1000 })) {
    recovered.push(rollbackTransaction({ memDir, transaction: tx, reason: 'recover-prepared' }));
  }
  return recovered;
}


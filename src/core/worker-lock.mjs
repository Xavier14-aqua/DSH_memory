import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeOwned(file, nonce, value) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    const current = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (current?.nonce !== nonce) return false;
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n', 0, 'utf8');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

export function acquireWorkerLock(dataDir, { heartbeatMs = 30_000, staleMs = 180_000, version = 'unknown', now = () => Date.now() } = {}) {
  const stateDir = path.join(path.resolve(dataDir), '.state');
  const file = path.join(stateDir, 'worker.lock');
  const hostname = os.hostname();
  const nonce = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = new Date(now()).toISOString();
    const value = { schema: 1, pid: process.pid, hostname, version, nonce, startedAt, heartbeatAt: startedAt };
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8'); } finally { fs.closeSync(fd); }
      let timer = setInterval(() => {
        value.heartbeatAt = new Date(now()).toISOString();
        writeOwned(file, nonce, value);
      }, Math.max(5_000, Number(heartbeatMs) || 30_000));
      timer.unref?.();
      return {
        ok: true,
        file,
        nonce,
        release() {
          if (timer) clearInterval(timer);
          timer = null;
          const current = readJson(file);
          if (current?.nonce === nonce) try { fs.unlinkSync(file); } catch {}
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: 'lock-io', file };
      const held = readJson(file);
      const heartbeatAt = Date.parse(held?.heartbeatAt ?? held?.startedAt ?? '');
      const fresh = Number.isFinite(heartbeatAt) && now() - heartbeatAt <= Math.max(30_000, Number(staleMs) || 180_000);
      const sameHost = held?.hostname === hostname;
      const sameHostAlive = sameHost && processAlive(held?.pid);
      // 同一台机器上 PID 是否存在比心跳时间更可靠：进程被强制结束时，锁可能还会在
      // staleMs 内保持“新鲜”，旧逻辑因此让双击启动脚本连续几分钟一闪而过。
      // 远端/共享数据目录无法核验对方 PID，才继续依赖心跳保护。
      if (sameHostAlive || (!sameHost && fresh)) return { ok: false, reason: 'already-running', file, holder: held };
      try {
        fs.renameSync(file, `${file}.stale-${now()}-${process.pid}`);
      } catch {
        return { ok: false, reason: 'already-running', file, holder: held };
      }
    }
  }
  return { ok: false, reason: 'already-running', file };
}

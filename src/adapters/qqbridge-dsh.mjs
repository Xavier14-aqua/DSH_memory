// QQbridge integration boundary.
//
// dsh-memory intentionally consumes QQbridge's DSH client adapter instead of
// duplicating its authentication/RPC protocol. Keep that unstable dependency
// isolated here so future QQbridge versions need only one compatibility patch.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const QQBRIDGE_COMPATIBILITY = Object.freeze({
  minimumVersion: '0.2.1-r2',
  requiredFiles: ['src/dsh-client.js', 'src/dsh-endpoint.js'],
  requiredStateFiles: ['state/social-v2.json', 'state/sessions.json'],
  requiredSessionPattern: '^qqb-(g|p)-<id>-<32 hex>$'
});

export function inspectQQbridgeCompatibility(cfg) {
  const home = cfg.bridge.home;
  const packageFile = path.join(home, 'package.json');
  let version = '';
  let packageError = '';
  try {
    version = String(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version ?? '');
  } catch (error) {
    packageError = String(error?.message ?? error);
  }
  const files = QQBRIDGE_COMPATIBILITY.requiredFiles.map((relative) => ({
    relative,
    path: path.join(home, relative),
    exists: fs.existsSync(path.join(home, relative))
  }));
  return {
    ok: !packageError && files.every((item) => item.exists),
    home,
    version,
    packageError,
    files
  };
}

export async function loadQQbridgeDshAdapter(cfg) {
  const clientFile = path.resolve(cfg.worker.dshClientPath);
  const endpointFile = path.join(path.dirname(clientFile), 'dsh-endpoint.js');
  const missing = [clientFile, endpointFile].filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      `QQbridge DSH 适配器不存在：${missing.join(', ')}。`
      + '请设置 config.bridge.home 或 worker.dshClientPath，并先运行 node memory.mjs doctor。'
    );
  }
  const client = await import(pathToFileURL(clientFile).href);
  const endpoint = await import(pathToFileURL(endpointFile).href);
  for (const name of ['NodeApiClient', 'createTurnCollector', 'unwrap']) {
    if (typeof client[name] !== 'function') throw new Error(`QQbridge DSH 客户端缺少导出：${name}`);
  }
  if (typeof endpoint.discoverDshBaseUrl !== 'function') {
    throw new Error('QQbridge DSH 端点模块缺少导出：discoverDshBaseUrl');
  }
  return {
    NodeApiClient: client.NodeApiClient,
    createTurnCollector: client.createTurnCollector,
    unwrap: client.unwrap,
    discoverDshBaseUrl: endpoint.discoverDshBaseUrl
  };
}

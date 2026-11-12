// 等价性测试：用阶段 0 抓的基线，比较重构后的 buildContext 输出是否逐字节一致。
// 用法：node test/equivalence.mjs [记忆库根目录]
// 说明：基线里记了当时 social-v2.json 的 sha256；如果输入已经变了（有新消息），
//       严格比对会失败，此时只能做"结构不崩"检查并打印提示。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildContext } from '../src/core/context.mjs';
import { loadMemoryConfig } from '../src/core/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..');
const cfg = loadMemoryConfig(repo);
const baselineDir = path.join(repo, '.state', 'baseline');

let files = [];
try {
  files = fs.readdirSync(baselineDir).filter((f) => /^qq_context-.*\.json$/.test(f)).sort();
} catch {
  console.log('没有基线文件，跳过（先跑阶段 0 的抓取）');
  process.exit(0);
}
// 只认带输入快照的基线（schema 2），否则无法复现当时的上下文
const usable = files.filter((f) => {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(baselineDir, f), 'utf8')).inputs);
  } catch {
    return false;
  }
});
if (!usable.length) {
  console.log('没有可用的基线（需要带 inputs 的 schema 2 基线），跳过');
  process.exit(0);
}
files = usable;

const baseline = JSON.parse(fs.readFileSync(path.join(baselineDir, files[files.length - 1]), 'utf8'));
const socialPath = cfg.bridge.socialV2;
let liveHash = '';
try {
  liveHash = crypto.createHash('sha256').update(fs.readFileSync(socialPath)).digest('hex');
} catch {
  /* 线上文件读不到也不影响：用基线里的输入快照 */
}

console.log(`基线：${files[files.length - 1]}`);
console.log(`输入：使用基线内快照（${Object.keys(baseline.inputs).length} 个会话）；线上 social-v2 ${liveHash === baseline.socialV2Sha256 ? '一致' : '已变化，忽略'}`);

let pass = 0;
let fail = 0;
for (const [id, sample] of Object.entries(baseline.samples)) {
  const [key, detail] = id.split('|');
  const r = buildContext({
    memDir: repo,
    key,
    detail,
    limit: cfg.context.windowMessages,
    messages: baseline.inputs[key] ?? [],
    maxChars: cfg.context.maxChars
  });
  const sameHash = crypto.createHash('sha256').update(r.text).digest('hex') === sample.sha256;
  if (sameHash) {
    pass += 1;
    console.log(`✅ ${id} 逐字节一致（${r.chars} 字）`);
  } else {
    fail += 1;
    console.log(`❌ ${id} 哈希不一致（基线 ${sample.chars} 字 / 现在 ${r.chars} 字）`);
  }
}
console.log(`\n等价性：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exitCode = 1;

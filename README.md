# DSH_memory

面向 QQbridge + DeepSeek Harness（DSH）的本地长期记忆插件。它提供一个按需只读的
`memory_context` 工具，并用独立 worker 将近期聊天整理为群时间线、成员事实和动态人设。

> 本项目是独立第三方集成，不隶属于 DeepSeek、QQbridge、SnowLuma 或腾讯/QQ。

## 功能

- 群聊和私聊按会话作用域隔离，先过滤后检索；
- 人物、关系、群规、历史事件等问题按需召回，普通闲聊不重复注入整库；
- 每会话可靠 pending 队列，消息滚出 QQbridge 窗口后仍可继续整理；
- 30 条安静批处理、100 条强制批处理和低活跃 12 小时兜底；
- JSON Schema 补丁、本地来源校验、事务写入、审计和整批回滚；
- 事实过期/替换、近重复去重、匿名指标和整理会话预算；
- DSH 安装/卸载、初始化、诊断和离线测试。

## 架构

```text
QQ → SnowLuma/OneBot → QQbridge → DSH QQ Agent
                           │          │
                           │          └─ memory_context（本插件，只读检索）
                           │
                           └─ state/social-v2.json
                                      │
                                      └─ memory worker
                                           → 独立 DSH 整理会话
                                           → timeline / members / persona
```

memory 插件运行在 DSH 内部，因此能读取 DSH 提供的可信 `exec.agent.id`。它还会使用 QQbridge
`sessions.json` 复核会话绑定；文件缺失或身份不一致时失败关闭，避免跨群读取。

## 兼容范围

公开候选版本已验证：

- Windows 10/11；
- Node.js `>=22.13.0`；
- QQbridge `0.2.1-r2`；
- DeepSeek Harness Desktop `0.2.2-rc.1`。

worker 通过版本化适配层复用 QQbridge 的 `src/dsh-client.js` 和 `src/dsh-endpoint.js`，并读取
`state/social-v2.json` / `state/sessions.json`。因此不能声称兼容任意 QQbridge 版本；升级后先运行
`node memory.mjs doctor` 和 `npm test`。完整边界见 [NOTICE.md](NOTICE.md)。

## 安装

### 1. 获取代码

```powershell
git clone https://github.com/Xavier14-aqua/DSH_memory.git DSH_memory
cd DSH_memory
node --version
```

本项目目前没有运行时 npm 依赖，不需要从 npm 下载第三方包。

### 2. 初始化

```powershell
node memory.mjs init
```

该命令会：

- 从 `config.example.json` 创建未跟踪的 `config.json`；
- 创建 `data/groups`、`data/members`、`data/persona`、日志和状态目录；
- 创建最小人设底线和动态人设文件；
- 保留所有已有文件，不覆盖用户数据。

编辑 `config.json`，至少修改：

```json
{
  "dataDir": "./data",
  "bridge": {
    "home": "C:/path/to/QQbridge"
  }
}
```

路径既可以是绝对路径，也可以是相对本仓库根目录的路径。也可使用环境变量：

```powershell
$env:QQBRIDGE_HOME = 'C:\path\to\QQbridge'
```

### 3. 安装到 DSH

先关闭 DSH，然后运行：

```powershell
node scripts/install-dsh.mjs --profile desktop
```

安装器会：

- 在 `~/.dsh/plugins/dsh-memory` 创建指向本仓库的目录链接；
- 在 profile 的 `node_modules` 创建解析链接；
- 备份并更新 profile `package.json`；
- 用带标记的独立区块注册 Cordis 插件；
- 不覆盖其他插件或未知链接。

预览而不修改：

```powershell
node scripts/install-dsh.mjs --profile desktop --dry-run
```

若 DSH 不在默认 `~/.dsh`：

```powershell
node scripts/install-dsh.mjs --dsh-home C:\path\to\.dsh --profile desktop
```

安装完成后重启 DSH。

### 4. 诊断

QQbridge 至少启动过一次、已经生成状态文件后运行：

```powershell
node memory.mjs doctor
```

它会检查 Node、配置、数据目录写权限、QQbridge 版本/文件、消息源、会话绑定、控制台令牌及
DSH 插件注册，但不会打印令牌和聊天正文。

### 5. 配置第一个群

复制示例并把目录名、JSON 内群号替换为真实群号：

```powershell
New-Item -ItemType Directory data\groups\1234567890 -Force
Copy-Item examples\group-profile.md data\groups\1234567890\profile.md
Copy-Item examples\group-meta.json data\groups\1234567890\meta.json
New-Item -ItemType Directory data\groups\1234567890\timeline -Force
```

将群 boot 同步到 QQbridge：

```powershell
node memory.mjs sync --dry
node memory.mjs sync
```

已有 QQ DSH 会话通常需要由 QQbridge 重建后才会重新读取首次 boot。

### 6. 启动 worker

前台运行：

```powershell
npm run worker
```

仅扫描一轮：

```powershell
npm run worker:once
```

Windows 也可以双击 `start-worker.bat`。worker 是独立进程；关闭窗口即停止，不会自动注册系统服务。

## 验证

```powershell
npm test
node memory.mjs status
node memory.mjs pending
node memory.mjs metrics --days 1
node memory.mjs context --key group:1234567890 --query "上次发生了什么" --intent timeline
```

离线测试不需要真实 QQ、QQbridge 或 DSH。当前发布基线为 `106/106`。

## 常用命令

```text
node memory.mjs init
node memory.mjs doctor
node memory.mjs status
node memory.mjs pending [--key group:1234567890]
node memory.mjs context --key group:1234567890 --query "某人是谁" --intent member
node memory.mjs audit [--limit 15]
node memory.mjs rollback latest
node memory.mjs transactions [--recover]
node memory.mjs dedupe --dry
node memory.mjs metrics --days 7
```

## 数据和备份

默认数据位于 `data/`，不会进入 Git：

```text
data/
├─ groups/       群档案和时间线
├─ members/      成员事实
├─ persona/      基础/动态人设
├─ .state/       pending、事务、审计、指标和 worker 锁
├─ .backups/     迁移及人工命令备份
└─ logs/         worker 日志
```

至少备份 `data/`、本仓库 `config.json`、QQbridge `state/` 和 `roles/`。这些目录可能含聊天正文、
QQ/群号和令牌，不要提交 Git 或上传公开 issue。详见 [PRIVACY.md](PRIVACY.md)。

## 升级与卸载

升级前停止 worker 并备份数据，然后更新代码、运行测试和诊断。涉及事实 Schema 的版本先执行文档要求的
`--dry` 迁移。

卸载 DSH 插件：

```powershell
node scripts/uninstall-dsh.mjs --profile desktop --dry-run
node scripts/uninstall-dsh.mjs --profile desktop
```

卸载器只删除自己管理的注册区块和链接，保留 `config.json` 与数据目录。

## 故障排查

- `找不到 dsh-client.js`：检查 `config.json` 的 `bridge.home`，再运行 `doctor`。
- `sessions-unavailable`：QQbridge 尚未生成/正在替换 `state/sessions.json`；为安全起见记忆工具会暂时拒绝。
- worker 找不到 DSH：先启动 DSH；桌面版随机端口由 QQbridge 适配器自动发现。
- 一直没有整理：查看 `node memory.mjs pending` 的 `next=` 原因；低于阈值是正常行为。
- seq reset/gap：查看 `data/.state/gaps.jsonl`；已经滚出 QQbridge 窗口的历史无法凭空恢复。

## 安全、隐私与许可

- [SECURITY.md](SECURITY.md)
- [PRIVACY.md](PRIVACY.md)
- [NOTICE.md](NOTICE.md)
- [LICENSE](LICENSE)

本项目自身采用 MIT License。配套 QQbridge 当前采用非商业许可；SnowLuma、DSH、QQ 和模型服务
各自条款独立适用。部署者需自行判断账号、平台、隐私和模型数据处理风险。

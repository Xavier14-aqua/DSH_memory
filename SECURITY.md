# Security Policy

## 支持范围

安全修复优先覆盖最新发布版本，以及 README 中列出的 QQbridge/DSH 兼容组合。

## 报告漏洞

请使用 GitHub Private Vulnerability Reporting；若仓库尚未启用该功能，请私下联系维护者。
不要在公开 issue 中提交令牌、聊天正文、QQ/群号、本机路径或可复现的真实账号数据。

报告建议包含：受影响版本、最小复现步骤、预期/实际行为和已脱敏日志。

## 安全设计边界

- `memory_context` 通过 DSH 提供的可信 `exec.agent.id` 识别会话，并与 QQbridge `sessions.json` 复核；
- 身份源缺失或不匹配时失败关闭；
- 群/私聊候选在相关性评分前完成作用域过滤；
- worker 写入采用补丁校验、prepared/committed 事务和可审计回滚；
- 本项目不应以管理员权限运行，管理端口不得暴露公网。

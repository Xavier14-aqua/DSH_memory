# Notices and integration boundaries

`DSH_memory` 本身由本仓库 `LICENSE` 中的 MIT License 授权。该授权只覆盖本仓库自行提供的代码，
不授予 QQbridge、DeepSeek Harness、SnowLuma、QQ 或模型服务的任何权利。

## 外部组件

- **QQbridge**：本项目通过本地状态文件、控制台 API 和 DSH 客户端适配器与其互操作。已验证版本为
  `0.2.1-r2`。QQbridge 当前使用 `PolyForm-Noncommercial-1.0.0`，组合使用时仍须遵守其非商业限制。
- **DeepSeek Harness (DSH)**：负责 Agent、模型和工具运行。请以其发行版本所附许可证为准。
- **SnowLuma / QQ**：由 QQbridge 的部署方另行取得和运行，本仓库不包含、不安装、不分发其代码或二进制。
- **模型提供商**：群聊或私聊内容可能由 DSH 发送给部署方配置的模型服务，适用相应服务条款。

本项目是独立的第三方集成，不隶属于、不代表、也不受 DeepSeek、QQbridge、SnowLuma 或腾讯/QQ 背书。

## 兼容性边界

本项目依赖 QQbridge 的以下契约：

- `state/social-v2.json` 和 `state/sessions.json`
- `src/dsh-client.js` 和 `src/dsh-endpoint.js`
- `qqb-g-*` / `qqb-p-*` 会话身份格式
- 本机控制台的 `/api/session/retire` 接口

这些属于版本化集成契约，不承诺兼容任意 QQbridge 版本。升级 QQbridge 后请先运行
`node memory.mjs doctor` 和 `npm test`。

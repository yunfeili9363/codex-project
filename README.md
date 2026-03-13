# Telegram Codex Bridge V2

一个借鉴 `Claude-to-IM` 分层思路、但执行内核仍然是本机 `codex exec` 的 Telegram 工作台。

## 现在有什么

- Telegram 长轮询适配器
- SQLite 持久化：workspace、chat 绑定、任务、审批、审计
- 命名工作区注册表
- `/run` `/status` `/abort` `/workspaces` `/use` `/history` `/help`
- 高风险任务 Telegram inline button 审批
- 任务状态消息编辑、分片发送、基础重试
- 进程重启时把未完成任务标记为 `interrupted`

## 架构

```text
Telegram Adapter
  -> Bridge Manager
  -> Session Router
  -> Risk Evaluator / Permission Broker
  -> Delivery Layer
  -> Codex Executor
  -> SQLite Store
```

## 前提

- 本机已安装并可运行 `codex`
- 本机已登录 Codex
- Node.js 24+（使用 `node:sqlite`）
- 一个 Telegram Bot Token

## 配置

1. 复制 `.env.example` 为 `.env`
2. 编辑 `config/workspaces.json`

`.env` 至少需要：

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=123456789
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
DATABASE_PATH=data/bridge.db
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

`config/workspaces.json` 示例：

```json
[
  {
    "name": "app",
    "path": "/absolute/path/to/repo",
    "defaultSandbox": "workspace-write",
    "defaultModel": "",
    "allowedAdditionalDirs": [],
    "enabled": true,
    "highRisk": false
  }
]
```

字段说明：

- `defaultSandbox`：`read-only` / `workspace-write` / `danger-full-access`
- `highRisk`：`true` 时该 workspace 的任务默认需要审批
- `allowedAdditionalDirs`：额外允许传给 `codex --add-dir` 的目录

## 运行

```bash
npm install
npm run dev
```

## Telegram 命令

- `/run 修复当前仓库的 type error`
- `/status`
- `/abort`
- `/workspaces`
- `/use app`
- `/history`
- `/help`

## 审批行为

以下情况会要求 Telegram 二次确认：

- workspace 被标记为 `highRisk`
- workspace 默认 sandbox 是 `danger-full-access`
- prompt 命中高危规则，比如大规模删除、系统级命令、凭据相关操作

注意：这是“任务启动前审批”，不是运行中逐工具审批。

## 测试

```bash
npm test
```

如果要跑真实 `codex exec` smoke test：

```bash
RUN_REAL_CODEX_SMOKE=1 npm test
```

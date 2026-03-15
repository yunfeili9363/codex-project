# Telegram Codex Bridge V2

一个借鉴 `Claude-to-IM` 分层思路、但执行内核仍然是本机 `codex exec` 的 Telegram 工作台。

## 现在有什么

- Telegram 长轮询适配器
- SQLite 持久化：workspace、chat 绑定、任务、审批、审计
- `chat -> scenario + workspace` 绑定
- 命名工作区注册表
- `content_capture` 场景最小可用版
- `daily_todo` 场景最小可用版
- `ai_news` 手动 `/digest` 最小可用版
- `/run` `/status` `/abort` `/workspaces` `/use` `/scenario` `/bindscenario` `/history` `/help`
- 高风险任务 Telegram inline button 审批
- 任务状态消息编辑、分片发送、基础重试
- 进程重启时把未完成任务标记为 `interrupted`
- 支持“同一个 bot + 多个固定 chat/topic”独立绑定场景和 workspace
- 单实例锁、优雅退出、Telegram 长轮询超时与退避

## 架构

```text
Telegram Adapter
  -> Bridge Manager
  -> Session Router
  -> Scenario Router
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
TELEGRAM_ADMIN_USER_IDS=123456789
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
DATABASE_PATH=data/bridge.db
INSTANCE_LOCK_PATH=data/bridge.lock
WORKSPACES_CONFIG_PATH=config/workspaces.json
YT_DLP_BIN=yt-dlp
WHISPER_PYTHON_BIN=python3
WHISPER_MODEL=turbo
WHISPER_LANGUAGE=auto
```

说明：

- `TELEGRAM_ALLOWED_CHAT_IDS` 是静态白名单，适合你的私聊和长期固定群
- `TELEGRAM_ADMIN_USER_IDS` 是管理员 Telegram 用户 id；管理员在新群里发第一条消息时，bot 会自动把这个群写入 SQLite 动态授权表，后续不用再改 `.env`
- `INSTANCE_LOCK_PATH` 用来防止你不小心启动两个 bot 进程
- `YT_DLP_BIN` / `WHISPER_PYTHON_BIN` / `WHISPER_MODEL` 用于视频脚本提取和音频转录

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

如果想长期稳定运行，推荐直接装成 macOS `launchd` 服务：

```bash
npm run service:install
```

卸载：

```bash
npm run service:uninstall
```

服务日志默认在：

```text
logs/bridge.out.log
logs/bridge.err.log
```

## 推荐聊天格式

## 推荐部署方式：一个 Bot + 多个固定 Chat/Topic

中期最推荐的用法不是把所有内容都塞进一个对话框，而是给同一个 bot 绑定多个固定窗口。

两种都支持：

- 多个独立 chat
- 同一个 Telegram 超级群里的多个 forum topic

系统内部会按 `chat -> scenario + workspace` 绑定；如果是 topic 消息，会按 `chat_id#topic_id` 单独建绑定，所以同一个群里的不同 topic 不会串上下文。

推荐示例：

- Topic A: `content_capture`
- Topic B: `daily_todo`
- Topic C: `ai_news`
- 私聊: `generic`

第一次进入某个固定 chat 或 topic 时，先做两件事：

```text
/use bridge
/bindscenario content_capture
```

之后这个窗口就会记住自己的 workspace 和 scenario。

`generic` 场景下，继续支持带标签的聊天格式：

```text
scenario: 修复登录页报错
workspace: app
```

如果当前 chat 已经绑定 workspace，也可以直接发一句自然语言，系统会在当前 workspace 里执行。

`content_capture` 场景下，直接发文本、链接或“文本 + 链接”即可。  
`daily_todo` 场景下，直接发一段口语化计划，bot 会整理成结构化清单并追加到当天的 markdown。

## Telegram 命令

- `/run 修复当前仓库的 type error`
- `/status`
- `/abort`
- `/workspaces`
- `/use app`
- `/scenario`
- `/bindscenario content_capture`
- `/bindscenario daily_todo`
- `/bindscenario ai_news`
- `/digest 3d`
- `/schedule digest 09:00`
- `/unschedule digest`
- `/history`
- `/help`

## `content_capture` 场景

切到这个场景后，bot 会把输入提炼成结构化内容，并落到 markdown：

```text
/bindscenario content_capture
https://example.com/article 这篇内容值得沉淀，帮我提炼成可复用笔记
```

默认输出目录：

```text
<workspace>/vault/inbox/YYYY-MM-DD/
```

视频链接处理顺序：

1. 先尝试抓字幕/脚本
2. 如果没有字幕，再下载音频并用本地 Whisper 转文字
3. 最后把完整中文脚本写进 markdown

## `daily_todo` 场景

切到这个场景后，直接发今天的想法、任务、担心遗漏的事，bot 会整理成结构化日计划并追加到当天文件：

```text
/bindscenario daily_todo
今天最重要的是把脚本改完，下午处理消息，晚上留半小时复盘
```

默认输出目录：

```text
<workspace>/vault/todo-daily/YYYY-MM-DD.md
```

## `ai_news` 场景

切到这个场景后，用 `/digest` 手动触发一次 AI 资讯整理：

```text
/bindscenario ai_news
/digest
/digest 3d
```

`/digest` 默认按最近 24 小时抓重点，`/digest 3d` 这种形式可以给一个更宽的时间范围提示。

如果你想每天自动推送：

```text
/schedule digest 09:00
```

查看当前窗口的定时任务：

```text
/schedule
```

关闭自动推送：

```text
/unschedule digest
```

默认输出目录：

```text
<workspace>/vault/ai-news/YYYY-MM-DD.md
```

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

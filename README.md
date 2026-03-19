# Telegram Codex Bot

这是一个极简版的 Telegram -> Codex 桥接器。  
现在项目只保留一个通用机器人入口，不再区分 `daily_todo`、`content_capture`、`ai_news` 这些场景。

你可以把它理解成：

- 只有一个 Telegram 机器人
- 你直接给它发文字或语音
- 它会在本机工作区里调用 `codex exec`
- 再把结果回发到 Telegram

## 现在保留的能力

- 文字消息直接执行
- 语音消息先转写再执行
- `/run <内容>`
- `/status`
- `/abort`
- `/history`
- `/help`
- Telegram 白名单和管理员自动授权
- SQLite 持久化任务记录
- `launchd` 常驻运行

## 已移除的内容

这些旧能力已经从主流程里移除：

- 多场景路由
- `daily_todo`
- `content_capture`
- `ai_news`
- `/bindscenario`
- `/digest`
- `/schedule`
- `/unschedule`
- `/待办`
- `/收集`
- `/日报`

## 目录结构

核心入口：

- [src/index.ts](/Users/a1-6/Documents/codex%20project/src/index.ts)
- [src/bridge/manager.ts](/Users/a1-6/Documents/codex%20project/src/bridge/manager.ts)
- [src/codex.ts](/Users/a1-6/Documents/codex%20project/src/codex.ts)
- [src/telegram.ts](/Users/a1-6/Documents/codex%20project/src/telegram.ts)

## 配置

复制 `.env.example` 为 `.env`，至少填这些：

```bash
TELEGRAM_BOT_TOKEN=你的 bot token
TELEGRAM_ALLOWED_CHAT_IDS=你的 chat id
TELEGRAM_ADMIN_USER_IDS=你的 Telegram user id
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

工作区配置默认只有一个：

- [config/workspaces.json](/Users/a1-6/Documents/codex%20project/config/workspaces.json)

当前默认工作区是：

```text
/Users/a1-6/Documents/codex project
```

## 启动

开发模式：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

构建：

```bash
npm run build
```

测试：

```bash
npm test
```

## Telegram 用法

直接发文字：

```text
帮我看看当前项目结构
```

或者显式命令：

```text
/run 帮我检查当前仓库里最重要的入口文件
```

查看状态：

```text
/status
```

中止：

```text
/abort
```

查看最近任务：

```text
/history
```

查看帮助：

```text
/help
```

## 常驻运行

安装 `launchd` 服务：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run service:install
```

卸载：

```bash
npm run service:uninstall
```

日志文件：

- [logs/bridge.out.log](/Users/a1-6/Documents/codex%20project/logs/bridge.out.log)
- [logs/bridge.err.log](/Users/a1-6/Documents/codex%20project/logs/bridge.err.log)

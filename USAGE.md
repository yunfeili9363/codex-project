# 使用说明

现在这套项目只保留一个通用 Telegram 机器人。  
你不需要再切场景，也不需要记 `daily_todo`、`content_capture`、`ai_news` 这些窗口。

## 1. 准备

进入项目目录：

```bash
cd "/Users/a1-6/Documents/codex project"
```

确认 `.env` 已配置。

至少需要：

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=...
TELEGRAM_ADMIN_USER_IDS=...
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

## 2. 启动

前台运行：

```bash
npm run dev
```

后台常驻：

```bash
npm run service:install
```

## 3. 机器人怎么用

### 直接发文字

```text
帮我检查一下当前项目结构
```

### 发语音

直接发语音即可。  
机器人会先转写，再把文字当成普通请求处理。

### 显式命令

发送明确任务：

```text
/run 帮我修一个 type error
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

## 4. 授权

机器人只会响应白名单里的聊天。

如果一个新群还没授权，会提示：

```text
这个对话还没授权。
chat_id: ...
```

你有两种做法：

1. 把这个 `chat_id` 加进 `.env` 的 `TELEGRAM_ALLOWED_CHAT_IDS`
2. 让管理员账号先在群里说一句话，系统会自动授权

## 5. 日志

常驻运行时的日志：

- [logs/bridge.out.log](/Users/a1-6/Documents/codex%20project/logs/bridge.out.log)
- [logs/bridge.err.log](/Users/a1-6/Documents/codex%20project/logs/bridge.err.log)

## 6. 现在已经删掉的旧功能

下面这些都不再是当前架构的一部分：

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

# Telegram Codex Bridge 速查版

## 启动

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

## Telegram 常用命令

```text
/workspaces
/use bridge
/scenario
/bindscenario generic
/bindscenario content_capture
/bindscenario daily_todo
/bindscenario ai_news
/digest
/schedule
/schedule digest 09:00
/unschedule digest
/status
/run 帮我看看当前工作区结构
/history
/abort
/help
```

## 推荐窗口组织

最推荐：

- 一个 bot
- 一个私聊作为 `generic`
- 一个超级群里的多个 topic，分别绑定不同场景

例如：

- `内容沉淀` topic: `/bindscenario content_capture`
- `今日待办` topic: `/bindscenario daily_todo`
- `AI资讯` topic: `/bindscenario ai_news`

每个 chat 或 topic 都要各自执行一次：

```text
/use bridge
/bindscenario <场景名>
```

topic 会被单独记忆，不会和同群其他 topic 串掉。

## 场景示例

### 通用执行

```text
/bindscenario generic
scenario: 帮我看看当前工作区结构
workspace: bridge
```

### 内容沉淀

```text
/bindscenario content_capture
https://example.com/article 这篇内容值得沉淀，帮我提炼成 markdown
```

产出位置默认在：

```text
<workspace>/vault/inbox/YYYY-MM-DD/
```

### 今日待办

```text
/bindscenario daily_todo
今天先把 bridge 的 topic 路由收尾，下午处理测试群，晚上做复盘
```

产出位置默认在：

```text
<workspace>/vault/todo-daily/YYYY-MM-DD.md
```

### AI资讯

```text
/bindscenario ai_news
/digest 3d
/schedule digest 09:00
```

产出位置默认在：

```text
<workspace>/vault/ai-news/YYYY-MM-DD.md
```

关闭自动推送：

```text
/unschedule digest
```

## 常改的两个配置

### `.env`

```bash
TELEGRAM_BOT_TOKEN=你的bot token
TELEGRAM_ALLOWED_CHAT_IDS=你的chat id
TELEGRAM_ADMIN_USER_IDS=你的管理员用户 id
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
DATABASE_PATH=data/bridge.db
INSTANCE_LOCK_PATH=data/bridge.lock
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

如果你希望“把 bot 拉进新群后自动授权”，就把你自己的 Telegram 用户 id 放进 `TELEGRAM_ADMIN_USER_IDS`。之后你在新群里先发一条消息，这个群就会被自动放行并持久保存。

`INSTANCE_LOCK_PATH` 用来防止你重复启动两个 bot 进程。

### `config/workspaces.json`

```json
[
  {
    "name": "bridge",
    "path": "/Users/a1-6/Documents/codex project",
    "defaultSandbox": "workspace-write",
    "defaultModel": "",
    "allowedAdditionalDirs": [],
    "enabled": true,
    "highRisk": false
  }
]
```

## 新增一个项目目录

1. 在工作区下建目录：

```bash
mkdir -p "/Users/a1-6/Documents/codex project/my-app"
```

2. 如果想单独切换它，就把它加进 `config/workspaces.json`
3. 重启：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

## 常驻运行

如果你希望它开机自动跑、断了自动拉起，直接安装 `launchd`：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run service:install
```

卸载：

```bash
npm run service:uninstall
```

日志在：

```text
/Users/a1-6/Documents/codex project/logs/bridge.out.log
/Users/a1-6/Documents/codex project/logs/bridge.err.log
```

## 常见报错

### `Could not read package.json`

没进项目目录：

```bash
cd "/Users/a1-6/Documents/codex project"
```

### `spawn codex ENOENT`

检查：

```bash
ls /Applications/Codex.app/Contents/Resources/codex
```

### `Unauthorized chat`

把你的 chat id 加到 `.env` 的 `TELEGRAM_ALLOWED_CHAT_IDS`，然后重启 bot。

## Git 提交

```bash
cd "/Users/a1-6/Documents/codex project"
git add .
git commit -m "更新说明"
git push
```

注意：`.env` 不要提交。

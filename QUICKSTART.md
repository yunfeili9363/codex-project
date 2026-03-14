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
/status
/run 帮我看看当前工作区结构
/history
/abort
/help
```

## 常改的两个配置

### `.env`

```bash
TELEGRAM_BOT_TOKEN=你的bot token
TELEGRAM_ALLOWED_CHAT_IDS=你的chat id
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
DATABASE_PATH=data/bridge.db
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

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


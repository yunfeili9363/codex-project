# Telegram Codex Bridge 使用文档

这份文档按“从零到可用”的顺序整理，照着做就可以把 bot 跑起来并通过 Telegram 远程操作本机的 Codex。

## 1. 项目位置

当前项目目录：

```bash
/Users/a1-6/Documents/codex project
```

以后所有命令，默认都在这个目录执行。

先进入目录：

```bash
cd "/Users/a1-6/Documents/codex project"
```

## 2. 运行前准备

需要满足这些条件：

- 已安装 Node.js
- 已安装 Git
- 本机已安装 Codex App / Codex CLI
- Telegram Bot 已创建好
- 已有可用的 bot token

检查几个关键依赖：

```bash
node -v
git --version
/Applications/Codex.app/Contents/Resources/codex --help
```

## 3. 配置文件说明

项目里有两个关键配置：

- `.env`
- `config/workspaces.json`

### 3.1 `.env`

当前 `.env` 的核心含义：

```bash
TELEGRAM_BOT_TOKEN=你的Telegram机器人Token
TELEGRAM_ALLOWED_CHAT_IDS=允许使用机器人的Telegram聊天ID
CODEX_APPROVAL=never
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
POLL_TIMEOUT_SECONDS=30
DATABASE_PATH=data/bridge.db
WORKSPACES_CONFIG_PATH=config/workspaces.json
```

字段说明：

- `TELEGRAM_BOT_TOKEN`
  Telegram 机器人的 token。
- `TELEGRAM_ALLOWED_CHAT_IDS`
  允许操作 bot 的 chat id。只有这里面的人能发命令。
- `CODEX_APPROVAL`
  `codex exec` 的审批模式。当前建议保持 `never`。
- `CODEX_BIN`
  Codex CLI 的实际路径。你这台机器已经配置好了。
- `POLL_TIMEOUT_SECONDS`
  Telegram 长轮询超时时间，默认 `30`。
- `DATABASE_PATH`
  SQLite 数据库文件位置。
- `WORKSPACES_CONFIG_PATH`
  工作区注册表文件路径。

### 3.2 `config/workspaces.json`

这个文件控制“bot 允许远程操作哪些目录”。

示例：

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

字段说明：

- `name`
  工作区名字，在 Telegram 里用 `/use <name>` 切换。
- `path`
  工作区绝对路径。
- `defaultSandbox`
  默认执行权限。推荐 `workspace-write`。
- `defaultModel`
  默认模型，不确定可以留空。
- `allowedAdditionalDirs`
  额外允许访问的目录列表。
- `enabled`
  是否启用这个工作区。
- `highRisk`
  如果是 `true`，这个工作区的任务默认需要 Telegram 二次审批。

## 4. 启动项目

先安装依赖：

```bash
cd "/Users/a1-6/Documents/codex project"
npm install
```

启动开发模式：

```bash
npm run dev
```

如果看到类似输出，说明服务起来了：

```bash
telegram-codex-bridge starting with 1 workspace(s)
```

注意：一定要先 `cd` 到项目目录，再运行 `npm run dev`。

## 5. Telegram 里怎么用

先给 bot 发消息。

推荐按这个顺序测试：

### 5.1 查看工作区

```text
/workspaces
```

作用：

- 查看当前有哪些可用工作区
- 当前选中的工作区会有标记

### 5.2 切换工作区

```text
/use bridge
```

如果你以后在 `workspaces.json` 里加了更多项目，就能切换到别的工作区。

### 5.3 查看状态

```text
/status
```

作用：

- 查看当前有没有任务在跑
- 如果没有运行中的任务，会显示最近一次任务状态

### 5.4 执行任务

```text
/run 帮我看看当前工作区结构
```

再比如：

```text
/run 帮我分析这个项目的 README 和主要入口文件
```

### 5.5 中止任务

```text
/abort
```

如果当前 chat 有任务在执行，会向本机 Codex 发送终止信号。

### 5.6 查看历史

```text
/history
```

会显示最近任务的摘要。

### 5.7 查看帮助

```text
/help
```

## 6. 风险审批机制

有些任务不会直接执行，而是先要求你在 Telegram 里点按钮确认。

触发审批的典型情况：

- 工作区被标记为 `highRisk`
- 使用危险权限
- prompt 命中高风险规则
  例如：
  - 删除大量文件
  - 系统级命令
  - 凭据、token、密码相关操作

你会在 Telegram 里看到两个按钮：

- `Approve once`
- `Deny`

说明：

- `Approve once`：本次任务继续执行
- `Deny`：本次任务直接拒绝

## 7. 新增项目目录怎么做

如果你以后想把新的项目也放到 `/Users/a1-6/Documents/codex project` 下面，有两种方式。

### 方式 A：直接放在当前工作区根目录下

例如新建：

```bash
mkdir -p "/Users/a1-6/Documents/codex project/my-new-app"
```

然后你在 Telegram 里要求 Codex 进入这个子目录操作即可。

### 方式 B：把它单独注册成一个工作区

编辑 `config/workspaces.json`，加一项：

```json
{
  "name": "my-new-app",
  "path": "/Users/a1-6/Documents/codex project/my-new-app",
  "defaultSandbox": "workspace-write",
  "defaultModel": "",
  "allowedAdditionalDirs": [],
  "enabled": true,
  "highRisk": false
}
```

然后重启 bot：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

之后在 Telegram 里切换：

```text
/use my-new-app
```

## 8. 提交代码到 GitHub

当前这个项目已经完成了本地 git 初始化和首个 commit。

本地仓库路径：

```bash
/Users/a1-6/Documents/codex project
```

### 8.1 当前仓库状态检查

```bash
cd "/Users/a1-6/Documents/codex project"
git status
git remote -v
```

### 8.2 提交新的改动

```bash
cd "/Users/a1-6/Documents/codex project"
git add .
git commit -m "你的提交说明"
git push
```

### 8.3 注意 `.env` 不要提交

`.env` 里有 Telegram token，不能传到 GitHub。

当前 `.gitignore` 已经忽略了 `.env`，但每次提交前仍建议确认：

```bash
git status --short
```

如果里面出现 `.env`，先停下来检查。

## 9. GitHub Desktop 怎么用这个仓库

如果你用 GitHub Desktop，不要打开空目录，而要打开真正的项目目录：

```bash
/Users/a1-6/Documents/codex project
```

在 GitHub Desktop 里：

1. 选择 `Add Existing Repository`
2. 选择 `/Users/a1-6/Documents/codex project`
3. 打开后看 `History`
4. 应该能看到已有 commit
5. 然后点击 `Push origin`

## 10. 常见报错处理

### 10.1 `npm error enoent Could not read package.json`

原因：

你不在项目目录里运行命令。

解决：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

### 10.2 `Task failed. spawn codex ENOENT`

原因：

系统找不到 `codex` 可执行文件。

解决：

- 已经在 `.env` 里配置了：

```bash
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex
```

- 修改后重启 bot

### 10.3 Telegram 里提示 `Unauthorized chat`

原因：

当前 Telegram chat id 不在 `.env` 的 `TELEGRAM_ALLOWED_CHAT_IDS` 里。

解决：

- 把你的 chat id 加进去
- 重启 bot

### 10.4 GitHub Desktop 显示 `no commits`

原因：

打开的是错误的本地目录，不是我们实际工作的项目目录。

解决：

改为打开：

```bash
/Users/a1-6/Documents/codex project
```

## 11. 推荐操作流程

如果你日常要用这个 bot，建议每次按这个顺序：

1. 打开终端
2. 进入项目目录
3. 启动 bot
4. 去 Telegram 发命令

对应命令：

```bash
cd "/Users/a1-6/Documents/codex project"
npm run dev
```

Telegram 里：

```text
/workspaces
/status
/run 帮我分析当前目录结构
```

## 12. 后续可扩展项

如果后面我们继续升级，比较适合加这些：

- `/resume` 续接 thread
- 更细粒度的流式进度显示
- 文件上传后交给 Codex 处理
- 更多工作区管理命令
- 后台常驻运行（pm2 / launchd）


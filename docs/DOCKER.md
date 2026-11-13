# Docker 一键分发 / Docker distribution

OpenCool 的 Docker 镜像包含完整烘焙流水线：**零 LLM、零 API key、零外部服务**。容器每 30 分钟选择最新到期档期（默认 06/13/19，上海时区），侧车已存在则空转，缺失则重跑全部烘焙（自愈）。

## 最快开始 / Quick start

```bash
docker pull ghcr.io/fudan2026/opencool:latest
mkdir -p daily_reports logs
docker run -d --name opencool \
  -v "$PWD/daily_reports:/app/daily_reports" \
  -v "$PWD/logs:/app/logs" \
  ghcr.io/fudan2026/opencool:latest
```

报告写入本机 `./daily_reports`，打开 `daily_reports/index.html` 查看。

## docker-compose

```bash
docker compose up -d --build
```

`docker-compose.yml` 会挂载 `./daily_reports` 和 `./logs`，并在容器退出后自动重启。

## 本地构建 / Build locally

```bash
docker build -t opencool:local .
docker run --rm -v "$PWD/daily_reports:/app/daily_reports" opencool:local
```

## 常用环境变量 / Common env

| 变量 | 默认 | 用途 |
|---|---|---|
| `LLM_MODE` | `off` | 保持零 AI；如需 LLM 另配后端和 key |
| `REPORT_TZ` | `Asia/Shanghai` | 档期时区 |
| `REPORT_HOUR` | `6,13,19` | 每日期次小时 |
| `REPORT_LOOKBACK_DAYS` | `1` | 门控回看天数（跨零点补发漏掉的期次） |
| `EDITION_DATE` | 未设 | `YYYY-MM-DD`，仅供门控补发历史档期；格式非法或未来日期会直接报错 |
| `REPORT_LOCALE` | `zh` | 界面语言（zh/en） |
| `LOOP_MINUTES` | `30` | 调度检查间隔（分钟） |
| `DAILY_ONCE` | 未设 | 设 `1` 时只评估一次并退出（冒烟测试） |
| `DAILY_FORCE` | 未设 | 设 `1` 时即使档期已存在也强制重建 |
| `DISABLE_SOURCE_IDS` | 未设 | 逗号分隔的源 ID，临时摘除抖动源 |
| `THEMES_EXTRA_FILE` | `themes.custom.json` | 用户自定义题材文件路径 |

## 常用操作 / Operations

```bash
# 单次全管线冒烟
DAILY_ONCE=1 DAILY_FORCE=1 docker run --rm \
  -v "$PWD/daily_reports:/app/daily_reports" \
  ghcr.io/fudan2026/opencool:latest

# 查看日志
docker logs -f opencool

# 停止 / 删除
docker rm -f opencool
```

镜像由 `.github/workflows/docker.yml` 在 main 推送时自动构建并推送到 **GHCR**：`ghcr.io/fudan2026/opencool:latest` 与 `ghcr.io/fudan2026/opencool:<sha>`，支持 `linux/amd64` 和 `linux/arm64`。

> 本次没有 GLM 对话通道；需要 key 的 LLM 功能一律默认关闭。订阅邮箱后端见 `subscribe.html`，当前只保存本地订阅意向，不向任何服务器发送邮箱。

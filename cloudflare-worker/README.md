# OpenCool external dispatcher (optional, owner-activated)

OpenCool 的档期时间（06:00 / 13:00 / 19:00，上海时间）是**目标，不是承诺**：GitHub
Actions 的定时触发实测丢拍严重。这个 Worker 是一个可选的补救层：用 Cloudflare 的
cron（不受 GitHub 调度队列影响）每 15 分钟调用一次 Daily Brief 工作流的
`workflow_dispatch` API。工作流内部的调度门会自行判断该做什么：全部档期已发布时
只是一次廉价的空跑，不构建任何东西。

**这是纯粹可选的独立基础设施：仓库里的任何代码都不依赖它，不部署它站照常运行，
删除它也不影响任何已发布内容。** 工作流本身已接受 `workflow_dispatch`，激活本
Worker 不需要对仓库做任何改动。

## Owner 激活步骤

1. **创建 fine-grained PAT**（仓库 owner 操作）：
   GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token：
   - Repository access：Only select repositories → `Fudan2026/opencool`
   - Permissions：**Actions → Read and write**（Metadata: Read 自动带上）
   - 过期时间按需设置；PAT 只用于触发，拿不到代码与 secrets

2. **部署 Worker**（本目录）：
   ```bash
   cd cloudflare-worker
   npx wrangler login        # 首次需要 Cloudflare 账号
   npx wrangler deploy
   ```

3. **配置 secret**（部署之后，secret 不能先于 Worker 存在）：
   ```bash
   npx wrangler secret put DISPATCH_PAT   # 粘贴第 1 步的 PAT
   ```

4. **验证**：
   - 仓库 Actions 页每 15 分钟出现一次 Daily Brief 运行（档期齐全时是几分钟的空跑）
   - 访问 Worker URL（`wrangler deploy` 输出的地址）返回状态 JSON，
     `patConfigured: true` 即配置完成

## 行为说明

- 每 15 分钟 `POST /repos/Fudan2026/opencool/actions/workflows/daily.yml/dispatches`（`ref: main`）
- 96 次/天，远低于 GitHub API 限额；工作流的 in-flight 防重入护栏避免堆叠构建
- 触发的是与 push/定时完全相同的工作流：build job 仍然固定 `LLM_MODE=off`，
  零 AI · 零 Token 的结构性保证不受任何影响
- 日志在 Cloudflare Dashboard → Workers → opencool-dispatcher → Logs，
  可看到每次 dispatch 的接受/拒绝结果

## 停用

```bash
cd cloudflare-worker && npx wrangler delete
```

站点立刻回到只依赖 GitHub 自身调度的状态，实测发布时间仍会照常公开在
[integrity 页](https://fudan2026.github.io/opencool/integrity.html)。

# myteam 三环境系统

## 铁律

0. **参考再实现** — 实现功能前先查 `docs/clowder-ai-reference.md`，看 clowder-ai 怎么做的
1. **Runtime 不能动** — 运行态单实例，禁止直接修改代码、禁止随意重启（需 `MYTEAM_RUNTIME_RESTART_OK=1`）
2. **Feature 是唯一开发入口** — 所有代码改动只能在 feature worktree 里做
3. **改动经 PR 合回 main** — feature 分支 → squash merge → main → runtime/alpha sync
4. **DB 隔离** — 每个环境独立 SQLite，禁止 flush runtime DB
5. **端口纪律** — 3001/5173 属于 runtime，alpha 用 3011/5183，feature 按 offset 派生
6. **Sibling Path** — worktree 必须在 `../myteam-{name}`，不在项目内部

## 环境总览

| 环境 | 路径 | 分支 | API | Web | DB | 启动方式 |
|------|------|------|------|------|-----|---------|
| **Runtime** | `../myteam-runtime` | `runtime/main-sync` | 3001 | 5173 | `~/.myteam/runtime/` | `tsx`（无 watch，被动冻结） |
| **Alpha** | `../myteam-alpha` | `alpha/main-sync` | 3011 | 5183 | `~/.myteam/alpha/` | `tsx watch` + `vite dev` |
| **Feature** | `../myteam-{name}` | `feat/{name}` | 3102−offset | 5102−offset | `~/.myteam/feature-{name}/` | `tsx watch` + `vite dev` |

## 机械强制

### Git Hooks（自动安装）

`pnpm install` 的 `postinstall` 自动设置 `core.hooksPath` 到 `.githooks`（绝对路径，所有 worktree 共享）。

| Hook | 文件 | 拦截 |
|------|------|------|
| `pre-commit` | `.githooks/pre-commit` | 拒绝在 `runtime/main-sync`、`alpha/main-sync` 分支提交；拒绝在 `myteam-runtime`、`myteam-alpha` 目录提交 |
| `pre-push` | `.githooks/pre-push` | 同上，拦截 push |

主仓 `master` 分支允许提交（写计划、文档、配置）。绕过：`git commit --no-verify`（不推荐）。

手动安装：`pnpm guards:install`

### 启动守卫

| 守卫 | 位置 | 效果 |
|------|------|------|
| `Guard-MainBranchStart` | `scripts/start-dev.ps1` | 拒绝在 `master`/`main` 分支启动 dev server |
| `Guard-PortKillOwnership` | `scripts/start-dev.ps1` | 拒绝杀 cwd 在当前 worktree 外的进程（防跨 worktree 互杀） |
| `ensure_restart_authorized` | `scripts/runtime-worktree.ps1` | runtime 已在跑时拒绝重启（需 `MYTEAM_RUNTIME_RESTART_OK=1`） |

### 端口派生

Feature worktree 端口由 `scripts/derive-ports.mjs` 派生：
- offset = 负 10 的倍数，范围 [-100, 0]
- API = 3102 − offset
- Web = 5102 − offset

## 完整开发流程

### 首次初始化

```bash
# 1. 关联远程
git remote add origin https://github.com/fanppp/myteam.git
git push -u origin master:main

# 2. 创建 runtime worktree
pnpm runtime:init

# 3. 启动 runtime（常驻，不随开发启停）
pnpm runtime:start
```

### 日常开发 → 合回主干 → 重启 Runtime

```
① feature:create → ② feature:start → ③ 开发+提交 →
④ feature:pr → ⑤ squash merge → ⑥ sync runtime →
⑦ cleanup worktree → ⑧ restart runtime
```

```bash
# ① 创建 feature worktree（自动写 .env）
pnpm feature:create myfeature

# ② 启动 feature 开发环境
pnpm feature:start myfeature

# ③ 在 feature worktree 里开发、提交
cd ../myteam-myfeature
# ... edit code ...
git add -A && git commit -m "feat: xxx"

# ④ Push + 创建 PR（如有 gh）
pnpm feature:pr myfeature
# 或手动：
git push -u origin feat/myfeature
gh pr create --base main --head feat/myfeature

# ⑤ Squash merge（GitHub UI 或 gh pr merge --squash --delete-branch）
#    无 gh 时本地操作：
#    cd ../myteam
#    git merge --squash feat/myfeature
#    git commit -m "feat: xxx (squashed from feat/myfeature)"

# ⑥ Push main + sync runtime
git push origin master:main
pnpm runtime:sync          # ff-only merge origin/main → runtime/main-sync

# ⑦ 清理 feature worktree（fail-closed：dirty 则停）
pnpm feature:remove myfeature

# ⑧ 重启 runtime 加载新代码
$env:MYTEAM_RUNTIME_RESTART_OK = '1'
pnpm runtime:start
```

### 一键合并 + 清理（如有 gh）

```bash
# push + create PR
pnpm feature:pr myfeature

# review 通过后，一键 squash merge + sync + cleanup
pnpm feature:pr myfeature -Merge
```

### 验收流程

```bash
# Alpha 同步 main
pnpm alpha:sync

# 启动 alpha 验收
pnpm alpha:start

# 查看 runtime 状态
pnpm runtime:status
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MYTEAM_ENV` | 环境名 | `default` |
| `MYTEAM_API_PORT` | API 端口 | `3001` |
| `MYTEAM_WEB_PORT` | Web 端口 | `5173` |
| `MYTEAM_DB_PATH` | SQLite 路径 | 按 env 自动派生 |
| `MYTEAM_RUNTIME_RESTART_OK` | Runtime 重启授权 | 未设置 |
| `MYTEAM_ALLOW_MAIN_DEV` | 允许在 main 启动 dev | 未设置 |

## 环境隔离

- **DB**: `~/.myteam/{env}/data.sqlite` — 每个环境独立数据库
- **端口**: runtime/alpha 固定端口，feature 按 offset 派生
- **代码**: 每个 worktree 是独立的工作目录，git 分支隔离
- **配置**: `config/` 目录从 worktree 根读取，各环境独立
- **Git hooks**: 绝对路径共享，所有 worktree 统一拦截

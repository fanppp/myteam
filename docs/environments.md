# myteam 三环境系统

## 铁律

1. **Runtime 不能动** — 运行态单实例，禁止直接修改代码、禁止随意重启（需 `MYTEAM_RUNTIME_RESTART_OK=1`）
2. **Feature 是唯一开发入口** — 所有代码改动只能在 feature worktree 里做
3. **改动经 PR 合回 main** — feature 分支 → PR → squash merge → main → runtime/alpha sync

## 环境总览

| 环境 | 路径 | 分支 | API | Web | DB |
|------|------|------|------|------|-----|
| **Runtime** | `../myteam-runtime` | `runtime/main-sync` | 3001 | 5173 | `~/.myteam/runtime/data.sqlite` |
| **Alpha** | `../myteam-alpha` | `alpha/main-sync` | 3011 | 5183 | `~/.myteam/alpha/data.sqlite` |
| **Feature** | `../myteam-{name}` | `feat/{name}` | 3102−offset | 5102−offset | `~/.myteam/feature-{name}/data.sqlite` |

- **Runtime**: 在线服务，`tsx`（无 watch），被动冻结
- **Alpha**: 验收环境，镜像 `origin/main`，`tsx watch` + `vite dev`
- **Feature**: 开发环境，`tsx watch` + `vite dev`，按 feature 名派生端口

## 端口派生

Feature worktree 的端口由 `scripts/derive-ports.mjs` 派生：
- offset = 负 10 的倍数，范围 [-100, 0]
- API = 3102 − offset
- Web = 5102 − offset

## 使用流程

### 首次初始化

```bash
# 1. 关联远程
git remote add origin https://github.com/fanppp/myteam.git
git push -u origin master:main

# 2. 创建 runtime worktree
pnpm runtime:init

# 3. 启动 runtime
pnpm runtime:start
```

### 日常开发流程

```bash
# 1. 创建 feature worktree
pnpm feature:create myfeature

# 2. 启动 feature 环境
pnpm feature:start myfeature

# 3. 在 feature worktree 里开发、提交
cd ../myteam-myfeature
# ... edit code ...
git add -A && git commit -m "feat: xxx"

# 4. 推送 + 创建 PR
git push -u origin feat/myfeature
gh pr create --base main --head feat/myfeature

# 5. PR 合并后，同步 runtime
pnpm runtime:sync
pnpm alpha:sync

# 6. 清理 feature worktree
pnpm feature:remove myfeature
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

## 环境隔离

- **DB**: `~/.myteam/{env}/data.sqlite` — 每个环境独立数据库
- **端口**: runtime/alpha 固定端口，feature 按 offset 派生
- **代码**: 每个 worktree 是独立的工作目录，git 分支隔离
- **配置**: `config/` 目录从 worktree 根读取，各环境独立

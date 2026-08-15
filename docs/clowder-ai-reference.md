# clowder-ai 三环境实现参考

> 本文档记录 clowder-ai 的三环境（main/runtime/feature）实现细节，作为 myteam 的参考真相源。
> 实现功能前先查此文档，确认 clowder-ai 的做法再动手。

## 1. 三环境总览

| 环境 | 路径 | 分支 | 前端 | API | Redis | 启动方式 |
|------|------|------|------|-----|-------|---------|
| **Runtime (prod)** | `../cat-cafe-runtime` | `runtime/main-sync` | 3003 | 3004 | 6399 (sanctum) | `node dist/index.js` (无 watch) |
| **Alpha (staging)** | `../cat-cafe-alpha` | `alpha/main-sync` | 3011 | 3012 | 6398 | `pnpm alpha:start` |
| **Feature (dev)** | `../cat-cafe-{name}` | `feat/{name}` | 5102−offset | 3102−offset | 6398+offset | `pnpm dev:direct` |

### 铁律

1. **Runtime Sanctuary** — 永远不删、不直接修改、不随意重启（需 `CAT_CAFE_RUNTIME_RESTART_OK=1`）
2. **Feature-Only Development** — 所有代码改动只在 feature worktree 里做，禁止直接在 main 上改
3. **PR Gate** — feature → PR → squash merge → main → runtime/alpha sync
4. **Redis Sanctum** — 端口 6399 是用户数据边界，dev 永远不能用
5. **Sibling Path** — worktree 必须在 `../cat-cafe-{name}`，永远不在项目内部

## 2. 主仓的角色

主仓 **只用于**：
- 源头（origin/main 同步目标）
- 写实施计划（plan 在 main 上写 + 提交，然后才开 worktree）
- PR 合入后的 feature doc 同步（更新 Phase ✅ / AC / Timeline）

主仓 **不用于**：
- 代码实现
- 运行 dev server
- Bug fix

### guard_main_branch_start 守卫

`start-dev.sh` 有机械守卫：
- 检测到 `cat-cafe` 仓 + `main` 分支 → `exit 1`
- 错误信息引导用户使用 runtime worktree 或 feature worktree
- 唯一绕过：`CAT_CAFE_ALLOW_MAIN_DEV=1`（不推荐）

## 3. Feature Worktree 完整流程

### 3.1 创建 worktree

```bash
# 前置：main 双向同步 (F073 gate)
git status --porcelain docs/  # 必须干净
git fetch origin main
git rev-list --count origin/main..main  # ahead=0
git rev-list --count main..origin/main  # behind=0

# 创建
git worktree add ../cat-cafe-{feature-name} -b feat/{feature-name}
cd ../cat-cafe-{feature-name}
env -u NODE_ENV pnpm install

# 写 .env
cat > .env <<EOF
REDIS_URL=redis://localhost:6398
NEXT_PUBLIC_API_URL=http://localhost:3102
WORKTREE_PORT_OFFSET=0
EOF

# 基线测试必须通过
pnpm test

# 启动全栈 dev server (HMR)
pnpm dev:direct   # 不是 pnpm dev！
```

### 3.2 端口派生 — `derive-worktree-ports.mjs`

纯函数 + CLI 入口，输出 shell-eval-able export 行：

```js
REDIS_SANCTUM = 6399  // 铁律
REDIS_BASE = 6398
API_BASE = 3102
WEB_BASE = 5102

deriveWorktreePorts(offset):
  validate: 整数, ≤0, ≥-100, 10的倍数
  redis = 6398 + offset  // 向下
  if redis == 6399: REJECT
  if redis < 6000: REJECT
  api  = 3102 - offset   // 向上
  web  = 5102 - offset
```

### 3.3 预留端口表

| Name | OFFSET | Redis | API | Web |
|------|--------|-------|-----|-----|
| alpha | 0 | 6398 | 3102 | 5102 |
| opus-47 | -10 | 6388 | 3112 | 5112 |
| sonnet | -20 | 6378 | 3122 | 5122 |
| glm | -30 | 6368 | 3132 | 5132 |
| deepseek | -40 | 6358 | 3142 | 5142 |
| kimi | -50 | 6348 | 3152 | 5152 |
| qwen | -60 | 6338 | 3162 | 5162 |

### 3.4 `pnpm dev:direct` 启动序列

`start-dev.sh` 在 feature worktree 中执行：

1. `apply_worktree_port_offset()` — 调用 `derive-worktree-ports.mjs`，eval stdout（stderr 分离防注入），sanctum 防御
2. 强制关闭所有 sidecar（ANTHROPIC_PROXY/ASR/TTS/LLM_POSTPROCESS/EMBED/AUDIO/PREVIEW_GATEWAY = 0）
3. `guard_main_branch_start()` — 不触发（worktree 在 feat/ 分支）
4. `guard_runtime_redis_sanctuary()` — 阻止非 runtime 启动碰 6399
5. `kill_managed_ports` — 释放 worktree 端口，但 `guard_port_kill_ownership` 拒绝杀 cwd 在项目外的进程（防 worktree 互杀 runtime/alpha）
6. `build_packages` — shared → mcp → api（顺序构建）
7. `setup_storage` — 启动隔离 Redis（按端口派生 data dir）
8. 启动 API: `cd packages/api && pnpm run dev`（watch mode）
9. 启动 Web: `cd packages/web && next dev -p $WEB_PORT`（HMR）

### 3.5 为什么不用 `pnpm dev`

`pnpm dev` = `pnpm -r --parallel run dev`，绕过 `start-dev.sh` 的 OFFSET preflight：
- Redis 可能静默回退到 6399（用户数据边界）
- Sidecar 不会被强制关闭
- 端口冲突不会被检测

## 4. Runtime 环境

### 4.1 被动冻结 (ADR-039)

- Runtime 重启 ONLY on 显式 `pnpm start`
- `start` 内部做：sync (ff-only) + build invariant + restart
- 不用 `tsx watch` — 用 `node dist/index.js`
- HEAD-keyed build stamp (`.build-commit` 文件)：只在 source 变了才 rebuild
- Anti-self-TERM guard：API 端口已占用时拒绝 kill（需 `*_RESTART_OK=1`）

### 4.2 Runtime 启动流程

`runtime-worktree.sh start`:
1. 检查 API 端口已占用 → 拒绝 kill（需 `CAT_CAFE_RUNTIME_RESTART_OK=1`）
2. `sync_runtime_worktree` — ff-only merge origin/main
3. `ensure_runtime_start_prereqs` — deps + HEAD-keyed dist freshness gate
4. `exec start-dev.sh --prod-web --profile=opensource`

### 4.3 导出变量

- `CAT_CAFE_RUNTIME_ROOT=$RUNTIME_DIR` — binary 运行目录
- `CAT_CAFE_WORKSPACE_ROOT=$PROJECT_DIR` — 用户工作目录（分离 F061）
- `CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1` — runtime 拥有全局 sidecar
- `CAT_CAFE_DIRECT_NO_WATCH=1` — 用 `node dist/` 不用 `tsx watch`

## 5. Alpha 环境

- 镜像 `origin/main`，验收已合入改动
- 所有 sidecar 关闭
- `CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED=1` — 防止 alpha 改 runtime 的 services.json
- 复用根 .env 的 secrets（alpha 不需要自己的 API keys）
- 端口 3011/3012/4111/6398

## 6. DB/存储隔离

### SQLite (按 repoRoot 自然隔离)
- `EVIDENCE_DB` = `{repoRoot}/evidence.sqlite`
- `WORLD_DB` = `{repoRoot}/world.sqlite`
- `GLOBAL_KNOWLEDGE_DB` = `~/.cat-cafe/global_knowledge.sqlite`（跨 worktree 共享）

### Redis (按端口派生)
- Storage key: `default_redis_storage_key(profile, port)` → port==6399 用 bare profile，否则 `{profile}-{port}`
- Data dir: `~/.cat-cafe/redis-{key}`
- Backup dir: `~/.cat-cafe/redis-backups/{key}`

## 7. 跨 Worktree 安全

### guard_port_kill_ownership
杀端口前检查 PID 的 cwd：
- cwd 在当前项目内 → 允许杀
- cwd 在项目外 → 拒绝杀（防 feature worktree 杀 runtime/alpha）
- 绕过需 `CAT_CAFE_RUNTIME_RESTART_OK=1`

### guard_main_branch_start
- `cat-cafe` 仓 + `main` 分支 → `exit 1`
- 引导用 runtime worktree 或 feature worktree

### guard_runtime_redis_sanctuary
- 非 `--prod-web` 启动 + `REDIS_PORT=6399` → 阻止

## 8. 完整 SOP 流程

```
feat-lifecycle kickoff → Design Gate → writing-plans(在 main 上)
  → worktree → tdd → quality-gate
  → [fresh-context-review] → request-review → receive-review
  → merge-gate(squash merge) → 当场清理 worktree
  → feat-lifecycle completion(cross-cat vision guardian)
```

### 例外路径

**极微改动直接 main**（4 条件全满足）：
1. 纯日志/配置/注释/文档（不涉及业务逻辑）
2. diff ≤ 5 行
3. 类型检查通过
4. 不涉及可测行为

**Hotfix**：
- 不是绕道，是 label — 仍需 worktree + cross-cat review + squash merge
- 触发 14 天升级审查提醒

## 9. myteam 差距对照

| clowder-ai 有 | myteam 状态 | 待补 |
|--------------|------------|------|
| `guard_main_branch_start` | 无 | 加 `start-dev.ps1` 守卫 |
| `pnpm dev:direct` (start-dev.sh) | 无 | 加 `scripts/start-dev.ps1` |
| `derive-worktree-ports.mjs` | ✅ `derive-ports.mjs` | 已有 |
| `runtime-worktree.sh` | ✅ `runtime-worktree.ps1` | 已有 |
| `alpha-worktree.sh` | ✅ `alpha-worktree.ps1` | 已有 |
| worktree SKILL.md | 无 | 加文档 |
| `guard_port_kill_ownership` | 无 | 加到 helpers |
| `guard_runtime_redis_sanctuary` | N/A | myteam 无 Redis |
| HEAD-keyed build stamp | 无 | 后续加 |
| Feature doc sync | 无 | 后续加 |
| `.env` 模板 for worktree | 无 | 加 `.env.worktree` |

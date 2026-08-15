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
| `guard_main_branch_start` | ✅ `start-dev.ps1` Guard-MainBranchStart | 已有 |
| `pnpm dev:direct` (start-dev.sh) | ✅ `scripts/start-dev.ps1` | 已有 |
| `derive-worktree-ports.mjs` | ✅ `derive-ports.mjs` | 已有 |
| `runtime-worktree.sh` | ✅ `runtime-worktree.ps1` | 已有 |
| `alpha-worktree.sh` | ✅ `alpha-worktree.ps1` | 已有 |
| worktree SKILL.md | ✅ `docs/environments.md` | 已有 |
| `guard_port_kill_ownership` | ✅ `start-dev.ps1` Guard-PortKillOwnership | 已有 |
| `guard_runtime_redis_sanctuary` | N/A | myteam 无 Redis |
| `ensure_restart_authorized` | ✅ `runtime-worktree.ps1` | 已有 |
| HEAD-keyed build stamp | 无 | 后续加 |
| Feature doc sync | 无 | 后续加 |
| `.env` 模板 for worktree | ✅ `feature-worktree.ps1` 自动生成 | 已有 |
| Git pre-commit hook (默认关闭) | ✅ `.githooks/pre-commit` + postinstall 自动安装 | 已有，且更好 |
| Git pre-push hook (文件不存在) | ✅ `.githooks/pre-push` | 已有，clowder-ai 缺失 |
| PR 流程脚本 | ✅ `scripts/feature-pr.ps1` | 已有 |
| `pnpm gate` 质量门禁 | 无 | 后续加 |
| cloud review (@codex review) | N/A | myteam 无多模型 review |

## 10. 机械强制 vs 文档约束（实测结论）

### clowder-ai 的真相

clowder-ai 的强制**绝大部分是文档**，机械强制很窄：

| 机制 | 机械强制？ | 实际效果 |
|------|-----------|---------|
| `guard_main_branch_start` | ✅ 但只拦 dev server 启动 | CLI agent 写文件不经过这个 |
| `guard_port_kill_ownership` | ✅ 但只在启动脚本里 | 防 worktree 互杀进程 |
| `ensure_restart_authorized` | ✅ | 防 runtime 被意外重启 |
| Git `pre-commit` hook | ⚠️ 默认关闭 | 需手动 `pnpm guards:install` |
| Git `pre-push` hook | ❌ 文件不存在 | 文档说有但磁盘上没有 |
| 防止 CLI agent 写 runtime | ❌ 纯文档 | 靠 agent 读 SKILL.md 自觉 |
| 文件系统只读 | ❌ 没有 | runtime worktree 是普通权限 |

### myteam 的改进

| clowder-ai | myteam | 改进点 |
|------------|--------|--------|
| pre-commit 默认关闭 | ✅ `postinstall` 自动安装 | 新 worktree 自动生效 |
| pre-push 不存在 | ✅ 有 pre-push hook | 拦截 protected 分支 push |
| runtime 分支提交无拦截 | ✅ pre-commit 拦截 `runtime/main-sync` | 机械阻止 |
| 无 PR 自动化 | ✅ `pnpm feature:pr` | 一键 push + create + merge + cleanup |
| 防止 CLI agent 写 runtime = 纯文档 | 同样靠文档（AGENTS.md） | 文件级拦截需 OS ACL，成本高 |

### 实测结果（2026-08-15）

通过 Runtime 发送"帮我添加功能：左边的会话可以删除"消息，engineering 团队（architect→implementer→reviewer）执行：

1. **Architect (opencode)**: 读 AGENTS.md → 写方案文档到 main repo → 没碰 runtime ✅
2. **Implementer (codex)**: 自己创建 `../myteam-delete-session` worktree (`feat/delete-session` 分支) → 在 feature worktree 里改了 4 个文件 +137 行 → 跑 tsc + SQLite 测试 → 没碰 runtime ✅
3. **Reviewer (codex)**: 在 feature worktree 里 review diff → 发现 P1 竞态 → 没碰 runtime ✅

**Runtime worktree 全程零修改。**

但约束是**文档级**的 — agent 遵守是因为读了 AGENTS.md，不是因为系统机械阻止了它。如果 agent 不读文档或选择无视，没有任何东西阻止它直接改 runtime 代码（和 clowder-ai 一样）。

## 11. 猫执行顺序与动态路由

### 固定还是动态？— 动态

clowder-ai **没有** `teams.yaml` 那样的固定 serial/parallel 结构。执行顺序是动态的。

| myteam | clowder-ai |
|--------|------------|
| `teams.yaml` 预定义角色 + 顺序 | 无 teams.yaml，角色运行时从 `cat-template.json` roster 动态选 |
| `strategy: serial/parallel` | 技能链（skill chain）定义候选下一步，猫自己选 |
| `decision: {action: "finish/handoff"}` JSON 输出 | 文本 `@handle` + MCP 工具调用（`targetCats`, `cross_post_message`） |
| transitions 固定条件 | 球权模型（@ = 传球，接/退/升） |

### 三层动态路由

**① 技能链 (manifest.yaml)**
每个技能有 `next: []` 候选列表（不是单一后继）：
```
feat-lifecycle → next: ["writing-plans"]
writing-plans → next: ["worktree"]
quality-gate → next: ["fresh-context-review", "request-review"]  ← 多选
```
猫根据 `triggers` 关键词匹配，自己决定走哪个技能。

**② 球权模型 (shared-rules.md §10)**
`@handle` = 传球。收到球后只能三选一：

| 选择 | 含义 |
|------|------|
| 接 (accept) | "我来做 X" — 拿球行动 |
| 退 (return) | "球不该在我这，退给 @xxx" — 退回发送方 |
| 升 (escalate) | `@operator` — 仅限 3 种硬条件：不可逆操作/愿景级决策/跨猫死锁 |

没有第四种选择。`@operator` 是硬条件出口，不是默认安全港。

两种路由方式：
- 文本行首 `@handle`（同线程文本路由）— 句中 @ 无系统效果
- MCP `targetCats`（跨线程结构化 A2A 路由）— 通过 `cross_post_message` 发送

**③ 角色词动态解析**
技能里写的是角色词（主执行猫/QA审查猫/守护猫），不是猫名。lint 规则 `no-hardcoded-cats` 禁止硬编码猫名。运行时从 `cat-config.json` roster 解析：
- 排除 `available: false` 的猫
- 排除 author 和 reviewer（守护猫选择时）
- 优先跨 family
- 优先 lead

### A2A 消息状态（只有 3 种）

| 状态 | 含义 |
|------|------|
| `BLOCKED` | 真卡住了，需要对方立刻决策 |
| `REVIEW READY` | 到了五件套/review 边界 |
| `DONE` / `HANDOFF` | 任务结束，交棒 |

收到球后静默执行直到下一个状态转换点。中间输出留在代码/文档里，不发送。"声明 = 执行" — 说"进入 merge gate"就是同一轮做。预发检查：不是 BLOCKED/REVIEW READY/DONE → 不发 → 继续做。

### 五件套交接格式

跨猫交接必须包含 5 件（`cross-cat-handoff` 技能 SCAN→MISSING→BLOCK→PASS 强制）：

| # | 项目 | 说明 |
|---|------|------|
| 1 | What | 具体改动或决策 |
| 2 | Why | 为什么这样做（约束、风险、目标） |
| 3 | Tradeoff | 放弃了什么备选方案 |
| 4 | Open Questions | 还不确定的点（分技术/价值两类） |
| 5 | Next Action | 希望接手方下一步做什么 |

4 种交接类型：Review 请求 / 工作交接（中途转交）/ 决策通知 / 开放讨论邀请。

## 12. 完成与结束机制

### Phase 级完成
`merge-gate` Step 7.5 → PR merge 后实时同步 Phase ✅ + AC 打勾 + Timeline。不延迟到 feature 完成。

### Feature 级完成（多层终局信号）

```
① AC 全打勾
② PR 合入 main
③ remote review 通过
④ 愿景守护 — 跨猫交叉验证
   守护猫 ≠ author ≠ reviewer，从 roster 动态选，优先跨 family
   守护猫 P1 = blocker，author 不能自己解决
   闭环只有 2 条路：(A) 真实现，或 (B) operator 联合签字降级
⑤ CloseGateReport — 结构化 AC 矩阵
   每个 AC: met / deleted / cvo_signed_off
   resolution.kind: immediate / delete / cvo_signoff（无第四种）
   禁止: follow-up / deferred / next phase / stub / TD / 后续 / 下次一定
⑥ 反思胶囊 — 写到 project-reflections/
⑦ pnpm check:features PASS — 机器验证
⑧ Status: done + 从 BACKLOG 移除
```

触发条件：AC 全打勾 + PR 合入 + remote review 通过。不触发于 phase-done 或 review-passed 单独。

### CloseGateReport 格式

```yaml
ac_matrix:
  - id: AC-1
    description: "..."
    status: met          # met / unmet / deleted / cvo_signed_off
    evidence: "截图/测试输出/代码路径"
    resolution:
      kind: immediate    # immediate / delete / cvo_signoff
      # 如果 cvo_signoff:
      proposal_message_id: "..."
      cvo_message_id: "..."
      cvo_quote: "operator 原话"
      accepted_scope: "..."
```

### 愿景守护三问（不可跳过）
1. operator 的核心问题是什么？
2. 交付的东西解决这个问题了吗？
3. operator 用的体验如何？

AC 全打勾 ≠ 完成（F041 教训：12 AC ✅ 但 UI 不可用）。

## 13. Takeover（接管）机制

### §18 TAKEOVER — reviewer 发起的 author 降级

触发条件（任一）：
1. 连续 3 轮无有效证据增量（新日志/新调用链/新文件+行号/新 Red→Green/scope 缩窄）
2. 连续 2 次 "修好了/没问题" 但重新验证失败（假绿）
3. Reviewer 被迫对同一症状/验收点重新验证 2 次
4. 连续 2 次 "下一步做 X，ok 吗？" 的前瞻性请求，无交付物
5. 收到球后连续 2 条非状态转换消息（中间进度报告），未进入 BLOCKED/REVIEW READY/DONE

接管流程：
1. Reviewer 显式宣布 TAKEOVER（不能默会）
2. 原 author 立即降级为"信息提供者"，停止试错
3. 原 author 交 4 部分手写：复现步骤/试过什么/失败原因/当前怀疑
4. 接管猫修复 → 另一只猫 review 接管猫的代码（不能自审）
5. 任务结束后 author 身份自动恢复（不永久）

### actionFamily=takeover — 接管另一只猫的 owner 角色

接管 worktree/feat owner/review 等高风险操作 → 触发 3 问验证：
1. **claim 是什么** — 列举所有可验证声明（owner/auth/object/wait/route/role/freshness）
2. **resolver** — 每个声明需独立验证者，标 `sourceTier`：
   - T0：landy messageId / git 签名 / GitHub API（最强）
   - T1：PR review/check 状态 / CI
   - T2：猫可写文档 / feat_index / 另一只猫的声明（最弱）
3. **verdict** — `verified` / `mismatch` / `insufficient`

高风险操作（merge/cvo_claim/takeover/irreversible/owner_reassignment）需 ≥1 T0/T1 证据。T2-only → `insufficient` → fail-closed。

## 14. 对比 myteam

| clowder-ai | myteam | 差距 |
|------------|--------|------|
| 动态选猫（roster + 角色词） | 固定 team（teams.yaml） | myteam 简单但不够灵活 |
| @ 球权传球（接/退/升） | `decision` JSON + transitions | myteam 有 handoff 条件但无球权模型 |
| 多层终局（AC+PR+review+守护+CloseGate） | `task_done` 事件 | myteam 单层，无愿景守护 |
| TAKEOVER 接管 | 无 | myteam 无卡住检测 |
| A2A 3 状态（BLOCKED/REVIEW READY/DONE） | 无 | myteam 无跨猫通信协议 |
| 五件套交接格式 | 无格式 | myteam 无交接格式约束 |
| cloud review (@codex review) | 无 | myteam 无云端 review |
| Red→Green TDD 修复 | 无 | myteam 无 TDD 流程 |
| Evidence Validation E1-E5 | 无 | myteam 无 merge 前证据验证 |
| 封板协议（5 轮上限） | 无 | myteam 无 review 循环控制 |
| Review Continuity Guard | 无 | myteam 无 stale review 检测 |

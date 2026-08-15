# 技术方案：删除左侧会话及其全部历史

> 状态：已设计，待 @implementer 实现（在 feature worktree `../myteam-delete-session` / `feat/delete-session` 分支）
> 关联需求：左侧"会话历史"侧边栏每条可删除；删除会话时，该会话下所有任务、事件、状态、CLI 会话映射一并清除。

---

## 1. 需求与边界

- **需求**：左侧侧边栏（`packages/web/src/App.tsx:231-272` 的"会话历史"列表）每一条会话可被删除；删除时把该会话相关的全部历史一并删除。
- **"历史"定义**（DB 行，硬删除）：
  - `tasks` 表中 `session_id` 属于该会话的所有任务行；
  - 这些任务在 `events` 表中的全部事件行；
  - 这些任务在 `task_states` 表中的状态行；
  - `sessions` 表中该 `session_id` 的 CLI 会话映射行。
- **不做**：不删磁盘 worktree（`tasks.worktree_path` 指向的目录由 feature worktree 体系独立管理，可能跨会话复用）；不做软删除/回收站。

## 2. 现状分析

### 2.1 数据模型（`packages/api/src/storage/Database.ts:17-58`）

| 表 | 主键 | 关键列 | 说明 |
|---|---|---|---|
| `tasks` | `id` | `session_id`, `message`, `team_id`, `created_at` | 一个 session 可含多个 task（`continueSession` 复用同一 session 产生新 task） |
| `task_states` | `task_id` | `status`, `finished_at` | 与 tasks 1:1 |
| `events` | `event_id` 自增 | `task_id`, `type`, `content`... | 索引 `idx_events_task(task_id, event_id)` |
| `sessions` | `(session_id, role_id)` | `cli_session_id` | CLI 会话续接映射 |

- 无显式外键约束（SQLite 默认关闭且未声明），删除需手动级联。
- `createTask`（`Database.ts:77-82`）总会写入 `session_id`（新任务用 `randomUUID()`，续接用传入值）。仅历史遗留留任务可能 `session_id IS NULL`。

### 2.2 侧边栏去重键（`App.tsx:34-50`、`64-81`）

侧边栏按 `t.sessionId || t.taskId` 去重，每条代表一个会话：

- 正常：`t.sessionId` 非空 → 键 = `sessionId`，一条 = 整个会话；
- 遗留：`t.sessionId` 为空 → 键 = `taskId`，一条 = 单个无会话任务。

故删除入口需区分两种键：有 `sessionId` 走会话级删除，无则走单任务删除。

### 2.3 运行中任务的删除竞态（`TaskRuntime.ts`）

`TaskRuntime`：
- `activeControllers: Map<taskId, AbortController>`（`TaskRuntime.ts:16`）记录在跑任务；
- `cancelTask(taskId)`（`:76-82`）abort 控制器并 `db.updateTaskStatus('cancelled')`；
- `executeTask`（`:50-74`）在 abort 后会 `emit('task_done', {status:'cancelled'})`（`:61-62`），`emit`（`:41-48`）会 `db.appendEvent` 落库并广播 SSE。

**竞态**：DELETE 接口先删行，被取消的任务随后仍可能 `emit` → 向已删任务重新插入 `events` 行（孤立行，UI 不可见但污染 DB）。必须在 `emit` 处加删除守卫，避免删后落库。

- `sseClients: Map<taskId, Set<SSEClient>>`（`:15`）持有 SSE 连接；删除运行中任务时需主动 `res.end()` 关闭，否则前端 `EventSource` 会自动重连。

## 3. 设计决策

### 3.1 后端

#### A. `Database.ts` 新增两个方法（事务、参数化、级联）

```ts
deleteSession(sessionId: string): number {
  const ids = this.db.prepare('SELECT id FROM tasks WHERE session_id = ?')
    .all(sessionId).map((r: any) => r.id as string);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  this.db.exec('BEGIN');
  try {
    this.db.prepare(`DELETE FROM events WHERE task_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM task_states WHERE task_id IN (${placeholders})`).run(...ids);
    this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    this.db.exec('COMMIT');
  } catch (e) {
    this.db.exec('ROLLBACK');
    throw e;
  }
  return ids.length;
}

deleteTask(taskId: string): void {  // 无 session_id 的遗留单任务
  this.db.exec('BEGIN');
  try {
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM task_states WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    this.db.exec('COMMIT');
  } catch (e) {
    this.db.exec('ROLLBACK');
    throw e;
  }
}
```

- `task_id`/`session_id` 均经 `?` 占位符绑定，**无 SQL 注入面**（@reviewer 重点确认）。
- `IN (...)` 的 `task_id` 来自 DB 自身查询结果（UUID），非用户原文。

#### B. `TaskRuntime.ts` 新增删除守卫 + SSE 关闭

```ts
private deletedTasks = new Set<string>();

markTaskDeleted(taskId: string) {
  if (this.activeControllers.has(taskId)) {   // 仅在跑任务才需守卫
    this.deletedTasks.add(taskId);
    this.cancelTask(taskId);                  // abort + 状态置 cancelled（随后被删，无害）
  }
  this.closeSSEClients(taskId);
}

private closeSSEClients(taskId: string) {
  const clients = this.sseClients.get(taskId);
  if (!clients) return;
  for (const c of clients) { try { c.res.end(); } catch {} }
  this.sseClients.delete(taskId);
}
```

并在 `emit`（`TaskRuntime.ts:41`）开头加守卫：

```ts
private emit(...): TaskEvent | null {
  if (this.deletedTasks.has(taskId)) return null;   // 删除后不再落库/广播
  ...
}
```

并在 `executeTask` finally（`TaskRuntime.ts:71-73`）追加清理，防止集合无限增长：

```ts
} finally {
  this.activeControllers.delete(taskId);
  this.deletedTasks.delete(taskId);
}
```

> `emit` 返回类型由 `TaskEvent` 改为 `TaskEvent | null`；现有调用处均未使用返回值，安全。

#### C. `index.ts` 新增两个 DELETE 路由

```ts
fastify.delete('/api/sessions/:sessionId', async (request, reply) => {
  const sessionId = (request.params as any).sessionId;
  const tasks = db.getTaskListBySession(sessionId);          // 取该会话全部 task_id
  for (const t of tasks) runtime.markTaskDeleted(t.taskId);  // 先停进程 + 守卫 + 关 SSE
  const n = db.deleteSession(sessionId);                     // 再原子删行
  reply.send({ ok: true, deletedTasks: n });
});

fastify.delete('/api/tasks/:taskId', async (request, reply) => {  // 遗留无 session 任务
  const taskId = (request.params as any).taskId;
  runtime.markTaskDeleted(taskId);
  db.deleteTask(taskId);
  reply.send({ ok: true });
});
```

顺序铁律：**先 `markTaskDeleted`（停 + 守卫），后删行**——避免删后 emit 重插。

### 3.2 前端

#### D. `App.tsx` 侧边栏每条加删除按钮

- 新增 `hoveredKey` 状态控制按钮显隐（沿用现有 inline-style + onMouseEnter/Leave 风格，不引入 CSS 文件）。
- 在每条侧边栏项右上角加 `×` 按钮，`opacity` 由 `hoveredKey === key` 决定（默认 0，悬停 1）。
- 按钮 `onClick` 调 `handleDelete(e, t)`，**必须 `e.stopPropagation()`** 防止触发选中。

```tsx
const [hoveredKey, setHoveredKey] = useState<string | null>(null);

const handleDelete = async (e: React.MouseEvent, t: any) => {
  e.stopPropagation();
  if (!window.confirm('确定删除此会话？所有相关历史将被永久删除。')) return;
  const endpoint = t.sessionId
    ? `/api/sessions/${encodeURIComponent(t.sessionId)}`
    : `/api/tasks/${encodeURIComponent(t.taskId)}`;
  const wasCurrent = t.sessionId
    ? sessionId === t.sessionId
    : (localStorage.getItem('currentTaskId') === t.taskId);
  try {
    await fetch(endpoint, { method: 'DELETE' });
    if (wasCurrent) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      localStorage.removeItem('currentTaskId');
      reset();            // dagStore 清空 nodes/edges/taskId
      setSessionId('');
      setSelectedTeam('');
    }
    const remaining = await loadTaskList();   // 见 3.2 E：loadTaskList 改为返回去重后数组
    if (wasCurrent && remaining.length > 0) restoreTask(remaining[0].taskId);
  } catch (err) {
    console.error('Failed to delete conversation:', err);
  }
};
```

按钮渲染（嵌于侧边栏项顶部行右侧）：

```tsx
<button
  onClick={(e) => handleDelete(e, t)}
  title="删除会话"
  style={{
    marginLeft: '8px', border: 'none', cursor: 'pointer',
    background: 'transparent', color: '#6c7086', fontSize: '14px', lineHeight: 1,
    opacity: hoveredKey === key ? 1 : 0, transition: 'opacity 0.15s',
  }}
  onMouseEnter={(e) => { e.stopPropagation(); e.currentTarget.style.color = '#ef4444'; }}
  onMouseLeave={(e) => { e.stopPropagation(); e.currentTarget.style.color = '#6c7086'; }}
>×</button>
```

并把外层 `<div>` 的 `onMouseEnter`/`onMouseLeave`（`App.tsx:254-255`）追加 `setHoveredKey(key)` / `setHoveredKey(null)`。

#### E. `loadTaskList` 改为返回去重后数组（小重构，便于 `handleDelete` 自动选中首条）

`App.tsx:61-83` 的 `loadTaskList` 末尾 `return deduped;`（仅增加返回值，不影响现有 `setTaskList(deduped)` 与依赖数组）。

## 4. 影响面与风险

| 项 | 评估 |
|---|---|
| SQL 注入 | 无：全部 `?` 占位符；`IN` 列表来自 DB 查询结果。@reviewer 复核 |
| 删除竞态 | 已用 `deletedTasks` 守卫 + `markTaskDeleted` 先停后删，杜绝删后 emit 重插 |
| 运行中任务 | `cancelTask` abort 子进程；SSE 主动 `res.end()`；前端关 `EventSource` |
| 事务原子性 | `BEGIN/COMMIT/ROLLBACK`，级联删除要么全成要么全回滚 |
| 向后兼容 | 仅新增方法/路由；`emit` 返回类型放宽为 `TaskEvent \| null`，调用处未用返回值 |
| worktree | 不动磁盘目录，仅清 DB 历史（边界明确） |
| 遗留无 session 任务 | `DELETE /api/tasks/:taskId` 兜底，覆盖 `session_id IS NULL` 旧数据 |
| 回归 | 删除非当前会话：仅刷侧边栏，不影响在跑任务的 SSE |

## 5. 验证

1. 类型检查：
   - `pnpm --filter @myteam/api exec tsc --noEmit`
   - `pnpm --filter @myteam/web exec tsc --noEmit`
2. 手工自测（feature worktree 启动 `pnpm dev`）：
   - 删一条已完成会话 → 侧边栏消失；`GET /api/tasks` 不再返回；刷新页面不复活。
   - 删一条**正在运行**的会话 → DAG 停止、SSE 关闭、侧边栏消失；DB `events` 表无该 task 的孤立新行。
   - 删当前正在查看的会话 → 视图重置，自动切到剩余首条。
   - 删遗留无 `session_id` 的单任务 → 仅该任务及事件被删。
   - 删除后 `continueSession` 续接不再命中已删会话（`POST /api/tasks` 传旧 sessionId 应按新会话处理或 404 行为一致）。

## 6. 待办清单

- [ ] **T1（后端-DB）** `packages/api/src/storage/Database.ts`：新增 `deleteSession(sessionId)` 与 `deleteTask(taskId)`，事务包裹、参数化、级联删 `events`/`task_states`/`tasks`/`sessions`。@implementer
- [ ] **T2（后端-Runtime）** `packages/api/src/executor/TaskRuntime.ts`：加 `deletedTasks: Set`、`markTaskDeleted(taskId)`、`closeSSEClients(taskId)`；`emit` 开头加删除守卫并返回类型改 `TaskEvent | null`；`executeTask` finally 追加 `this.deletedTasks.delete(taskId)`。@implementer
- [ ] **T3（后端-路由）** `packages/api/src/index.ts`：新增 `DELETE /api/sessions/:sessionId`（先 `markTaskDeleted` 各 task，后 `db.deleteSession`）与 `DELETE /api/tasks/:taskId`。@implementer
- [ ] **T4（前端-App）** `packages/web/src/App.tsx`：`loadTaskList` 改为返回去重数组；新增 `hoveredKey` 状态与 `handleDelete(e,t)`（`stopPropagation` + `confirm` + DELETE + 重置当前视图 + 自动选中首条）；侧边栏项加悬停显隐的 `×` 按钮并把 hover 同步到 `hoveredKey`。@implementer
- [ ] **T5（验证）** 运行两个 `tsc --noEmit`；按第 5 节手工自测全部场景。@implementer
- [ ] **T6（审查）** 复核：SQL 全参数化无注入；删除竞态守卫正确；事务回滚；运行中任务进程/SSE 已清理；`stopPropagation` 防误选；无越权/路径穿越面。@reviewer

## 7. 不做的事

- 不删磁盘 worktree 目录。
- 不做软删除/回收站/批量删除。
- 不改 `events` 表结构与事件模型。
- 不动 `RoleNode`/`StartNode` 组件。

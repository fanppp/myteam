# 修复方案：起始节点 + 会话状态刷新

> 状态：已设计，待 @implementer 实现
> 关联问题：
> 1. 输入文本点击执行后，输入框仍残留文本；且 DAG 中看不到原始请求。
> 2. 所有节点执行完成后，左侧历史会话仍显示 `running`。

---

## 1. 问题根因分析

### Bug A：输入框残留 + 请求不可见

- `packages/web/src/App.tsx:81-115`（`handleSubmit`）中 `message` 状态从未被重置，缺少 `setMessage('')`。
- DAG 当前只渲染角色节点（`RoleNode`），原始用户请求不会作为节点出现，用户无法在图上看到“这次问的是什么”。

### Bug B：侧边栏状态不更新

- 左侧历史列表（`App.tsx:152-185`）渲染的 `t.status` 来自 `taskList` 状态。
- `taskList` 仅在三种时机刷新：页面初始化（`App.tsx:30-32`）、`handleSubmit` 成功后（`App.tsx:108`）、以及 `loadTaskList()` 被显式调用时。
- SSE 收到 `task_done`（`App.tsx:126-128`）只调用了 `setTaskStatus`（更新底部状态栏）并关闭连接，**没有刷新 `taskList`**，因此侧边栏状态停留在 `running`，直到刷新页面或再次提交任务。

后端确认正常：`TaskRuntime.executeTask` 完成后会 `emit('task_done', ..., { status: 'done' })` 并 `db.updateTaskStatus(taskId, 'done')`（`packages/api/src/executor/TaskRuntime.ts:61-62`），`/api/tasks` 接口也读取了最新 status（`packages/api/src/index.ts:28-33`）。问题纯在前端未刷新列表。

---

## 2. 技术方案

### 2.1 起始节点（StartNode）—— 可输入、可显示 request

采用 **纯前端合成节点** 方案，不改动事件模型，零后端风险：

1. 新增 React Flow 节点类型 `startNode`，注册到 `nodeTypes`。
2. 新增组件 `packages/web/src/components/StartNode.tsx`：仅显示用户请求文本，右侧一个 `source` Handle，无状态徽标/脉冲动画，视觉上区别于 `RoleNode`（例如紫色边框 + “请求”标题 + 📥 图标）。
3. `dagStore.initTeam` 扩展签名，接收 `message` 参数，在角色节点之前插入合成起始节点：
   - 节点 id：`${taskId}-start`，type：`startNode`。
   - 内容：`message` 文本（多行展示，与 RoleNode content 样式一致）。
   - 位置：
     - serial：`{ x: -(NODE_WIDTH + H_GAP), y: 0 }`。
     - parallel：`{ x: -(NODE_WIDTH + H_GAP), y: ((roles.length - 1) * (NODE_HEIGHT + V_GAP)) / 2 }`（垂直居中，对齐 synthesizer 行）。
   - 连边：`start -> 第一个角色`（serial）；`start -> 每个 parallel 角色`（parallel，不连 synthesizer）。
4. `reset()` 已会清空 nodes/edges，合成节点随之清除，无需额外处理。
5. `syncNodeStatuses` 跳过 start 节点（其 data 无 status 字段或固定为 'done'，不会被命中），无需改动；但建议实现时显式 `if (n.type === 'startNode') return n;` 以防误改。

### 2.2 请求文本数据流

- **新建任务路径**：`handleSubmit` 已持有 `message`（`App.tsx:87`），直接传入 `initTeam(data.taskId, team.roles, team.strategy, message)`，随后 `setMessage('')` 清空输入框。
- **恢复任务路径**：`restoreTask` 调用 `/api/tasks/:id`，当前响应 `{ taskId, teamId, status, events }` **不含 message**。需在后端 `packages/api/src/index.ts:88-95` 的 `GET /api/tasks/:id` 中补充查询并返回 `message`（`tasks` 表已有 `message` 列，`Database.ts:60-65`），随后前端 `initTeam(tid, team.roles, team.strategy, data.message)`。
- 无 message 时（异常情况）跳过起始节点创建，保持向后兼容。

### 2.3 会话状态刷新

- 在 `App.tsx` 的 SSE `onmessage` 中，`task_done` 分支内追加一次 `loadTaskList()` 调用，使左侧列表 status 同步为 `done`/`error`。
- 因 `connectSSE` 当前用 `useCallback` 依赖 `[handleEvent, setTaskStatus]`，需把 `loadTaskList` 一并纳入依赖或改为不依赖其闭包（推荐把 `loadTaskList` 用 `useCallback` 稳定化后加入依赖数组）。

### 2.4 输入框清空

- `handleSubmit` 成功拿到 `data.taskId` 后调用 `setMessage('')`；失败/异常分支不清空，便于用户重试。

---

## 3. 影响面与风险

| 项 | 评估 |
|---|---|
| 后端改动 | 仅 `GET /api/tasks/:id` 增加一个字段，向后兼容，无破坏。 |
| 事件模型 | 不变，起始节点为前端合成，不落库。 |
| 恢复任务 | 历史任务恢复时也会正确出现起始节点。 |
| 回归风险 | 低。`initTeam` 签名扩展为可选参数，旧调用方传 `undefined` 时跳过起始节点。 |
| 并发布局 | 已考虑 parallel 下 synthesizer 不连起始节点的边，避免误导。 |

---

## 4. 待办清单（@implementer 执行）

- [ ] **T1（后端）** `packages/api/src/index.ts` `GET /api/tasks/:id`：在 `SELECT team_id FROM tasks` 改为 `SELECT team_id, message FROM tasks`，响应体新增 `message` 字段。
- [ ] **T2（前端-Store）** `packages/web/src/stores/dagStore.ts`：
  - `initTeam` 签名追加 `message?: string`。
  - 当 `message` 非空时，在 `nodes` 数组首位插入合成起始节点（id `${taskId}-start`，type `startNode`，data `{ content: message }`）。
  - serial：连边 `${taskId}-start -> ${taskId}-${roles[0].id}`。
  - parallel：对每个非 synthesizer 角色连边 `${taskId}-start -> ${taskId}-${role.id}`。
  - 角色节点 position 整体不变（起始节点放在负 x 侧）。
  - `syncNodeStatuses` 中 `n.type === 'startNode'` 直接 `return n`。
- [ ] **T3（前端-组件）** 新增 `packages/web/src/components/StartNode.tsx`：只读展示 `data.content`，右侧 `Handle type="source"`，无左侧 target handle（或保留但不强求）。视觉与 RoleNode 区分。
- [ ] **T4（前端-App）** `packages/web/src/App.tsx`：
  - `nodeTypes` 注册 `startNode: StartNode`。
  - `handleSubmit`：`initTeam(data.taskId, team.roles, team.strategy, message)` 后 `setMessage('')`。
  - `restoreTask`：`initTeam(tid, team.roles, team.strategy, data.message)`。
  - SSE `task_done` 分支追加 `loadTaskList()`；将 `loadTaskList` 用 `useCallback` 稳定化并加入 `connectSSE` 依赖。
- [ ] **T5（验证）** 启动 `pnpm dev`，新建任务确认：输入框清空、起始节点出现并显示请求、执行完成后侧边栏状态变为 done；刷新页面恢复历史任务，起始节点仍在；并行团队（brainstorm）布局正确。

## 5. 不做的事

- 不引入新的后端事件类型（如 `request_start`）。
- 不把起始节点写库，避免与 `events` 表语义混淆。
- 不改动 `RoleNode` 组件本身。

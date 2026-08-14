# clowder-ai CLI 工具处理方案统一记录

> 来源：`D:\000agent\opensource\clowder-ai` 项目完整分析

## 架构总览

CLI 处理分三层：

| 层 | 职责 | 关键文件 |
|---|---|---|
| **核心 spawn** | 通用子进程启动、路径解析、超时、存活探测 | `packages/api/src/utils/cli-spawn.ts`, `cli-spawn-win.ts`, `cli-resolve.ts`, `cli-supervisor.ts`, `cli-types.ts`, `ndjson-parser.ts`, `cli-timeout.ts`, `ProcessLivenessProbe.ts` |
| **Provider 服务** | 每个 CLI 的参数构建、环境变量、事件映射、prompt 构建 | `packages/api/src/domains/cats/services/agents/providers/*AgentService.ts` |
| **事件转换器** | 原始 NDJSON → 内部 AgentMessage | `providers/*-event-transform.ts`, `providers/*-ndjson-parser.ts` |

---

## 1. 子进程启动 (spawn)

### `spawnCli()` — 核心 generator

**文件**: `packages/api/src/utils/cli-spawn.ts:208`

```typescript
export async function* spawnCli(
  options: CliSpawnOptions,
  deps?: CliSpawnerDeps,
): AsyncGenerator<unknown, void, undefined> {
  const child = doSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: buildChildEnv(options.env),
    stdio: [options.stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
```

- 使用 `node:child_process` 的 `spawn`
- stdin 是 pipe **仅当提供了 `stdinInput`**（prompt-via-stdin 模式）
- spawn 错误 (ENOENT): 抛异常并使缓存路径失效 → 下次重新解析
- 非零退出: yield 一个 `__cliError` 哨兵对象
- 超时: yield 一个 `__cliTimeout` 哨兵对象

### 默认 spawn 函数

**文件**: `cli-spawn.ts:916-980`

- **Windows**: 委托给 `resolveWindowsSpawnPlan()`（见下文）
- **macOS/Linux**: 包装在 supervisor 进程中，确保 API 父进程被强杀时孤儿 CLI 进程也被清理

### CLI Supervisor 包装器

**文件**: `packages/api/src/utils/cli-supervisor.ts:47-139`

独立 Node 脚本：
- 解析 `--` 分隔符找到真实命令 + 参数
- 读取 `CAT_CAFE_SUPERVISOR_PARENT_PID` 环境变量
- `detached: !IS_WINDOWS` 启动真实子进程
- **转发 stdin** 到子进程 (`process.stdin.pipe(child.stdin)`) — P1 修复
- 每 1s 轮询：父进程消失 → SIGTERM → 宽限期后 SIGKILL

### 其他启动路径

- **tmux-agent-spawner.ts**: 在 tmux pane 中运行 CLI，通过 FIFO 读取 NDJSON
- **ClaudeBgCarrierService.ts:364**: 用原始 `spawn` 运行 `claude --bg` 守护模式
- **ClaudeInteractivePtyCarrierService.ts**: 用 PTY 驱动交互式模式

---

## 2. 路径解析 (Windows .cmd/.exe, PATH)

### `resolveCliCommand()` — 主解析器

**文件**: `packages/api/src/utils/cli-resolve.ts:103-179`

策略（带缓存，`existsSync` 再验证）：
1. **PATH 探测**: Windows 用 `where`，Unix 用 `which`
2. **Windows**: `selectWindowsPathEntry()` 在**第一个目录桶**内优先 `.cmd` 而非 `.exe`
3. **常见安装目录回退**:
   - Unix: `~/.local/bin`, `~/.claude/bin`, `~/.fnm/aliases/default/bin`, `~/.volta/bin`, `~/.nvm/versions/node/v*/bin` 等
   - Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `%LOCALAPPDATA%\agy\bin`

### Windows spawn plan — 四种模式

**文件**: `packages/api/src/utils/cli-spawn-win.ts:294-328`

```typescript
export type WindowsSpawnMode = 'shim' | 'native-exe' | 'git-bash' | 'cmd';
```

1. **`shim` 模式**: 解析 `.cmd` shim 文件找到底层 `.js` 入口脚本，用**系统 Node.js** 运行（非 Electron）
   - 已知 shim 脚本映射：
     ```typescript
     const KNOWN_SHIM_SCRIPTS = {
       claude: ['@anthropic-ai/claude-code/cli.js'],
       codex: ['@openai/codex/bin/codex.js'],
       gemini: ['@google/gemini-cli/bin/gemini.js'],
       opencode: ['opencode-ai/bin/opencode'],
     };
     ```
   - 第三遍查找原生 `.exe`（Claude Code 2.1+ 自带 `claude.exe`）

2. **`native-exe` 模式**: 直接 spawn `.exe`（避免 Git Bash 引号问题）
3. **`git-bash` 模式**: 用 Git Bash + 单引号转义
4. **`cmd` 模式**: 回退到 `cmd.exe` + MSVC CRT 转义

### `findSystemNode()` — 跨平台系统 Node 查找

**文件**: `cli-spawn-win.ts:40-82`

尝试 `where node.exe` / `which node` / 探测 `C:\Program Files\nodejs\node.exe`。关键：Electron 的 `process.execPath` 无法解析全局 npm 包。

---

## 3. 各 CLI 参数构建

### OpenCode

**文件**: `OpenCodeAgentService.ts:433-480`

```
opencode run [--session <id>] -m <model> --format json [<autoApproveFlag>] [...userArgs] <prompt>
```

- `--format json` 输出 NDJSON
- `--session <id>` 恢复会话
- `-m <model>` 原样传递
- prompt 是**位置参数**（非 stdin）

### Codex

**文件**: `CodexAgentService.ts:886-923`

**新会话**:
```
codex exec --json --config model_reasoning_effort="..." --sandbox danger-full-access 
  --add-dir .git --config approval_policy="on-request" 
  --config developer_instructions="..." [...userArgs] --skip-git-repo-check -- -
```
**恢复**:
```
codex exec resume <sessionId> --json [...same configs, 无 --sandbox/--add-dir] -- -
```

- `--json` 输出 NDJSON
- `--config key="value"` TOML 风格配置
- `--sandbox danger-full-access --add-dir .git` 仅新会话
- `-- -` 结束选项解析，`-` 让 codex 从 **stdin** 读 prompt
- `--skip-git-repo-check` 当工作目录非 git 仓库时

### Claude

**文件**: `ClaudeAgentService.ts:369-532`

```
claude -p --output-format stream-json --include-partial-messages --verbose 
  --model <m> --effort <e> --permission-mode bypassPermissions 
  --setting-sources project,local --chrome 
  [--resume <sessionId>] [--add-dir <dir>] 
  --system-prompt-file <l0Path> [--append-system-prompt-file <path>] 
  --mcp-config <json|file> --strict-mcp-config [...userArgs]
```

- `-p` print 模式
- `--output-format stream-json` NDJSON
- `--include-partial-messages` 流式文本增量
- `--verbose` 必需（否则 stream-json 报错）
- `--permission-mode bypassPermissions` 自动批准
- `--system-prompt-file` 用临时文件传 L0 身份（避免 Windows 32K argv 上限）
- `--mcp-config` Unix 内联 JSON，Windows 写临时文件
- `--strict-mcp-config` 阻止 cwd `.mcp.json` 自动发现
- prompt 通过 **stdin**

### Gemini (两种适配器)

**文件**: `GeminiAgentService.ts`

- **gemini-cli**: `gemini [--resume <id>] [--model <m>] -p <prompt> -o stream-json -y`
- **antigravity (agy)**: `agy --add-dir <cwd> --dangerously-skip-permissions --print <prompt>` — 纯文本输出

### Kimi

**文件**: `KimiAgentService.ts:104-106`

- 旧: `kimi-cli --print --output-format stream-json [--session <id>] --work-dir <dir>`
- 新: `kimi --output-format stream-json`

---

## 4. Prompt 传递方式 (stdin vs arg)

### 安全事件 2026-05-29: 跨线程上下文污染

prompt 正文经 stdin 传入子进程，而非 argv 位置参数。防止 `ps -o command=` / `/proc/<pid>/cmdline` 跨进程泄露完整对话历史。

### stdin 模式（Codex, Claude）— 推荐

```typescript
// cli-types.ts:53-58
stdinInput?: string;  // prompt 经 stdin 传入，防止 argv 泄露
```

```typescript
// cli-spawn.ts:245-257
if (options.stdinInput != null) {
  childStdin.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') log.warn(...);
  });
  childStdin.write(options.stdinInput);
  childStdin.end();
}
```

- **Codex**: `stdinInput: effectivePrompt`，`-- -` 终止选项
- **Claude**: `stdinInput: effectivePrompt`，避免 Windows `CreateProcess` 32,767 字符 `ENAMETOOLONG`
- supervisor 转发: `process.stdin.pipe(child.stdin)`

### argv 模式（OpenCode, Gemini, Kimi）— prompt 是位置参数

- **OpenCode**: prompt 作为最后一个位置参数
- **Gemini**: `-p <effectivePrompt>`
- **Kimi**: 通过 `buildKimiPrompt()` 构建后传入参数

---

## 5. 输出解析

### `parseNDJSON()` — 核心行解析器

**文件**: `packages/api/src/utils/ndjson-parser.ts:23-43`

```typescript
export async function* parseNDJSON(stream: Readable): AsyncGenerator<unknown> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { yield JSON.parse(trimmed) as unknown; }
    catch { yield { __parseError: true, line: trimmed }; }
  }
}
```

### 各 CLI 输出格式

| CLI | 标志 | 格式 | 解析器 |
|---|---|---|---|
| Codex | `--json` | NDJSON | `parseNDJSON` → `transformCodexEvent` |
| Claude | `--output-format stream-json` | NDJSON | `parseNDJSON` → `transformClaudeEvent` |
| OpenCode | `--format json` | NDJSON | `parseNDJSON` → `transformOpenCodeEvent` |
| Gemini-cli | `-o stream-json` | NDJSON | `parseNDJSON` → `transformGeminiEvent` |
| Antigravity | `--print` | plainText | `classifyAntigravityCliPlainText` |
| Kimi | `--output-format stream-json` | NDJSON | 内联解析 |

### `outputMode` 选择

- **`'ndjson'`（默认）**: 逐行解析 stdout NDJSON，每个事件与存活探测竞争
- **`'plainText'`**: 缓冲原始 stdout，结束时 yield 单个 `__cliPlainText`

### 流错误收集

**文件**: `cli-spawn.ts:49-117` (`maybeCollectStreamError`)

收集 `{type:'error'}` NDJSON 事件 **和** Claude 的 `{type:'result', is_error:true}` 事件。上限 50 条 / 16KB。

---

## 6. 事件映射

### Codex (`codex-event-transform.ts:27-269`)

| 原始事件 | 内部类型 |
|---|---|
| `thread.started` | `session_init` (sessionId = `thread_id`) |
| `item.started` (command_execution) | `tool_use` |
| `item.started` (mcp_tool_call) | `tool_use` (`mcp:server/tool`) |
| `item.completed` (agent_message) | `text` |
| `item.completed` (command_execution) | `tool_result` |
| `item.completed` (file_change) | `tool_use` |
| `item.completed` (mcp_tool_call) | `tool_result` + 可选 `rich_block` |
| `item.completed` (web_search) | `system_info` (仅计数) |
| `item.completed` (reasoning) | `system_info(thinking)` |
| `item.completed` (todo_list) | `system_info(task_progress)` |
| `error` | `system_info` (Reconnecting) 或 null |

### Claude (`claude-ndjson-parser.ts:15-290`)

| 原始事件 | 内部类型 |
|---|---|
| `system/init` | `session_init` (sessionId = `session_id`) |
| `stream_event/message_start` | null (记录 messageId + usage) |
| `stream_event/content_block_delta` (text_delta) | `text` |
| `stream_event/content_block_delta` (thinking_delta) | 缓冲 |
| `stream_event/content_block_stop` | `system_info(thinking)` (刷缓冲) |
| `stream_event/message_stop` | `agent_loop` (遥测标记) |
| `assistant` | 数组: `text` / `tool_use` |
| `result` (is_error:true) | `error` |
| `rate_limit_event` | `system_info(rate_limit)` |
| `system/compact_boundary` | `system_info` |

### OpenCode (`opencode-event-transform.ts:80-245`)

| 原始事件 | 内部类型 |
|---|---|
| `step_start` | `session_init` (sessionId = `sessionID`) |
| `text` (part.type=text) | `text` |
| `text` (part.type=reasoning) | `system_info(thinking)` |
| `reasoning` | `system_info(thinking)` |
| `tool_use` | `tool_use` (toolName = `part.tool`) |
| `error` | `error` |
| `step_finish` | `agent_loop` + `metadata.usage` |

### Gemini (`gemini-event-parser.ts:16-80`)

`init`→`session_init`, `message/assistant`→`text`, `tool_use`→`tool_use`, `result/non-success`→`error`

---

## 7. 超时与终止信号

### 超时配置

**文件**: `packages/api/src/utils/cli-timeout.ts`

```typescript
export const DEFAULT_CLI_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟
```

- `CLI_TIMEOUT_MS` 环境变量覆盖，`0` 禁用

### 超时机制

**文件**: `cli-spawn.ts:357-378`

- **仅在有效 NDJSON 事件时重置** — 无效噪音不延长超时
- **不在 stderr 时重置** — stderr 是传输噪音
- **busy-silent 进程**（CPU 增长）可延长，除非硬上限超出

### Kill 升级

```typescript
function killChild(): void {
  child.kill('SIGTERM');
  escalationTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS); // 3000ms
}
```

### AbortSignal

```typescript
options.signal.addEventListener('abort', abortHandler, { once: true });
```

### 存活探测（停滞检测）

**文件**: `packages/api/src/utils/ProcessLivenessProbe.ts`

状态: `active` / `busy-silent` / `idle-silent` / `dead`。CPU 采样仅 Unix。

- 软警告 120s，停滞警告 300s
- #774 延迟停滞杀: 仅当探测计时器获胜竞争时执行（无 NDJSON 到达）
- `stallAutoKill`: `idle-silent` + `suspected_stall` 时自动杀

### 语义完成信号

```typescript
semanticCompletionSignal?: AbortSignal;
```

当 provider 信号语义完成（如 Codex `turn.completed`），`spawnCli` 跳过 `await closePromise`，给 5s 宽限期后强杀。

---

## 8. Session ID 提取

| CLI | 原始事件 | 字段 | 恢复参数 |
|---|---|---|---|
| Codex | `thread.started` | `thread_id` | `exec resume <id>` |
| Claude | `system/init` | `session_id` | `--resume <id>` |
| OpenCode | `step_start` | `sessionID` | `--session <id>` |
| Gemini | `init` | `session_id` | `--resume <id>` |
| Kimi | message | `session_id` | `--session <id>` |
| ClaudeBg | stdout | `backgrounded · <8hex>` | `--resume <UUID>` (仅 UUID 匹配) |

---

## 9. "Done" 检测

### 标准载体 (Codex, Claude, OpenCode)

Done 在事件循环耗尽后**无条件** yield。错误保证 try/catch 后 yield done。

### Codex 语义完成

```typescript
if (raw.type === 'turn.completed') {
  semanticCompletionController.abort(); // 信号 spawnCli 停止等待退出
}
```

### Codex exit-code-1 抑制

```typescript
if (event.exitCode === 1 && event.signal === null && sawSubstantiveOutput) {
  log.warn('Codex CLI exited with code 1 after substantive output (suppressing as quirk)');
  continue;
}
```

`thread.started` **不算**实质性输出 — 只有 `item.completed` 算。

### ClaudeBg 载体

Done 通过守护 `state.state` 轮询检测: `done` / `error` / `failed` / `blocked` / `stopped`。

### 静默完成诊断

当 `eventCount > 0 && textEventCount === 0 && !errorAlreadyYielded`，产出 `silent_completion` 诊断。

### Claude 畸形工具调用检测

检测"仅思考"输出（assistant 事件无 `tool_use` 也无 `text`）→ 产出 `malformed_toolcall_detected` + 错误触发恢复。

---

## 10. CLI 特殊怪癖

### Codex `--skip-git-repo-check`

从工作目录向上查找 `.git`，非 git 仓库时添加。

### Claude `--verbose`

总是传递。`stream-json` 输出必需。

### Claude Windows MCP config 文件

Windows 上内联 JSON 被当作文件路径 — 必须写临时文件。

### Codex MCP env 包装器

Codex CLI 的 `--config mcp_servers.X.env.K=V` 无法注入复杂 env。写临时 `.mjs` 包装脚本 `spawn` 真实 MCP server。

### Codex auth 模式 HOME 隔离

- OAuth 模式: 需要真实 `HOME`（`~/.codex/auth.json` token 刷新）
- API Key 模式: 临时 `HOME` 防止 stale OAuth 干扰。Windows 同时设 `USERPROFILE`

### Codex 废弃 `OPENAI_BASE_URL`

自定义 base URL 通过 `--config model_providers.custom.base_url=...` + `wire_api="responses"` + `env_key="OPENAI_API_KEY"`。

### Claude `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` 剥离

防止 CLI 自设 `entrypoint=sdk-cli`（影响订阅配额路由）。

### Claude `--setting-sources` auth 模式依赖

- api_key 模式: `project,local`（跳过用户级设置防污染）
- 订阅模式: `project,local,user`（从用户级读 auth）

### Codex `--add-dir .git` 仅新会话

Resume 不带 `--add-dir`。

### Windows libuv 崩溃抑制

退出码 `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) 在 MCP 子进程关闭时抑制（如已收到语义完成）。

### Claude thinking signature 救援

检测 "Invalid signature in thinking block" → 格式化救援命令。

### Claude `ANTHROPIC_BASE_URL` `/v1` 剥离

Claude CLI 内部追加 `/v1`；用户配置带 `/v1` 则剥离防止 `/v1/v1`。

### OpenCode builtin name 重映射

OpenCode 把 `'openai'` 视为 builtin（强制 Responses API）。重映射为 `openai-compat` 使用配置的 npm adapter。

---

## 11. 环境变量处理

### `buildChildEnv()` — 共享 env 构建

```typescript
// cli-spawn.ts:185-201
// 克隆 process.env，剥离 LS_COLORS/LSCOLORS（防 E2BIG/ARG_MAX）
// null 值 = 删除继承的变量
```

### Codex env

- OAuth 模式: 删除 `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_ORG_ID`, `OPENAI_ORGANIZATION`
- API Key 模式: 临时 HOME 隔离（Windows 同时设 `USERPROFILE`）
- Account env 最后应用（用户覆盖），但跳过已通过 `--config` 消费的 `OPENAI_BASE_URL`/`OPENAI_API_BASE`

### Claude env

- 剥离 `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`
- Windows: 设 `CLAUDE_CODE_GIT_BASH_PATH`
- api_key 模式: 注入 `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`（剥离 `/v1`）, `ANTHROPIC_MODEL`
- 订阅模式: 否认 `SUBSCRIPTION_MODE_DENY_KEYS`（所有 `ANTHROPIC_*` 置 null 防泄露）

### OpenCode env

- `OPENCODE_CONFIG` 设置 → 清除 `ANTHROPIC_*`/`OPENCODE_*`（凭证通过 config 替换）
- 订阅模式: 清除所有凭证 env
- API key: `CAT_CAFE_ANTHROPIC_API_KEY` > `OPENCODE_API_KEY` > 构造函数
- 清除 `ALLOWED_WORKSPACE_DIRS`（权威在 OPENCODE_CONFIG）

### Per-provider env 映射

**文件**: `env-map.ts:37-64` (`BUILTIN_ENV_MAPS`)

模板 `${api_key}`/`${base_url}` 替换。映射: `anthropic`, `openai`, `google`, `opencode`, `openrouter`, `kimi`。

---

## 12. 自动批准标志

### OpenCode — 探测式自动批准

**文件**: `opencode-auto-approval.ts`

候选标志: `--auto`, `--dangerously-skip-permissions`, `--yolo`

探测流程:
1. 运行 `opencode run --help`（10s 超时），检查标志是否出现在帮助文本
2. 回退: `opencode run <flag> --help`
3. 结果进程级缓存

用户覆盖: 如果用户 `cliConfigArgs` 含任何标志/`--no-*` 变体，系统注入跳过。`buildArgs` 中去重。

### Codex — `--config approval_policy`

**文件**: `codex-cli.ts`

```typescript
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'];
export const DEFAULT_CODEX_APPROVAL_POLICY = 'on-request';
```

通过 `--config approval_policy="on-request"` 配置。Sandbox 默认 `danger-full-access`。非标志，是 TOML 配置键。

### Claude — `--permission-mode bypassPermissions`

**文件**: `ClaudeAgentService.ts:51, 378-379`

```typescript
const PERMISSION_MODE = 'bypassPermissions';
'--permission-mode', PERMISSION_MODE,
```

所有 Claude 载体均传递。PTY 载体处理 bypassPermissions 确认菜单（Claude TUI 2.1.170+ 显示）。

### Gemini/Antigravity — `--dangerously-skip-permissions`

Profile 控制。用户 `cliConfigArgs` 不能覆盖（`ANTIGRAVITY_USER_BLOCKED_FLAGS` 阻止）。

### Gemini-cli — `-y`

自动接受。

---

## 关键文件索引

| 用途 | 文件 |
|---|---|
| 核心 spawner | `packages/api/src/utils/cli-spawn.ts` (980 行) |
| Windows spawn plan | `packages/api/src/utils/cli-spawn-win.ts` (425 行) |
| 路径解析器 | `packages/api/src/utils/cli-resolve.ts` (207 行) |
| Supervisor 包装器 | `packages/api/src/utils/cli-supervisor.ts` (143 行) |
| Spawn 类型 | `packages/api/src/utils/cli-types.ts` (114 行) |
| NDJSON 解析器 | `packages/api/src/utils/ndjson-parser.ts` (55 行) |
| 超时配置 | `packages/api/src/utils/cli-timeout.ts` (19 行) |
| 存活探测 | `packages/api/src/utils/ProcessLivenessProbe.ts` (235 行) |
| CLI 诊断 | `packages/api/src/utils/cli-diagnostics.ts` (566 行) |
| Codex provider | `.../providers/CodexAgentService.ts` (1340 行) |
| Claude provider | `.../providers/ClaudeAgentService.ts` (957 行) |
| OpenCode provider | `.../providers/OpenCodeAgentService.ts` (579 行) |
| Codex 配置 | `packages/api/src/config/codex-cli.ts` (28 行) |
| OpenCode 自动批准 | `.../providers/opencode-auto-approval.ts` (139 行) |
| OpenCode 配置模板 | `.../providers/opencode-config-template.ts` (319 行) |
| Codex 事件转换 | `.../providers/codex-event-transform.ts` (270 行) |
| Claude NDJSON 解析 | `.../providers/claude-ndjson-parser.ts` (336 行) |
| OpenCode 事件转换 | `.../providers/opencode-event-transform.ts` (246 行) |
| Gemini 事件解析 | `.../providers/gemini-event-parser.ts` (112 行) |
| Antigravity CLI 解析 | `.../providers/antigravity-cli-event-parser.ts` (159 行) |
| Claude Bg 载体 | `.../providers/ClaudeBgCarrierService.ts` (709 行) |
| Claude PTY 载体 | `.../providers/ClaudeInteractivePtyCarrierService.ts` (450 行) |
| Env 映射 | `.../providers/env-map.ts` (167 行) |
| Tmux agent spawner | `packages/api/src/domains/terminal/tmux-agent-spawner.ts` |

所有文件路径相对于 `D:\000agent\opensource\clowder-ai`。

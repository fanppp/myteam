# 权限与沙箱问题记录

## 问题

myteam 项目中，opencode 和 claude 的文件写入操作被权限系统拦截：

- **opencode**: `edit: * → deny` 规则拦截所有 Edit/Write 操作，只允许 `.opencode/plans/*.md`
- **claude**: `Claude requested permissions to write ... but you haven't granted it yet`
- **Bash heredoc**: 含模板字符串时触发 `expansion obfuscation` 防护

## clowder-ai 的多层权限模型

clowder-ai 使用 4 层防线，而非单一沙箱：

### 1. Prompt 层 — Iron Laws

`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` 中定义不可违反的安全规则：

- 数据存储保护区：不删除 Redis、SQLite 等持久化存储
- 进程自保：不杀父进程、不改启动配置
- 配置不可变：运行时不修改配置文件
- 网络边界：不访问非本服务的 localhost 端口

### 2. Per-cat 层 — 角色限制

`cat-template.json` 中每个角色有 `restrictions` 字段：

```json
{
  "caution": "禁止写代码！幻觉多，不遵守 SOP",
  "restrictions": ["禁止写代码"]
}
```

### 3. 代码层 — 路径沙箱 + 白名单

**DENYLIST** (`workspace-security.ts`):

```typescript
const DENYLIST_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/, /^id_rsa/];
const DENYLIST_DIRS = new Set(['.git', 'secrets']);
```

**编辑扩展名白名单** (`workspace-edit.ts`):

```typescript
const EDITABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html',
  '.yaml', '.yml', '.toml', '.sh', '.py', '.txt',
]);
```

所有写操作需签名 edit_session_token（30 分钟 TTL）+ sha256 冲突检测。

### 4. MCP 层 — 工具可见性 + 目录限制

**`ALLOWED_WORKSPACE_DIRS`** (`path-validator.ts`):

```typescript
const allowedWorkspaceDirs = process.env['ALLOWED_WORKSPACE_DIRS'];
const additionalDirs = allowedWorkspaceDirs ? allowedWorkspaceDirs.split(/[:,]/) : [];
const allowedDirs = [catCafeDir, ...additionalDirs];
```

**`CAT_CAFE_READONLY`** (`server-toolsets.ts`):

- 只读模式：跳过 post_message 等写操作工具注册
- 强制注入：`CAT_CAFE_READONLY: 'true'` 无法被 descriptor 或 config 覆盖
- Agent Key：回调认证后解锁部分写工具，但文件/shell 修改器始终阻止

### 5. 动态生成 opencode.json — 关键设计

clowder-ai **不使用静态 opencode.json**，而是每次调用动态生成：

```typescript
// opencode-config-template.ts
export function buildExternalDirectoryPermissions(externalDirectories?) {
  const rules: Record<string, OpenCodePermissionAction> = {};
  for (const directory of externalDirectories ?? []) {
    const normalized = directory.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized) rules[`${normalized}/**`] = 'allow';
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

// 注入到 opencode.json
config.permission = { external_directory: externalDirectoryPermissions };
```

生成路径: `.cat-cafe/oc-config-<catId>-<invocationId>/opencode.json`

## Claude Code 的沙箱

Claude Code 也有自己的权限系统：

| 层 | 机制 | 配置 |
|---|---|---|
| Prompt 层 | `CLAUDE.md` 规则 | `CLAUDE.md` |
| 配置层 | `permissions.allow/deny` | `.claude/settings.json` |
| 交互层 | 运行时弹窗确认 | 无 |

## myteam 的解决方案

### 方案 A: 静态 opencode.json（推荐）

在 `D:\000agent\opensource\myteam\opencode.json` 中配置：

```json
{
  "permission": {
    "edit": "allow",
    "external_directory": {
      "D:\\000agent\\opensource\\myteam\\**": "allow"
    }
  }
}
```

### 方案 B: 交互式添加

在 opencode 中运行 `/permissions` 命令，添加 allow 规则。

### 方案 C: Claude 配置

在 `D:\000agent\opensource\myteam\.claude\settings.json` 中：

```json
{
  "permissions": {
    "allow": ["Edit(**)", "Write(**)"]
  }
}
```

### 方案 D: 动态生成（未来）

参考 clowder-ai，在 API 层动态生成 opencode.json，按团队/角色注入不同的 `external_directory` 权限。

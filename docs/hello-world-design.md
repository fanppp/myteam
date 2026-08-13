# 技术方案：hello world function

## 1. 需求
实现一个 "hello world" 函数：调用后返回 `Hello, World!` 字符串。

## 2. 现状分析
- 仓库为 pnpm monorepo，TypeScript + ESM（`"type": "module"`）。
- `packages/shared/src/hello.ts:1` 已存在：
  ```ts
  export function hello(name: string = 'World'): string {
    return `Hello, ${name}!`;
  }
  ```
- `packages/shared/src/index.ts:4` 已通过 `export * from './hello.js'` 对外导出。
- tsconfig：`target: ES2022`，`moduleResolution: bundler`，`strict: true`；re-export 使用 `.js` 扩展名约定。
- 代码风格：具名导出、无注释、小函数。

## 3. 设计决策
- **新增** 专用零参函数 `helloWorld()`，而非复用带默认参的 `hello()`，原因：
  - 语义明确、可读性高，调用处意图一目了然。
  - 与 `sort.ts` 中"小而专一"的函数风格一致。
- **DRY**：`helloWorld()` 内部委托 `hello()`（默认参即输出 `Hello, World!`），避免重复字符串拼接逻辑。
- **位置**：放入 `packages/shared/src/hello.ts`，与同类函数就近聚合。
- **导出**：由现有 `index.ts` 的 `export * from './hello.js'` 自动覆盖，无需改动 index。
- **类型**：`(): string`，与 `hello` 保持一致；纯函数、无副作用，符合 shared 包定位。

## 4. 变更清单
| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/shared/src/hello.ts` | 新增函数 | 追加 `helloWorld()` 包装 `hello()` |
| `packages/shared/src/index.ts` | 无需改动 | 已 `export * from './hello.js'` |

## 5. 验证
- 类型检查：`pnpm --filter @myteam/shared exec tsc --noEmit`（或根目录 `tsc -p packages/shared`）。
- 运行时自测：`tsx -e "import {helloWorld} from './packages/shared/src/index.js'; console.log(helloWorld())"` 应输出 `Hello, World!`。
- @reviewer 关注点：无安全风险（纯字符串返回，无 IO/eval/注入面）；确认未引入新依赖。

## 6. 目标函数签名
```ts
export function helloWorld(): string {
  return hello();
}
```

## 7. 待办清单
- [ ] @implementer: 在 `packages/shared/src/hello.ts` 追加 `helloWorld()` 函数（委托 `hello()`，返回 `string`），不新增 import、不加注释。
- [ ] @implementer: 运行 shared 包类型检查确认无报错。
- [ ] @implementer: 运行时自测确认输出 `Hello, World!`。
- [ ] @reviewer: 审查实现是否复用 `hello()`、是否符合现有导出约定、无安全问题。

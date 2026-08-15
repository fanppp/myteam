# 技术方案：async/await 用法演示

## 1. 需求
在 shared 包补充 async/await 的标准用法演示：`async` 函数定义、`await` Promise、`Promise.all` 并行、以及基于 `Promise` 的延时工具，并复用现有 `hello()` 保持 DRY。

## 2. 现状分析
- 仓库为 pnpm monorepo，TypeScript + ESM（`"type": "module"`）。
- `packages/shared/src/hello.ts:1` 已存在：
  ```ts
  export function hello(name: string = 'World'): string {
    return `Hello, ${name}!`;
  }
  ```
- `packages/shared/src/index.ts` 通过 `export * from './hello.js'` 等对外导出。
- tsconfig：`target: ES2022`，`moduleResolution: bundler`，`strict: true`；re-export 使用 `.js` 扩展名约定。
- 代码风格：具名导出、无注释、小而专一的纯函数。

## 3. 设计决策
- **新增** 独立文件 `packages/shared/src/async.ts`，聚合 async/await 相关演示，与 `sort.ts`、`hello.ts` 的"就近聚合、单一主题"风格一致。
- **`delay(ms)`**：返回 `Promise<void>`，用 `setTimeout` + `Promise` 构造器封装延时，作为 await 的演示基础。
- **`asyncGreet(name='World', ms=0)`**：`async` 函数，先 `await delay(ms)` 再委托 `hello(name)`；默认参与 `hello` 语义对齐（无参即 `Hello, World!`）。
- **`greetAll(names, ms=0)`**：`async` 函数，`Promise.all` 并行等待多个 `asyncGreet`，演示并发。
- **DRY**：`asyncGreet` 复用 `hello()`，不重复字符串拼接逻辑。
- **导出**：在 `index.ts` 追加 `export * from './async.js'`，遵循 `.js` 扩展名约定。
- **类型**：`delay: (ms: number) => Promise<void>`、`asyncGreet: Promise<string>`、`greetAll: Promise<string[]>`；仅 timers + 纯字符串，无 IO/eval/注入面，符合 shared 包定位。

## 4. 变更清单
| 文件 | 操作 | 内容 |
|---|---|---|
| `packages/shared/src/async.ts` | 新增文件 | `delay` / `asyncGreet` / `greetAll` 三个具名导出函数 |
| `packages/shared/src/index.ts` | 追加导出 | `export * from './async.js';` |
| `docs/async-await-usage.md` | 新增文档 | 本设计文档 |

## 5. 验证
- 类型检查：`pnpm --filter @myteam/shared exec tsc --noEmit`。
- 运行时自测：`tsx -e "import {asyncGreet,greetAll} from './packages/shared/src/index.js'; console.log(await asyncGreet('Alice',10)); console.log(await greetAll(['A','B'],10))"` 应输出 `Hello, Alice!` 与 `[ 'Hello, A!', 'Hello, B!' ]`。
- @reviewer 关注点：无安全风险（仅 timers + 字符串，无 IO/eval/注入面）；确认复用 `hello()`、遵循 `.js` 导出约定、未引入新依赖。

## 6. 目标函数签名
```ts
export function delay(ms: number): Promise<void>;
export async function asyncGreet(name?: string, ms?: number): Promise<string>;
export async function greetAll(names: string[], ms?: number): Promise<string[]>;
```

## 7. 待办清单
- [ ] @implementer: 新建 `packages/shared/src/async.ts`，实现 `delay` / `asyncGreet` / `greetAll`，复用 `hello()`，不加注释。
- [ ] @implementer: 在 `packages/shared/src/index.ts` 追加 `export * from './async.js';`。
- [ ] @implementer: 运行 shared 包类型检查确认无报错。
- [ ] @implementer: 运行时自测确认输出符合预期。
- [ ] @reviewer: 审查实现是否复用 `hello()`、是否符合 `.js` 导出约定、无安全问题。

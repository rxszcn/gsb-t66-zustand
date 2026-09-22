# persist.rehydrate() 的 thenable 契约

结论来源：`repro/rehydrate_thenable_contract.ts` H3 探针（esbuild 打包后 node 实测）与
`src/middleware/persist.ts` 实现对照。H3 实测读数：

```
H3 rehydrate() -> isPromise: false | then? function | finally? undefined | catch? function
H3 .finally() THREW: r.finally is not a function
H3 await ok
```

## 一、它算不算 Promise

不算。同步存储下 `rehydrate()` 返回的是 `toThenable`（`src/middleware/persist.ts:157`）
手工拼的对象字面量，只有 `then` / `catch` 两个方法，不是 `Promise` 实例。

- **`finally`：没有。** `r.finally` 是 `undefined`，调用即抛
  `TypeError: r.finally is not a function`（H3 实测）。
- **`catch`：有，但形同虚设。** 它只在上游同步抛错时才会被执行；而 `hydrate()`
  链条末尾自带 `.catch`（`persist.ts:328`），已把错误导去
  `onRehydrateStorage` 的回调，所以暴露给调用方的那个 thenable 永远是"成功态"，
  调用方再挂 `.catch` 永远不会触发。
- **`then(res, rej)`：第二参数被忽略。** 对象方法只声明了 `then(onFulfilled)`
  一个形参（`persist.ts:168`），`rej` 永远不会被调用——这个 thenable
  **没有 reject 通道，永不 reject**。
- **`await`：可用。** `await` 只要求 thenable，会同步调用 `then(resolve)` 并
  正常兑现（H3 实测 `await ok`），且因为上一条，`await` 也永远不会抛。
- **`instanceof Promise`：`false`。** 类型声明却写着
  `rehydrate: () => Promise<void> | void`（`persist.ts:139`），实现里靠
  `hydrate() as Promise<void>`（`persist.ts:353`）强转——类型在说谎。

## 二、直接 async 化返回真 Promise 行不行

不行。把 `hydrate` 改成 `async`（或让链路返回真 Promise）后，首个 `await` 之后的
所有续体都进微任务队列，**晚一拍的是状态推进本身**：

- `stateFromStorage = options.merge(...)` 和 `set(stateFromStorage, true)`
  （`persist.ts:302-307`）推迟到微任务；
- `hasHydrated = true`、`onFinishHydration` 回调（`persist.ts:325-326`）同样推迟；
- `onRehydrateStorage` 的完成回调也随之推迟。

而 `persistImpl` 的返回语句 `return stateFromStorage || configResult`
（`persist.ts:375`）在当前同步回合就执行，此刻 `stateFromStorage` 还是
`undefined`，于是 **`create()` 先返回未水合的初始状态**——最先看到没水合好状态的
就是 `create()` 调用方紧随其后的一次同步 `getState()`（React 场景即首屏渲染帧）。

撞的是整批同步存储用例（`tests/persistSync.test.tsx`），最典型的三条：

- `can manually rehydrate through the api`（`persistSync.test.tsx:498`）：
  `rehydrate()` **不 await**，下一行直接断言 `getState()` 已是水合值——
  晚一拍立即红；
- `can rehydrate state`（`persistSync.test.tsx:41`）：`create()` 返回后同步断言
  状态已是存储里的 `{ count: 42, ... }`；
- `can throw rehydrate error`（`persistSync.test.tsx:77`）：同步断言
  `onRehydrateStorage` 的 spy 已被调用。

## 三、调用方按 Promise 用会在哪儿崩

- **`rehydrate().finally(...)`：直接崩。** 运行时 `TypeError`，且 TS 声明是
  `Promise<void>` 编译期不拦；更阴的是异步存储下 `toThenable` 会透传真 Promise
  （`persist.ts:164`），同一段代码换种存储就忽好忽坏。
- **`.then(ok, err)`：不崩，但 `err` 是死代码。** 第二参数被静默忽略，调用方
  以为兜住的错误处理永远不会执行。
- **`.catch(...)` / `await ... catch`：不崩，但永不触发。** 错误已被内部
  `.catch` 吞给 `onRehydrateStorage` 回调，外层等 reject 的逻辑全部落空。
- **`instanceof Promise` 分支：静默走错路。** 凡是按 `instanceof` 区分
  "已完成 / 进行中"的封装（缓存、loading 态、测试断言）都会误判。
- **掩盖项：** `Promise.all` / `Promise.race` / `Promise.allSettled` 因 thenable
  assimilation 反而能正常工作，容易让人误以为它真是 Promise，把问题留到
  `.finally` 或 `instanceof` 处才爆。

## 四、修法要同时满足哪几条

1. **同步路径的状态推进不许进微任务。** `stateFromStorage` 合并、`set`、
   `hasHydrated = true`、`onHydrate` / `onFinishHydration` / `onRehydrateStorage`
   回调，在同步存储下必须仍在 `persistImpl` 返回前当场跑完——这是第二节约束，
   也是 `persistSync.test.tsx` 整批用例的前提。
2. **返回值必须是真 Promise 实例。** `instanceof Promise === true`，有
   `finally`，`then(res, rej)` 双参语义正确，`catch` 语义正确；同步存储下返回
   已兑现的 Promise，异步存储下返回随水合完成而 settle 的 Promise。
3. **错误通道唯一且明确。** 要么维持现状语义（错误经 `onRehydrateStorage` 回调
   报告、返回的 Promise 仍 resolve）并写进文档，要么改为 reject 并同步更新契约
   与测试；不允许再出现 `then` 第二参数被静默丢弃的形态。
4. **类型与运行时一致。** `rehydrate: () => Promise<void>` 的声明必须是真的，
   不再靠 `as Promise<void>` 强转遮羞；且 224 条现有测试不改、不红。

同时满足的典型形态：内部保留现有同步 thenable 链负责状态推进（满足第 1 条），
`rehydrate()` 出口处用真 Promise 包装结果——同步存储下水合早已当场完成，
`Promise.resolve(...)` 对 thenable 的 unwrap 发生在微任务里无所谓，因为状态
推进不依赖它（满足第 2、3 条）；类型声明随之如实（满足第 4 条）。

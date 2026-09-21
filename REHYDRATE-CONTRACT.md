# `persist.rehydrate()` 的 Thenable 契约（同步存储）

适用范围：`persist` 中间件在**同步存储**下（`storage.getItem()` 当场返回值、不返回
`Promise`，例如同步的 `localStorage` 封装）。复现入口：`repro/rehydrate_thenable_contract.ts`
里的 H3（esbuild 打包后 node 运行）。

## 一、它返回的算不算 Promise？`finally` / `catch` / `then` 第二参数各怎样

**不是真 Promise，是 `src/middleware/persist.ts` 里 `toThenable` 手搓的 thenable**，同步路径下
`getItem` 不是 `Promise`，整条链 `.then(...).then(...).catch(...)` 都由手写 thenable 串起来，
`rehydrate` 末尾用 `as Promise<void>` 把类型抹平，运行时类型与声明不符。

H3 实测读数（原样照抄）：

```text
H3 rehydrate() -> isPromise: false | then? function | finally? undefined | catch? function
H3 .finally() THREW: r.finally is not a function
H3 await ok
```

逐项：

- **`instanceof Promise`：`false`**。没有 `Symbol.toStringTag`、不带原生 Promise 原型，
  `Promise.resolve(r)` 会保留它并走其私有 `then`（不会被“升级”成真 Promise）。
- **`.finally`：不存在（`undefined`）**。调用直接抛同步 `TypeError: r.finally is not a function`。
  手写 thenable 只实现了 `then` 和 `catch` 两个方法。
- **`.catch(onRejected)`：方法存在，但语义是歪的**：
  - 签名只收一个回调，而且回调是**同步**调用，不是微任务里调；
  - 对手搓的“已拒绝”thenable（源头：`toThenable` 的 `fn` 抛错那个分支），它的 `catch`
    被实现成 `catch(onRejected) { return toThenable(onRejected)(e) }`——**会**同步把错误交给
    `onRejected`；
  - 但 `rehydrate()` 返回的是链尾那个 thenable。链尾的 `.catch` 正是水合内部的错误收口
    （`postRehydrateCallback?.(undefined, e)`），它正常返回、不抛错，于是**链尾永远是
    “已成功”那一款 thenable**。也就是说顶层 `r.catch(...)` 挂的回调永远不会被触发，
    `await r` 对 `getItem` 抛错、`merge` 抛错都实测 **RESOLVED 而不是 reject**：
    错误只通过 `onRehydrateStorage` 的后置回调 `(state, error)` 送出。
- **`then(onFulfilled, onRejected)` 的第二参数被静默丢弃**。成功款 thenable 的实现是
  `then(onFulfilled) { return toThenable(onFulfilled)(result) }`，形参里根本没有第二参；
  拒绝款的实现是 `then(_onFulfilled) { return this }`，同样没有第二参。因此
  `r.then(res, rej)` 里的 `rej` **任何情况下都不会被调用**，成功路径实测第二参回调计数为 0。
  后果是：拿到一个真的处于拒绝态的裸手搓 thenable 时，`await` 它会**永久 pending**
  （resolve 与 reject 都没人调），而不是抛错——好在水合链尾永远不会是那一款。
- 副作用仍然是**当场同步跑完**的：同步存储下，`rehydrate()` 返回之前，`merge`、`set(...)`、
  `hasHydrated = true`、`onFinishHydration` 监听都已在当前调用栈内执行；`await r` 只是顺带
  成功而已。

一句话：能 `await`（成功路径），但它只满足一个残缺的 thenable 形状，不是声明里写的
`Promise<void>`。

## 二、能不能直接 async 化、返回真 Promise？哪一步晚一拍、谁先看到没水合的状态、撞哪类用例

要分两种“async 化”，因果相反，不能混为一谈（已在仓库副本上分别打补丁复核）：

### 改法 A：只加 `async` 关键字（`const hydrate = async () => { ... }`），链仍是 toThenable

**可行，224 条测试全绿。** 同步存储下，`toThenable` 链的每一级 `then` 都是**同步**调用回调的，
`async` 函数体内在第一个真正的异步点之前全部同步执行；返回值被规整成真 `Promise`
（`instanceof Promise === true`、有 `finally`/`catch`）。水合副作用（`set`、`hasHydrated`、
finish 监听、后置回调）依旧在 `createStore()` / `rehydrate()` 的当前调用栈内跑完，一拍都不晚。

### 改法 B（“典型/天真”改法）：把手搓链换成原生 Promise，例如
`return Promise.resolve(storage.getItem(name)).then(...).then(...)...`，或直接
`async` 化内部步骤并依赖 `await`

**不行，实测 19 条变红（205/224 通过）。** 晚一拍的位置与受害者：

- **晚一拍的那一步**：原生 `.then`/`await` 的回调永远排进**微任务队列**，即便
  `getItem()` 当场返回字符串，第一段水合逻辑（读值、`merge`、`set(stateFromStorage, true)`、
  `postRehydrateCallback`、`hasHydrated = true`、finish 监听）也要等当前同步代码走完后的下一个
  microtask 才执行。
- **谁先看到没水合好的状态**：
  1. `createStore(persist(...))` 的**同步调用方**——持久化中间件靠
     `return stateFromStorage || configResult` 在创建当场把存储状态并进初始 state；
     水合推迟后，创建返回的是 `configResult`（初始默认值），`store.getState()` 下一行读到的
     就是未水合的默认状态；
  2. **React 首次渲染/同步订阅者**，同一拍内拿到的也是默认状态；
  3. `persist.hasHydrated()` 的同步调用方，下一行读到 `false`；
  4. `onRehydrateStorage` 后置回调的同步断言方，下一行时回调还没被调用（spy 调用数 0）；
  5. 连**异步存储**也被拖慢一拍：`rehydrate()` 之后立刻同步断言 `migrate` 已被调用的用例同样
     失败（`Promise.resolve` 凭空多加了一层 microtask）。
- **撞哪类用例**：所有“创建/手动 rehydrate 之后不 await、下一行就断言已水合”的同步契约用例，
  实测红在 `tests/persistSync.test.tsx` 的 18 条，代表如：
  `can rehydrate state`（创建后立即 `getState()` 应为 `{count:42}`）、
  `can persist state`（第二次建店立即读到持久化值、后置回调已带 error=undefined 调用）、
  `can manually rehydrate through the api`（`rehydrate()` 不 await，下一行
  `getState()` 就要等于 `{count:1}`）、
  `can check if the store has been hydrated through the api`（建店后
  `hasHydrated()` 立即为 `true`）、
  `can throw rehydrate error`（建店后同步断言后置回调已收到 error）、
  以及 migrate / custom merge / partialize / Map 序列化 / “水合自身状态不回写 setItem” 等；
  外加 `tests/persistAsync.test.tsx` 的
  `persist clearStorage hydration generation > keeps a cleared delayed migration from hydrating state`
  1 条（要求 `rehydrate()` 同步发起 `migrate` 调用）。

结论：**同步存储下，水合必须在 `rehydrate()`/建店返回前于同一调用栈跑完**，这是现存行为的硬
约束，不是实现细节。“让返回值变成真 Promise”本身可以（改法 A 证明），但不能以把同步链推到
微任务里为代价。

## 三、调用方按真 Promise 用，会在哪儿崩

类型声明是 `() => Promise<void> | void`，TS 不拦；按真 Promise 使用时：

1. **`r.finally(cb)`**：同步抛 `TypeError: r.finally is not a function`（H3 实测）。
   放在 `try` 外会直接打断当前调用栈。
2. **`r.then(onOk, onErr)` 靠第二参数接错**：`onErr` 永不触发。水合错误（`getItem` 抛错、
   JSON.parse 失败、`merge`/`migrate` 抛错）已经被链尾 `catch` 收走，只走
   `onRehydrateStorage` 的 `(state, error)`；顶层 thenable 表现为成功，
   `try { await r } catch {}` **catch 不到**，`.catch()` 分支也永远不执行。调用方若以
   “reject 即水合失败”编程，会把失败误判成成功。
3. **`instanceof Promise` / `r?.finally` 分支判断**：走到“非 Promise”兜底分支或直接误判。
4. **依赖原生 Promise 工具的组合**：`Promise.allSettled` 拿到顶层 r 不会炸（它是成功款），
   但结果永远是 `fulfilled`，拿不到水合错误；而任何把链中“拒绝款裸 thenable”当值传播的场景，
   `await` / `Promise.all` 会**永久挂起**（rej 没人调，thenable 永不 settle）。
5. **时序假设反转**：真 Promise 的回调必在微任务里；这个 thenable 的 `then`/`catch` 回调在
   同步路径上是**当场同步**执行的，按微任务时序写的代码会早一拍观察到状态。
6. 好的一面：成功路径单纯 `await r` 能用（H3 实测 `await ok`），`Promise.resolve(r)`、
   async/await 的解包不抛——这也是它长期没被发现的原因。

## 四、修法必须同时满足哪几条

1. **同步存储下水合同步完成**：`rehydrate()`（以及未开 `skipHydration` 时的建店）返回前，
   读值、`merge`、`set`、后置回调、finish 监听必须已在同一调用栈跑完；
   `createStore(...)` 后立即 `getState()` 必须已是水合后的状态（保住
   `return stateFromStorage || configResult` 这套初始态合并语义）。
2. **返回真 Promise**：`instanceof Promise === true`，带 `finally`、`catch`、
   双参 `then`，可被 `Promise.all/race/allSettled` 正确吸收；成功路径照常 resolve。
3. **错误可被 Promise 侧观测**：水合失败要么让返回的 Promise reject，要么文档明确
   “错误只走 `onRehydrateStorage` 后置回调、Promise 永远 resolve”；不能维持现在“rej 被静默
   丢弃、裸拒绝 thenable 会令 await 永久 pending”的中间态。
4. **不拖慢异步存储路径**：不得给原本的异步链平白增加 microtask（异步用例要求
   `rehydrate()` 同步发起 `getItem`/`migrate`，且 hydration generation 的竞态作废逻辑
   `currentVersion !== hydrationVersion` 保持成立）。
5. **保留现有并发/竞态与回调语义**：`hasHydrated`、`onHydrate`、`onFinishHydration`、
   `onRehydrateStorage`（含回调内再 `setState` 后以最新 `get()` 为准）、多次并发
   `rehydrate()` 的版本作废、`skipHydration` 手动水合，行为都不能变。
6. **类型与运行时一致**：`rehydrate: () => Promise<void> | void` 的声明要兑现（同步给
   Promise、异步给 Promise；`void` 仅留给无 storage 的早退等场景），不再靠
   `as Promise<void>` 掩盖手搓 thenable。

改法 A（`hydrate` 加 `async` 关键字、内部仍走同步 `toThenable` 链）实测同时满足 1、2、4、5、6
且 224 条全绿；第 3 条需要额外决策错误走向。改法 B（换成原生 Promise 链/await）违反第 1 条，
实测 19 条变红，不可取。

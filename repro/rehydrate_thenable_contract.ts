// Probe C (exploration): several persist/vanilla hypotheses at once
const mkMem = () => {
  const mem = new Map<string, string>()
  return {
    mem,
    state: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    } as any,
  }
}

const { createStore } = await import(
  '../src/vanilla.ts'
)
const { persist, createJSONStorage } = await import(
  '../src/middleware.ts'
)

// ---------- H1: `set()` called during initialization clobbers storage ----------
{
  const { mem, state } = mkMem()
  mem.set(
    'h1',
    JSON.stringify({ state: { count: 99, bears: 'saved' }, version: 0 }),
  )
  const store: any = createStore(
    persist(
      (set: any) => {
        set({ count: 1 }) // called during initialization
        return { count: 0, bears: 'init' }
      },
      { name: 'h1', storage: createJSONStorage(() => state) },
    ),
  )
  console.log('H1 storage after init =', mem.get('h1'))
  console.log('H1 state after init   =', store.getState())
}

// ---------- H2: storage getter that is unavailable at creation, available later ---------
{
  const { mem, state } = mkMem()
  let available = false
  const store: any = createStore(
    persist(
      (set: any) => ({ count: 0, inc: () => set({ count: 1 }) }),
      {
        name: 'h2',
        storage: createJSONStorage(() => {
          if (!available) throw new Error('SecurityError: storage disabled')
          return state
        }),
      },
    ),
  )
  available = true // storage becomes available right after creation
  store.getState().inc()
  store.setState({ count: 5 })
  console.log('H2 persisted =', mem.get('h2'), '(expected {"state":{"count":5},...})')
  console.log('H2 persist api present =', !!store.persist)
}

// ---------- H3: what does rehydrate() return for sync storage? ----------
{
  const { state } = mkMem()
  const store: any = createStore(
    persist(() => ({ count: 0 }), {
      name: 'h3',
      storage: createJSONStorage(() => state),
      skipHydration: true,
    } as any),
  )
  const r = store.persist.rehydrate()
  console.log(
    'H3 rehydrate() -> isPromise:',
    r instanceof Promise,
    '| then?',
    typeof r.then,
    '| finally?',
    typeof r.finally,
    '| catch?',
    typeof r.catch,
  )
  try {
    r.finally(() => {})
    console.log('H3 .finally() ok')
  } catch (e) {
    console.log('H3 .finally() THREW:', (e as Error).message)
  }
  try {
    await r
    console.log('H3 await ok')
  } catch (e) {
    console.log('H3 await threw', (e as Error).message)
  }
}

// ---------- H4: setState with an updater that returns undefined ----------
{
  const store: any = createStore(() => ({ count: 0, bears: 3 }))
  store.subscribe((s: any, p: any) => console.log('H4 notified', s, p))
  store.setState((s: any) => {
    /* forgot to return */
  })
  console.log('H4 state after void updater =', store.getState())
  console.log('H4 initial after void =', store.getInitialState())
}

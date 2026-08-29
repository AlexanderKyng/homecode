import { Deferred, Effect } from "effect"

interface Waiter {
  readonly sessionID: string
  readonly deferred: Deferred.Deferred<number>
}

interface EndpointState {
  readonly leases: Map<string, number>
  readonly activeSubagents: Set<string>
  subagentCounter: number
  readonly waitingQueue: Waiter[]
}

const endpoints = new Map<string, EndpointState>()

function getEndpointState(endpoint: string): EndpointState {
  const existing = endpoints.get(endpoint)
  if (existing) return existing
  const state: EndpointState = {
    leases: new Map(),
    activeSubagents: new Set(),
    subagentCounter: 1,
    waitingQueue: [],
  }
  endpoints.set(endpoint, state)
  return state
}

export function slot(input: {
  endpoint: string
  sessionID: string
  slots: number
  subagent: boolean
}): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const state = getEndpointState(input.endpoint)

    const existing = state.leases.get(input.sessionID)
    if (existing !== undefined) return existing

    if (!input.subagent) {
      const occupied = new Set(state.leases.values())
      if (occupied.has(0)) {
        return yield* Effect.fail(
          new Error(
            "llama-server primary slot 0 is already in use. Close the active HomeCode session before starting another one.",
          ),
        )
      }
      state.leases.set(input.sessionID, 0)
      return 0
    }

    const maxConcurrent = Math.max(1, input.slots - 1)

    if (state.activeSubagents.size < maxConcurrent) {
      const slotId = state.subagentCounter++
      state.leases.set(input.sessionID, slotId)
      state.activeSubagents.add(input.sessionID)
      return slotId
    }

    const deferred = yield* Deferred.make<number>()
    const waiter: Waiter = { sessionID: input.sessionID, deferred }
    state.waitingQueue.push(waiter)

    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          const idx = state.waitingQueue.indexOf(waiter)
          if (idx !== -1) state.waitingQueue.splice(idx, 1)
        }),
      ),
    )
  })
}

export function release(sessionID: string) {
  for (const [endpoint, state] of endpoints) {
    const wasActive = state.activeSubagents.has(sessionID)
    state.leases.delete(sessionID)
    state.activeSubagents.delete(sessionID)

    const waitIdx = state.waitingQueue.findIndex((w) => w.sessionID === sessionID)
    if (waitIdx !== -1) {
      state.waitingQueue.splice(waitIdx, 1)
    }

    if (wasActive && state.waitingQueue.length > 0) {
      const next = state.waitingQueue.shift()
      if (next) {
        const slotId = state.subagentCounter++
        state.leases.set(next.sessionID, slotId)
        state.activeSubagents.add(next.sessionID)
        Effect.runSync(Deferred.succeed(next.deferred, slotId))
      }
    }

    if (state.leases.size === 0 && state.waitingQueue.length === 0) {
      endpoints.delete(endpoint)
    }
  }
}

export * as LlamaServer from "./llama-server"


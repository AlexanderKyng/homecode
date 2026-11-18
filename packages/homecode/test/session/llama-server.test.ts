import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LlamaServer } from "../../src/session/llm/llama-server"

describe("session.llama-server", () => {
  test("keeps primary in slot zero and sequences subagents when exceeding slots", async () => {
    const endpoint = "test:llama-server-slot-lifecycle"
    const primary = "primary-slot-lifecycle"
    const first = "first-subagent-slot-lifecycle"
    const second = "second-subagent-slot-lifecycle"
    const third = "third-subagent-slot-lifecycle"

    // Primary gets slot 0
    const slotP = await Effect.runPromise(LlamaServer.slot({ endpoint, sessionID: primary, slots: 2, subagent: false }))
    expect(slotP).toBe(0)

    // First subagent gets slot 1 (maxConcurrent = max(1, 2 - 1) = 1)
    const slot1 = await Effect.runPromise(LlamaServer.slot({ endpoint, sessionID: first, slots: 2, subagent: true }))
    expect(slot1).toBe(1)

    // Second subagent is queued because maxConcurrent is 1
    let secondResolved = false
    let slot2Result: number | undefined
    const secondPromise = Effect.runPromise(
      LlamaServer.slot({ endpoint, sessionID: second, slots: 2, subagent: true }),
    ).then((res) => {
      secondResolved = true
      slot2Result = res
    })

    // Give microtasks a chance to run to ensure second subagent is waiting
    await new Promise((r) => setTimeout(r, 10))
    expect(secondResolved).toBe(false)

    // Release first subagent slot
    LlamaServer.release(first)

    // Now second subagent resolves with slot ID 2
    await secondPromise
    expect(secondResolved).toBe(true)
    expect(slot2Result).toBe(2)

    // Release second subagent slot
    LlamaServer.release(second)

    // Next subagent gets slot ID 3
    const slot3 = await Effect.runPromise(LlamaServer.slot({ endpoint, sessionID: third, slots: 2, subagent: true }))
    expect(slot3).toBe(3)
    LlamaServer.release(third)

    // Reactivate primary slot 0 without changing anything
    LlamaServer.release(primary)
    const nextPrimary = await Effect.runPromise(
      LlamaServer.slot({ endpoint, sessionID: "next-primary", slots: 2, subagent: false }),
    )
    expect(nextPrimary).toBe(0)
    LlamaServer.release("next-primary")
  })

  test("works at 1 slot configuration", async () => {
    const endpoint = "test:llama-server-1-slot"
    const primary = "primary-1-slot"
    const sub1 = "sub-1-slot-1"
    const sub2 = "sub-1-slot-2"

    const slotP = await Effect.runPromise(LlamaServer.slot({ endpoint, sessionID: primary, slots: 1, subagent: false }))
    expect(slotP).toBe(0)

    const slot1 = await Effect.runPromise(LlamaServer.slot({ endpoint, sessionID: sub1, slots: 1, subagent: true }))
    expect(slot1).toBe(1)

    let sub2Resolved = false
    let sub2Slot: number | undefined
    const sub2Promise = Effect.runPromise(
      LlamaServer.slot({ endpoint, sessionID: sub2, slots: 1, subagent: true }),
    ).then((res) => {
      sub2Resolved = true
      sub2Slot = res
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(sub2Resolved).toBe(false)

    LlamaServer.release(sub1)
    await sub2Promise
    expect(sub2Resolved).toBe(true)
    expect(sub2Slot).toBe(2)

    LlamaServer.release(sub2)
    LlamaServer.release(primary)
  })
})

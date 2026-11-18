import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

const wait = (millis: number) => Effect.sleep(`${millis} millis`)

const runtime = (execute: (input: unknown) => Effect.Effect<unknown>) =>
  CodeMode.make({
    tools: {
      inspect: Tool.make({
        description: "Return the inspected value",
        input: Schema.Struct({ value: Schema.Unknown }),
        output: Schema.Unknown,
        execute,
      }),
    },
    limits: { timeoutMs: 500, maxToolCalls: 8, maxOutputBytes: 2_048 },
  })

describe("HomeCode Code Mode interpreter port", () => {
  test("executes asynchronous tools, branches on results, and composes independent calls", async () => {
    const calls: unknown[] = []
    let active = 0
    let peak = 0
    const code = runtime((input) => Effect.sync(() => {
      calls.push(input)
      return input
    }).pipe(
      Effect.flatMap((result) => {
        active++
        peak = Math.max(peak, active)
        return wait(10).pipe(Effect.andThen(Effect.sync(() => {
          active--
          return result
        })))
      }),
    ))
    const result = await Effect.runPromise(code.execute(`
      const [left, right] = await Promise.all([
        tools.inspect({ value: 2 }),
        tools.inspect({ value: 3 })
      ]);
      return left.value + right.value === 5 ? { ok: true } : { ok: false };
    `))
    expect(result).toMatchObject({ ok: true, value: { ok: true } })
    expect(calls).toHaveLength(2)
    expect(peak).toBe(2)
    expect(code.catalog[0]?.signature).toContain("tools.inspect")
  })

  test("rejects imports and host process access instead of evaluating them", async () => {
    const code = runtime((input) => Effect.succeed(input))
    const imported = await Effect.runPromise(code.execute(`import fs from "node:fs"; return fs`))
    const process = await Effect.runPromise(code.execute(`return process.cwd()`))
    const evalResult = await Effect.runPromise(code.execute(`return eval("1 + 1")`))
    expect(imported.ok).toBe(false)
    expect(process.ok).toBe(false)
    expect(evalResult.ok).toBe(false)
  })

  test("enforces tool call, timeout, and output budgets", async () => {
    const limited = CodeMode.make({
      tools: {
        inspect: Tool.make({
          description: "Return a value",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          execute: () => Effect.succeed("x".repeat(5_000)),
        }),
      },
      limits: { maxToolCalls: 0, maxOutputBytes: 16, timeoutMs: 15 },
    })
    const calls = await Effect.runPromise(limited.execute(`return await tools.inspect({})`))
    expect(calls.ok).toBe(false)
    if (!calls.ok) expect(calls.error.kind).toBe("ToolCallLimitExceeded")

    const slow = CodeMode.make({
      tools: {
        wait: Tool.make({
          description: "Wait",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          execute: () => wait(100).pipe(Effect.as("finished")),
        }),
      },
      limits: { timeoutMs: 5, maxToolCalls: 1, maxOutputBytes: 16 },
    })
    const timeout = await Effect.runPromise(slow.execute(`return await tools.wait({})`))
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) expect(timeout.error.kind).toBe("TimeoutExceeded")

    const bounded = CodeMode.make({ limits: { maxOutputBytes: 8 } })
    const output = await Effect.runPromise(bounded.execute(`return "0123456789"`))
    expect(output.truncated).toBe(true)
  })

  test("propagates Effect interruption to an active program", async () => {
    const code = runtime(() => wait(1_000).pipe(Effect.as("late")))
    const fiber = Effect.runFork(code.execute(`return await tools.inspect({ value: 1 })`))
    await Effect.runPromise(wait(10))
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})

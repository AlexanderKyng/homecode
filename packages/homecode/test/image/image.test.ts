import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Image } from "@/image/image"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Image.layer.pipe(Layer.provide(TestConfig.layer()))))
const tiny = testEffect(
  Layer.mergeAll(
    Image.layer.pipe(
      Layer.provide(
        TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }) }),
      ),
    ),
  ),
)

function crc32(value: Buffer) {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function largePng(png: Buffer, bytes: number) {
  const type = Buffer.from("tEXt")
  const payload = Buffer.alloc(bytes - png.length - 12, 32)
  Buffer.from("padding\0").copy(payload)
  const chunk = Buffer.alloc(payload.length + 12)
  chunk.writeUInt32BE(payload.length, 0)
  type.copy(chunk, 4)
  payload.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), payload.length + 8)
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)])
}

function part(mime: string, data: string) {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_test"),
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${data}`,
  }
}

describe("Image", () => {
  it.effect("normalizes generated png and jpeg attachments", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(Array.from({ length: 64 * 64 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
        64,
        64,
      )
      const image = yield* Image.Service
      const results = yield* Effect.all([
        image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64"))),
        image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64"))),
      ])

      source.free()
      expect(results.map((result) => result.url.startsWith(`data:${result.mime};base64,`))).toEqual([true, true])
      expect(results.every((result) => result.mime === "image/png" || result.mime === "image/jpeg")).toBe(true)
    }),
  )

  it.effect("accepts webp attachments that are already within limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const input = part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")

      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  it.effect("resizes images that fit the byte limit but exceed dimension limits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const resized = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.url.slice(result.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )

      source.free()
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("resizes a 5MB base64 image", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(9_000 * 4).fill(255), 9_000, 1)
      const data = largePng(Buffer.from(source.get_bytes()), (5 * 1024 * 1024 * 3) / 4)
      source.free()
      const input = part("image/png", data.toString("base64"))
      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = result.url.slice(result.url.indexOf(";base64,") + ";base64,".length)
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      expect(input.url.slice(input.url.indexOf(";base64,") + ";base64,".length).length).toBe(5 * 1024 * 1024)
      expect(result.url).not.toBe(input.url)
      expect(base64.length).toBeLessThan(5 * 1024 * 1024)
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  tiny.effect("fails with a typed size error when no resized candidate fits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) {
          expect(error.width).toBe(1)
          expect(error.height).toBe(1)
          expect(error.max).toBe(1)
        }
      }
    }),
  )
})

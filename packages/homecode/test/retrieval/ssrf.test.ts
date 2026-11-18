import { afterEach, describe, expect, it } from "bun:test"
import dns from "dns/promises"
import { validateSafeUrl, isPrivateOrRestrictedIP } from "@/retrieval/ssrf"
import { Effect } from "effect"

const originalLookup = dns.lookup

afterEach(() => {
  dns.lookup = originalLookup
})

describe("SSRF & Private IP Guard", () => {
  it("allows public valid HTTP/HTTPS URLs", async () => {
    dns.lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dns.lookup
    const res = await Effect.runPromise(validateSafeUrl("https://example.com/docs"))
    expect(res.hostname).toBe("example.com")
    expect(res.protocol).toBe("https:")
  })

  it("blocks a hostname when any DNS answer is private", async () => {
    dns.lookup = (async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]) as unknown as typeof dns.lookup
    const error = await Effect.runPromise(validateSafeUrl("https://mixed.example/docs").pipe(Effect.flip))
    expect(error._tag).toBe("SSRFError")
    expect(error.message).toContain("10.0.0.5")
  })

  it("blocks localhost and 127.0.0.1", async () => {
    const loopback = await Effect.runPromise(validateSafeUrl("http://localhost:8080").pipe(Effect.flip))
    expect(loopback._tag).toBe("SSRFError")

    const ip = await Effect.runPromise(validateSafeUrl("http://127.0.0.1:3000/secret").pipe(Effect.flip))
    expect(ip._tag).toBe("SSRFError")
  })

  it("blocks private IPv4 ranges", async () => {
    const range10 = await Effect.runPromise(validateSafeUrl("http://10.0.0.5/api").pipe(Effect.flip))
    expect(range10._tag).toBe("SSRFError")

    const range192 = await Effect.runPromise(validateSafeUrl("http://192.168.1.100").pipe(Effect.flip))
    expect(range192._tag).toBe("SSRFError")

    const range172 = await Effect.runPromise(validateSafeUrl("http://172.20.0.1").pipe(Effect.flip))
    expect(range172._tag).toBe("SSRFError")

    const linkLocal = await Effect.runPromise(
      validateSafeUrl("http://169.254.169.254/latest/meta-data").pipe(Effect.flip),
    )
    expect(linkLocal._tag).toBe("SSRFError")
  })

  it("blocks non-HTTP protocols", async () => {
    const fileUrl = await Effect.runPromise(validateSafeUrl("file:///etc/passwd").pipe(Effect.flip))
    expect(fileUrl._tag).toBe("SSRFError")

    const ftpUrl = await Effect.runPromise(validateSafeUrl("ftp://ftp.example.com").pipe(Effect.flip))
    expect(ftpUrl._tag).toBe("SSRFError")
  })

  it("identifies private and reserved IP addresses accurately", () => {
    expect(isPrivateOrRestrictedIP("127.0.0.1")).toBe(true)
    expect(isPrivateOrRestrictedIP("10.1.2.3")).toBe(true)
    expect(isPrivateOrRestrictedIP("192.168.0.1")).toBe(true)
    expect(isPrivateOrRestrictedIP("172.16.5.10")).toBe(true)
    expect(isPrivateOrRestrictedIP("172.31.255.255")).toBe(true)
    expect(isPrivateOrRestrictedIP("169.254.169.254")).toBe(true)
    expect(isPrivateOrRestrictedIP("::1")).toBe(true)
    expect(isPrivateOrRestrictedIP("fe80::1")).toBe(true)

    expect(isPrivateOrRestrictedIP("8.8.8.8")).toBe(false)
    expect(isPrivateOrRestrictedIP("1.1.1.1")).toBe(false)
    expect(isPrivateOrRestrictedIP("142.250.190.46")).toBe(false)
  })
  it("blocks IPv4-mapped and site-local IPv6 addresses", () => {
    expect(isPrivateOrRestrictedIP("::ffff:c0a8:0101")).toBe(true)
    expect(isPrivateOrRestrictedIP("fec0::1")).toBe(true)
    expect(isPrivateOrRestrictedIP("198.18.0.1")).toBe(true)
  })

  it("blocks URLs with embedded credentials", async () => {
    const credentials = await Effect.runPromise(validateSafeUrl("https://user:password@example.com").pipe(Effect.flip))
    expect(credentials._tag).toBe("SSRFError")
  })
})

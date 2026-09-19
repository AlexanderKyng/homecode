import dns from "dns/promises"
import net from "net"
import { Effect } from "effect"

export class SSRFError extends Error {
  readonly _tag = "SSRFError"
  constructor(message: string) {
    super(message)
    this.name = "SSRFError"
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "metadata.google.internal",
  "metadata",
  "instance-data",
])

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true

  const [a, b] = parts

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true
  // 10.0.0.0/8 (Private network)
  if (a === 10) return true
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 169.254.0.0/16 (Link-local / Cloud Metadata)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b >= 18 && b <= 19) return true
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true
  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true

  return false
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // Loopback
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true
  // Unspecified
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true

  // IPv4-mapped IPv6: ::ffff:192.168.1.1 or ::ffff:c0a8:0101
  if (normalized.startsWith("::ffff:")) {
    const rest = normalized.slice(7)
    const mappedHex = rest.match(/^([0-9a-f]{4}):([0-9a-f]{4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      return isPrivateIPv4([high >> 8, high & 255, low >> 8, low & 255].join("."))
    }
    if (net.isIPv4(rest)) {
      return isPrivateIPv4(rest)
    }
  }

  // Unique local addresses: fc00::/7 (fc00... to fdff...)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true

  // Link-local unicast: fe80::/10 (fe80... to febf...)
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16)
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfeff) return true

  // Multicast: ff00::/8
  if (normalized.startsWith("ff")) return true

  return false
}

export function isPrivateOrRestrictedIP(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return isPrivateIPv4(ip)
  if (family === 6) return isPrivateIPv6(ip)
  return true
}

export function validateSafeUrl(urlStr: string): Effect.Effect<URL, SSRFError> {
  return Effect.gen(function* () {
    let parsed: URL
    try {
      parsed = new URL(urlStr)
    } catch {
      return yield* Effect.fail(new SSRFError(`Invalid URL format: ${urlStr}`))
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* Effect.fail(
        new SSRFError(`Unsupported URL protocol: ${parsed.protocol}. Only http: and https: are permitted.`),
      )
    }

    if (parsed.username || parsed.password) {
      return yield* Effect.fail(new SSRFError("URLs containing embedded credentials are not permitted"))
    }
    const hostname = parsed.hostname.toLowerCase()

    if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
      return yield* Effect.fail(new SSRFError(`Access to internal/private hostname blocked for security: ${hostname}`))
    }

    // If hostname is directly an IP address
    if (net.isIP(hostname)) {
      if (isPrivateOrRestrictedIP(hostname)) {
        return yield* Effect.fail(new SSRFError(`Access to private/restricted IP blocked for security: ${hostname}`))
      }
      return parsed
    }

    // Resolve DNS and check all returned IPs
    const addresses = yield* Effect.tryPromise({
      try: () => dns.lookup(hostname, { all: true }),
      catch: (err) => new SSRFError(`DNS resolution failed for ${hostname}: ${String(err)}`),
    })

    if (!addresses || addresses.length === 0) {
      return yield* Effect.fail(new SSRFError(`No DNS records found for host: ${hostname}`))
    }

    for (const record of addresses) {
      if (isPrivateOrRestrictedIP(record.address)) {
        return yield* Effect.fail(
          new SSRFError(`Host ${hostname} resolved to private/restricted IP ${record.address}, request blocked`),
        )
      }
    }

    return parsed
  })
}

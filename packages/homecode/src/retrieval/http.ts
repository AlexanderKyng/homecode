import { Effect } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { SSRFError, validateSafeUrl } from "./ssrf"

const MAX_REDIRECTS = 5

type SafeRequestResult = {
  readonly response: HttpClientResponse.HttpClientResponse
  readonly url: string
}
const REDIRECT_SAFE_HEADERS = new Set(["accept", "accept-language", "user-agent"])

export function executeSafeRequest(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  options: { readonly validateInitialUrl?: boolean } = {},
  redirects = 0,
): Effect.Effect<SafeRequestResult, HttpClientError.HttpClientError | SSRFError | Error> {
  return Effect.gen(function* () {
    if (options.validateInitialUrl && redirects === 0) {
      yield* validateSafeUrl(request.url)
    }

    const response = yield* http
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
    const location = response.headers.location

    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: request.url }
    }

    if (redirects >= MAX_REDIRECTS) {
      return yield* Effect.fail(new Error(`Too many redirects while fetching ${request.url}`))
    }

    const nextUrl = yield* validateSafeUrl(new URL(location, request.url).href)
    const nextHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([key]) => REDIRECT_SAFE_HEADERS.has(key.toLowerCase())),
    )
    const nextRequest = HttpClientRequest.get(nextUrl.href).pipe(HttpClientRequest.setHeaders(nextHeaders))

    return yield* executeSafeRequest(http, nextRequest, options, redirects + 1)
  })
}

export * as RetrievalHttp from "./http"

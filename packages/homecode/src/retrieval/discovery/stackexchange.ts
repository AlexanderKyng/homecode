import { Effect } from "effect"
import { type DiscoveryCandidate, type DiscoveryOptions, type DiscoveryProvider } from "./types"
import { type QueryClassification } from "../classifier"

interface StackExchangeItem {
  readonly question_id: number
  readonly title: string
  readonly link: string
  readonly score: number
  readonly is_answered: boolean
  readonly accepted_answer_id?: number
  readonly answer_count: number
  readonly tags: readonly string[]
  readonly creation_date: number
}

interface StackExchangeResponse {
  readonly items?: readonly StackExchangeItem[]
  readonly has_more?: boolean
  readonly quota_remaining?: number
  readonly quota_max?: number
  readonly backoff?: number
  readonly error_id?: number
  readonly error_message?: string
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
}

export function createStackExchangeProvider(customFetch?: typeof fetch): DiscoveryProvider {
  const fetchFn = customFetch ?? fetch

  return {
    id: "stackexchange",
    name: "Stack Overflow & Stack Exchange API",
    supports: (classification: QueryClassification) => {
      return (
        classification.category === "error_debug" ||
        classification.category === "technical_docs" ||
        classification.query.toLowerCase().includes("how to") ||
        classification.query.toLowerCase().includes("error") ||
        classification.query.toLowerCase().includes("exception") ||
        classification.query.toLowerCase().includes("stackoverflow")
      )
    },
    search: (query: string, options: DiscoveryOptions) =>
      Effect.tryPromise({
        try: async () => {
          const limit = options.limit ?? 8
          const timeout = options.timeoutMs ?? 3500

          const cleanQuery = query.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim()
          if (!cleanQuery) return []

          const params = new URLSearchParams({
            site: "stackoverflow",
            q: cleanQuery,
            pagesize: String(limit),
            order: "desc",
            sort: "relevance",
          })
          if (options.stackExchangeKey) {
            params.set("key", options.stackExchangeKey)
          }

          const url = `https://api.stackexchange.com/2.3/search/advanced?${params.toString()}`
          const res = await fetchFn(url, {
            headers: {
              Accept: "application/json",
              "User-Agent": "HomeCode-Retrieval-Agent/2.0",
            },
            signal: AbortSignal.timeout(timeout),
          })

          if (!res.ok) {
            return []
          }

          const data = (await res.json()) as StackExchangeResponse
          const items = data.items ?? []
          const candidates: DiscoveryCandidate[] = []

          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            const title = decodeHtmlEntities(item.title)
            const tagStr = item.tags.slice(0, 4).join(", ")
            const snippet = `[Score: ${item.score} | Answers: ${item.answer_count}${item.accepted_answer_id ? " (Accepted)" : ""}] Tags: [${tagStr}]`

            candidates.push({
              url: item.link,
              title,
              snippet,
              provider: "stackexchange",
              providerRank: i + 1,
              sourceType: "stackoverflow",
              publishedDate: new Date(item.creation_date * 1000).toISOString(),
              metadata: {
                questionId: item.question_id,
                score: item.score,
                isAnswered: item.is_answered,
                hasAcceptedAnswer: Boolean(item.accepted_answer_id),
                answerCount: item.answer_count,
                tags: item.tags,
              },
            })
          }

          return candidates
        },
        catch: (err) => new Error(`Stack Exchange discovery failed: ${String(err)}`),
      }),
  }
}

export * as StackExchangeDiscovery from "./stackexchange"

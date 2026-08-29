import { Effect } from "effect"
import { type DiscoveryCandidate, type DiscoveryOptions, type DiscoveryProvider } from "./types"
import { type QueryClassification } from "../classifier"

interface GitHubRepoItem {
  readonly id: number
  readonly full_name: string
  readonly html_url: string
  readonly description: string | null
  readonly stargazers_count: number
  readonly language: string | null
  readonly updated_at: string
}

interface GitHubCodeItem {
  readonly name: string
  readonly path: string
  readonly html_url: string
  readonly repository: {
    readonly full_name: string
    readonly description: string | null
    readonly html_url: string
  }
}

interface GitHubIssueItem {
  readonly id: number
  readonly number: number
  readonly title: string
  readonly html_url: string
  readonly body: string | null
  readonly state: string
  readonly comments: number
  readonly created_at: string
  readonly user?: { readonly login: string }
}

export function createGitHubProvider(customFetch?: typeof fetch): DiscoveryProvider {
  const fetchFn = customFetch ?? fetch

  return {
    id: "github",
    name: "GitHub API Discovery",
    supports: (classification: QueryClassification) => {
      return (
        classification.category === "workspace_symbol" ||
        classification.category === "error_debug" ||
        classification.category === "technical_docs" ||
        classification.query.toLowerCase().includes("github") ||
        classification.query.toLowerCase().includes("repo") ||
        classification.query.toLowerCase().includes("issue")
      )
    },
    search: (query: string, options: DiscoveryOptions) =>
      Effect.tryPromise({
        try: async () => {
          const limit = options.limit ?? 10
          const token =
            options.githubToken ||
            process.env.GITHUB_TOKEN ||
            process.env.GH_TOKEN ||
            ""

          const headers: Record<string, string> = {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "HomeCode-Retrieval-Agent/2.0",
          }
          if (token) {
            headers.Authorization = `Bearer ${token}`
          }

          const qLower = query.toLowerCase()
          const isIssue =
            qLower.includes("issue") ||
            qLower.includes("bug") ||
            qLower.includes("error") ||
            qLower.includes("failed") ||
            qLower.includes("panic") ||
            qLower.includes("exception") ||
            /#[0-9]+/.test(query)

          const isCode =
            !isIssue &&
            (/\b(function|class|interface|import|export|impl|struct|def)\b/i.test(query) ||
              /\.(ts|tsx|rs|go|py|js|json|md)$/.test(query))

          const candidates: DiscoveryCandidate[] = []
          const timeout = options.timeoutMs ?? 3500

          if (isIssue) {
            const cleanQuery = query.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim()
            const url = `https://api.github.com/search/issues?q=${encodeURIComponent(cleanQuery)}+type:issue&per_page=${limit}&sort=relevance`
            const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeout) })
            if (res.ok) {
              const data = (await res.json()) as { items?: GitHubIssueItem[] }
              const items = data.items ?? []
              for (let i = 0; i < items.length; i++) {
                const item = items[i]
                candidates.push({
                  url: item.html_url,
                  title: `${item.title} (#${item.number})`,
                  snippet: item.body ? item.body.slice(0, 300).replace(/\s+/g, " ").trim() : "",
                  provider: "github",
                  providerRank: i + 1,
                  sourceType: "github_issue",
                  publishedDate: item.created_at,
                  metadata: {
                    state: item.state,
                    comments: item.comments,
                    author: item.user?.login,
                  },
                })
              }
            }
          } else if (isCode && token) {
            // Code search requires authentication on GitHub REST API
            const cleanQuery = query.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim()
            const url = `https://api.github.com/search/code?q=${encodeURIComponent(cleanQuery)}&per_page=${limit}`
            const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeout) })
            if (res.ok) {
              const data = (await res.json()) as { items?: GitHubCodeItem[] }
              const items = data.items ?? []
              for (let i = 0; i < items.length; i++) {
                const item = items[i]
                const repoName = item.repository?.full_name || "GitHub Code"
                candidates.push({
                  url: item.html_url,
                  title: `${repoName}: ${item.path || item.name}`,
                  snippet: `Code in ${item.path || item.name} (${repoName})`,
                  provider: "github",
                  providerRank: i + 1,
                  sourceType: "github_code",
                  metadata: {
                    repository: repoName,
                    path: item.path,
                  },
                })
              }
            }
          }

          // Fallback or default: Repository search
          if (candidates.length === 0) {
            const cleanQuery = query.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim()
            const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleanQuery)}&per_page=${limit}&sort=stars`
            const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeout) })
            if (res.ok) {
              const data = (await res.json()) as { items?: GitHubRepoItem[] }
              const items = data.items ?? []
              for (let i = 0; i < items.length; i++) {
                const item = items[i]
                candidates.push({
                  url: item.html_url,
                  title: item.full_name,
                  snippet: item.description ? item.description.slice(0, 300) : `GitHub repository ${item.full_name}`,
                  provider: "github",
                  providerRank: i + 1,
                  sourceType: "github_repository",
                  publishedDate: item.updated_at,
                  metadata: {
                    stars: item.stargazers_count,
                    language: item.language,
                  },
                })
              }
            }
          }

          return candidates
        },
        catch: (err) => new Error(`GitHub discovery failed: ${String(err)}`),
      }),
  }
}

export * as GitHubDiscovery from "./github"

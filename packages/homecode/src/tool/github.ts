import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./github.txt"

// Define supported actions for the GitHub tool
const GitHubActionSchema = Schema.Literals(["read_file", "list_contents", "get_issue_or_pr", "get_workflow_runs"])

export const Parameters = Schema.Struct({
  owner: Schema.String.annotate({ description: "Repository owner (e.g., 'octocat')" }),
  repo: Schema.String.annotate({ description: "Repository name (e.g., 'hello-world')" }),
  action: GitHubActionSchema.annotate({
    description: "The action to execute: read_file, list_contents, get_issue_or_pr, get_workflow_runs",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Path to the file or directory (required for read_file and list_contents)",
  }),
  number: Schema.optional(Schema.Number).annotate({
    description: "Issue or Pull Request number (required for get_issue_or_pr)",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Optional branch, commit SHA, or tag (defaults to the repository's default branch)",
  }),
})

const GITHUB_TOKEN = process.env.GITHUB_TOKEN

export const GitHubTool = Tool.define(
  "github",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!GITHUB_TOKEN) {
            throw new Error("GITHUB_TOKEN is missing from the environment variables.")
          }

          const baseUrl = `https://api.github.com/repos/${params.owner}/${params.repo}`
          let targetUrl = baseUrl

          // Determine the endpoint depending on the requested action
          switch (params.action) {
            case "read_file":
            case "list_contents":
              const cleanPath = params.path ? `/${params.path.replace(/^\//, "")}` : ""
              targetUrl = `${baseUrl}/contents${cleanPath}`
              if (params.ref) targetUrl += `?ref=${params.ref}`
              break
            case "get_issue_or_pr":
              if (!params.number) throw new Error("The 'number' parameter is required for get_issue_or_pr.")
              targetUrl = `${baseUrl}/issues/${params.number}`
              break
            case "get_workflow_runs":
              targetUrl = `${baseUrl}/actions/runs?per_page=5`
              break
          }

          // Request explicit execution permission from the agent context
          yield* ctx.ask({
            permission: "github",
            patterns: [`${params.owner}/${params.repo}`],
            always: [],
            metadata: { ...params },
          })

          // Build request with GitHub API mandatory headers
          const request = HttpClientRequest.get(targetUrl).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "homecode-ai-agent",
            }),
          )

          const response = yield* HttpClient.filterStatusOk(http).execute(request)
          const json = (yield* response.json) as any

          let output = ""

          // Format output string to be perfectly scannable for the LLM
          switch (params.action) {
            case "read_file":
              if (json.encoding === "base64" && json.content) {
                output = Buffer.from(json.content, "base64").toString("utf-8")
              } else {
                output = "Failed to parse file content (unsupported or missing encoding)."
              }
              break

            case "list_contents":
              if (Array.isArray(json)) {
                output = json.map((f: any) => `[${f.type.toUpperCase()}] ${f.name} (Path: ${f.path})`).join("\n")
              } else {
                output = "The requested path is a file, or not a valid directory. Use 'read_file' instead."
              }
              break

            case "get_issue_or_pr":
              output = [
                `Title: ${json.title} (#${json.number})`,
                `State: ${json.state}`,
                `Author: ${json.user?.login}`,
                `Created At: ${json.created_at}`,
                `Type: ${json.pull_request ? "Pull Request" : "Issue"}`,
                `Body:\n${json.body || "No description provided."}`,
              ].join("\n")
              break

            case "get_workflow_runs":
              const runs = json.workflow_runs ?? []
              if (runs.length === 0) {
                output = "No recent workflow runs found."
              } else {
                output = runs
                  .map(
                    (run: any) =>
                      `- Workflow: ${run.name} | Event: ${run.event} | Status: ${run.status} | Conclusion: ${run.conclusion ?? "In_Progress"} | Link: ${run.html_url}`,
                  )
                  .join("\n")
              }
              break
          }

          return {
            output,
            title: `GitHub [${params.action}] -> ${params.owner}/${params.repo}`,
            metadata: { owner: params.owner, repo: params.repo, action: params.action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

import { describe, expect, it } from "bun:test"
import { extractFromHtml, extractFromJson } from "@/retrieval/extractor"

describe("Intelligent Extractor", () => {
  it("extracts clean markdown and title from HTML", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Effect-TS Guide</title>
          <meta name="description" content="A guide to Effect-TS">
          <meta name="author" content="Effect Team">
        </head>
        <body>
          <nav><a>Home</a> <a>About</a></nav>
          <header><h1>Welcome to Site</h1></header>
          <main>
            <h1>Effect-TS Guide</h1>
            <p>Effect is a powerful TypeScript library for building robust applications.</p>
            <p>It provides structured concurrency and typed errors.</p>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `

    const doc = extractFromHtml(html)
    expect(doc.title).toContain("Effect-TS Guide")
    expect(doc.content).toContain("Effect is a powerful TypeScript library")
    expect(doc.content).toContain("It provides structured concurrency")
    expect(doc.content).not.toContain("Copyright 2026")
  })

  it("preserves fenced code blocks with language identifiers", () => {
    const html = `
      <html>
        <body>
          <article>
            <h1>Code Example</h1>
            <p>Here is how to decode a schema:</p>
            <pre><code class="language-typescript">import { Schema } from "effect"
const User = Schema.Struct({ name: Schema.String })</code></pre>
          </article>
        </body>
      </html>
    `

    const doc = extractFromHtml(html)
    expect(doc.content).toContain("```typescript")
    expect(doc.content).toContain('import { Schema } from "effect"')
    expect(doc.content).toContain("Schema.Struct({ name: Schema.String })")
  })

  it("converts HTML tables to markdown tables", () => {
    const html = `
      <html>
        <body>
          <article>
            <h1>API Reference</h1>
            <table>
              <thead>
                <tr><th>Function</th><th>Return Type</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>decodeUnknownEffect</td><td>Effect</td><td>Decodes schema asynchronously</td></tr>
                <tr><td>encode</td><td>string</td><td>Serializes to TOON format</td></tr>
              </tbody>
            </table>
          </article>
        </body>
      </html>
    `

    const doc = extractFromHtml(html)
    expect(doc.content).toContain("| Function | Return Type | Description |")
    expect(doc.content).toContain("| --- | --- | --- |")
    expect(doc.content).toContain("| decodeUnknownEffect | Effect | Decodes schema asynchronously |")
  })

  it("formats structured JSON correctly", () => {
    const json = JSON.stringify({
      status: "ok",
      count: 2,
      data: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }],
    })

    const doc = extractFromJson(json, { format: "markdown" })
    expect(doc.title).toBe("JSON Response")
    expect(doc.content).toContain("```json")
    expect(doc.content).toContain('"status": "ok"')
    expect(doc.content).toContain('"name": "Alpha"')
  })
})

import { describe, expect, it } from "bun:test"
import { extractFromHtml } from "@/retrieval/extractor"

describe("HTML Extractor Multi-Site Fixtures & Fidelity Benchmark", () => {
  it("MDN Web Docs fixture: preserves headings, code syntax, and browser compatibility notes", () => {
    const mdnHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Array.prototype.flatMap() - JavaScript | MDN</title></head>
        <body>
          <nav class="breadcrumbs"><a>JavaScript</a> > <a>Array</a></nav>
          <header class="header">MDN Web Docs Navigation</header>
          <main id="content">
            <h1>Array.prototype.flatMap()</h1>
            <p class="summary">The <code>flatMap()</code> method of Array instances returns a new array formed by applying a given callback function to each element.</p>
            <h2>Syntax</h2>
            <pre><code class="language-js">flatMap(callbackFn)
flatMap(callbackFn, thisArg)</code></pre>
            <h2>Description</h2>
            <p>The <code>flatMap</code> method is identical to a <code>map()</code> followed by a <code>flat()</code> of depth 1.</p>
            <table>
              <thead><tr><th>Browser</th><th>Version</th></tr></thead>
              <tbody><tr><td>Chrome</td><td>69</td></tr><tr><td>Firefox</td><td>62</td></tr></tbody>
            </table>
          </main>
          <footer class="footer">MDN Legal</footer>
        </body>
      </html>
    `
    const doc = extractFromHtml(mdnHtml)
    expect(doc.title).toContain("Array.prototype.flatMap()")
    expect(doc.content).toContain("```js")
    expect(doc.content).toContain("flatMap(callbackFn)")
    expect(doc.content).toContain("| Browser | Version |")
    expect(doc.content).not.toContain("MDN Legal")
    expect(doc.content).not.toContain("MDN Web Docs Navigation")
  })

  it("GitHub Issue fixture: preserves comments, usernames, and fenced code blocks", () => {
    const ghIssueHtml = `
      <html>
        <head><title>Fix memory leak in child process spawner #4521</title></head>
        <body>
          <header>GitHub Header</header>
          <article class="issue">
            <h1>Fix memory leak in child process spawner #4521</h1>
            <div class="comment">
              <p>When running long-lived background jobs, unclosed stdio streams retain buffers.</p>
              <pre><code class="language-typescript">const proc = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.destroy();</code></pre>
            </div>
          </article>
          <footer>GitHub Footer</footer>
        </body>
      </html>
    `
    const doc = extractFromHtml(ghIssueHtml)
    expect(doc.title).toContain("Fix memory leak")
    expect(doc.content).toContain("```typescript")
    expect(doc.content).toContain("proc.stdout.destroy()")
    expect(doc.content).not.toContain("GitHub Footer")
  })

  it("Stack Overflow Q&A fixture: preserves question, accepted answer, and code snippets", () => {
    const soHtml = `
      <html>
        <head><title>How to configure SQLite busy_timeout with WAL mode in Node.js</title></head>
        <body>
          <div class="top-bar">StackOverflow Header</div>
          <main>
            <h1>How to configure SQLite busy_timeout with WAL mode in Node.js</h1>
            <div class="question"><p>I am getting SQLITE_BUSY errors during concurrent writes.</p></div>
            <div class="answer accepted-answer">
              <h2>Accepted Answer</h2>
              <p>Execute PRAGMA busy_timeout immediately after opening the connection:</p>
              <pre><code class="language-javascript">db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');</code></pre>
            </div>
          </main>
          <div class="sidebar">Related Ads</div>
        </body>
      </html>
    `
    const doc = extractFromHtml(soHtml)
    expect(doc.title).toContain("SQLite busy_timeout")
    expect(doc.content).toContain("Accepted Answer")
    expect(doc.content).toContain("```javascript")
    expect(doc.content).toContain("db.pragma('busy_timeout = 5000')")
    expect(doc.content).not.toContain("Related Ads")
  })

  it("Docusaurus & VitePress documentation fixture: preserves sidebar-free main article", () => {
    const docHtml = `
      <html>
        <head><title>Schema Decoding | Effect Documentation</title></head>
        <body>
          <aside class="sidebar"><h3>Navigation</h3><ul><li><a>Intro</a></li><li><a>Schema</a></li></ul></aside>
          <article class="doc-content">
            <h1>Schema Decoding</h1>
            <p>Decoding converts unknown input data into typed structures.</p>
            <pre><code class="language-typescript">const decode = Schema.decodeUnknownEffect(User);</code></pre>
          </article>
          <div class="toc"><h3>On this page</h3></div>
        </body>
      </html>
    `
    const doc = extractFromHtml(docHtml)
    expect(doc.title).toContain("Schema Decoding")
    expect(doc.content).toContain("Schema.decodeUnknownEffect(User)")
    expect(doc.content).not.toContain("On this page")
  })

  it("Table-heavy content: converts HTML tables into clean GFM Markdown tables", () => {
    const tableHtml = `
      <html>
        <head><title>Comparison of Web Frameworks</title></head>
        <body>
          <main>
            <h1>Framework Comparison</h1>
            <table>
              <thead>
                <tr><th>Framework</th><th>Runtime</th><th>Performance</th></tr>
              </thead>
              <tbody>
                <tr><td>HomeCode</td><td>Bun</td><td>Ultra Fast</td></tr>
                <tr><td>Next.js</td><td>Node.js</td><td>Fast</td></tr>
              </tbody>
            </table>
          </main>
        </body>
      </html>
    `
    const doc = extractFromHtml(tableHtml)
    expect(doc.content).toContain("| Framework | Runtime | Performance |")
    expect(doc.content).toContain("| --- | --- | --- |")
    expect(doc.content).toContain("| HomeCode | Bun | Ultra Fast |")
  })
})

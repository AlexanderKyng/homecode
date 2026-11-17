# Third-party notices

## Semble

HomeGrep's Python bridge depends on the unmodified external Semble project at
revision `8ee6463efbb1ff755c339e965c7298b7afd7db5b` (Semble 0.7.0):

https://github.com/MinishLab/semble/tree/8ee6463efbb1ff755c339e965c7298b7afd7db5b

Semble is licensed under the MIT License. Copyright Thomas van Dongen, 2026.
The license text is available at:

https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/LICENSE

MIT License

Copyright (c) 2026 Thomas van Dongen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

HomeGrep imports Semble as a pinned Python dependency; it does not copy or
modify Semble source. The bridge uses Semble's indexing, incremental index,
file discovery and content helpers, chunk and manifest types, model loading,
index persistence, and hybrid search APIs. It additionally reads internal
vector, BM25, manifest, and file-mapping structures to validate generations.
The JSON-lines bridge, content hashing, lock and generation checks, atomic
publication, and TypeScript integration are HomeGrep code. Semble's CLI, MCP
server, and installer are not used.

The license and notices for Semble's dependencies and the separately fetched
Potion-Code model are governed by their own distributions and are not replaced
by this notice.

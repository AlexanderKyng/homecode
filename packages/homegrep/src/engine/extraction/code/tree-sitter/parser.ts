import Parser from "web-tree-sitter";
import { performance } from "node:perf_hooks";
import { ensureParser, loadGrammar } from "./grammar.js";

export async function withParser<T>(
  source: string,
  format: string,
  fn: (tree: Parser.Tree) => T | Promise<T>,
  onParseDuration?: (durationMs: number) => void,
): Promise<T | null> {
  await ensureParser();

  const grammar = await loadGrammar(format);
  if (!grammar) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(grammar);

  let tree: Parser.Tree | null;
  const parseStartedAt = performance.now();

  try {
    tree = parser.parse(source);
  } catch {
    onParseDuration?.(performance.now() - parseStartedAt);
    parser.delete();
    return null;
  }
  onParseDuration?.(performance.now() - parseStartedAt);

  if (!tree) {
    parser.delete();
    return null;
  }

  try {
    return await fn(tree);
  } finally {
    tree.delete();
    parser.delete();
  }
}

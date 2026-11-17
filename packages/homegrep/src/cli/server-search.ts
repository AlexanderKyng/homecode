import { homeGrepSearchOutputSchema } from "../mcp/schemas.js";
import type { HomeGrepSearchResult } from "../mcp/tools.js";

export const INCOMPATIBLE_SERVER_SEARCH_MESSAGE =
  "The running HomeGrep server is incompatible with grouped CLI query output. Restart the currently configured daemon after upgrading HomeGrep, then retry.";

export function parseServerSearchResponse(
  value: unknown,
): HomeGrepSearchResult {
  const parsed = homeGrepSearchOutputSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.result.groupResults === undefined ||
    parsed.data.result.groupResults.length === 0
  ) {
    throw new Error(INCOMPATIBLE_SERVER_SEARCH_MESSAGE);
  }
  return parsed.data as unknown as HomeGrepSearchResult;
}

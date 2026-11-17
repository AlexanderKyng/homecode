import type {
  HomeGrepContextGroupResult,
  HomeGrepContextItem,
} from "./types.js";

const MAX_COVERAGE_GROUPS = 6;

function itemKey(item: HomeGrepContextItem): string {
  return (
    item.entityId ?? `${item.file.relativePath}:${JSON.stringify(item.range)}`
  );
}

/** Merge already-ranked Semble group outputs without changing their internal ranks. */
export function mergeQueryGroups(
  groups: HomeGrepContextGroupResult[],
  limit: number,
  fused: boolean,
): HomeGrepContextItem[] {
  const entries = new Map<
    string,
    {
      item: HomeGrepContextItem;
      score: number;
      firstRank: number;
      groupIndex: number;
    }
  >();
  for (const [groupIndex, group] of groups.entries()) {
    for (const item of group.items) {
      const key = itemKey(item);
      const prior = entries.get(key);
      const match = {
        id: group.id,
        query: group.query,
        role: group.role,
        rank: item.rank,
        matchedBy: item.matchedBy === "lexical" ? "fts" : item.matchedBy,
      };
      if (prior) {
        prior.score += 1 / (60 + item.rank);
        prior.item = {
          ...prior.item,
          queryGroups: [...(prior.item.queryGroups ?? []), match],
        };
      } else {
        entries.set(key, {
          item: { ...item, queryGroups: [match] },
          score: 1 / (60 + item.rank),
          firstRank: item.rank,
          groupIndex,
        });
      }
    }
  }

  if (fused) {
    return [...entries.values()]
      .sort((a, b) => b.score - a.score || a.firstRank - b.firstRank)
      .slice(0, Math.max(0, limit))
      .map(({ item }, index) => ({ ...item, rank: index + 1 }));
  }

  const ordered = [...entries.entries()];
  const selected = new Map<string, "coverage" | "global_fill">();
  for (const [groupIndex, group] of groups.entries()) {
    if (group.role !== "primary" || groupIndex >= MAX_COVERAGE_GROUPS) continue;
    const first = group.items.find((item) => !selected.has(itemKey(item)));
    if (first) selected.set(itemKey(first), "coverage");
  }
  const minimumCoverage = Math.min(groups.length, MAX_COVERAGE_GROUPS);
  const target = Math.max(Math.max(0, limit), minimumCoverage);
  for (const [key] of ordered) {
    if (selected.size >= target) break;
    if (!selected.has(key)) selected.set(key, "global_fill");
  }
  return [...selected.entries()].flatMap(([key, selectionReason], index) => {
    const entry = entries.get(key);
    if (!entry) return [];
    return [
      {
        ...entry.item,
        rank: index + 1,
        selectionReason,
        coverageGroup:
          selectionReason === "coverage"
            ? entry.item.queryGroups?.find((match) => match.role === "primary")
                ?.id
            : undefined,
      },
    ];
  });
}

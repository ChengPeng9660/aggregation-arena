// Bounded constraint search: provider totals and category totals must hold
// together. Filling providers independently can strand an otherwise valid slate.
export function selectStrictBalancedSlate(candidates, {
  categories, sourceQuotas, categoryTarget, sourceCategoryTarget, conflicts,
  blockedGroups = [], recentTitles = [], maxSearchNodes = 10000,
}) {
  const sources = Object.keys(sourceQuotas);
  const target = Object.values(sourceQuotas).reduce((sum, count) => sum + count, 0);
  const blocked = new Set(blockedGroups);
  const pool = candidates.filter((candidate) =>
    candidate.eligible && !candidate.alreadySelected &&
    categories.includes(candidate.category) && sources.includes(candidate.sourcePlatform || "polymarket") &&
    !blocked.has(candidate.diversityGroupId || candidate.sourceEventId) &&
    !recentTitles.some((title) => conflicts(title, candidate.title)),
  ).sort((a, b) => b.selectionScore - a.selectionScore || b.volume24h - a.volume24h || a.title.localeCompare(b.title));
  const conflictCache = new Map();
  const group = (index) => pool[index].diversityGroupId || pool[index].sourceEventId;
  const source = (index) => pool[index].sourcePlatform || "polymarket";
  const compatible = (left, right) => {
    if (group(left) === group(right)) return false;
    const key = Math.min(left, right) * pool.length + Math.max(left, right);
    if (!conflictCache.has(key)) conflictCache.set(key, !conflicts(pool[left].title, pool[right].title));
    return conflictCache.get(key);
  };
  const categoryCounts = Object.fromEntries(categories.map((category) => [category, 0]));
  const sourceCounts = Object.fromEntries(sources.map((name) => [name, 0]));
  const cells = Object.fromEntries(sources.map((name) => [name, Object.fromEntries(categories.map((category) => [category, 0]))]));
  const selected = [];
  let best = [];
  let nodes = 0;

  function search(available) {
    if (++nodes > maxSearchNodes) return null;
    if (selected.length > best.length) best = [...selected];
    if (selected.length === target) return [...selected];
    const valid = available.filter((index) => categoryCounts[pool[index].category] < categoryTarget && sourceCounts[source(index)] < sourceQuotas[source(index)]);
    const byCategory = new Map(categories.map((category) => [category, valid.filter((index) => pool[index].category === category)]));
    for (const category of categories) {
      if (new Set(byCategory.get(category).map(group)).size < categoryTarget - categoryCounts[category]) return null;
    }
    const sourcePressure = {};
    for (const name of sources) {
      const capacity = categories.reduce((sum, category) => sum + Math.min(
        categoryTarget - categoryCounts[category],
        new Set(byCategory.get(category).filter((index) => source(index) === name).map(group)).size,
      ), 0);
      if (capacity < sourceQuotas[name] - sourceCounts[name]) return null;
      sourcePressure[name] = (sourceQuotas[name] - sourceCounts[name]) / Math.max(1, capacity);
    }
    const category = categories.filter((name) => categoryCounts[name] < categoryTarget).sort((a, b) =>
      byCategory.get(a).length / (categoryTarget - categoryCounts[a]) - byCategory.get(b).length / (categoryTarget - categoryCounts[b]),
    )[0];
    const choices = [...byCategory.get(category)].sort((a, b) =>
      // Preserve scarce providers before balancing individual cells. A source
      // with only one available event in several categories may need all four
      // slots elsewhere. This changes branch order, never quota constraints.
      sourcePressure[source(b)] - sourcePressure[source(a)] ||
      Math.max(0, cells[source(a)][category] - sourceCategoryTarget + 1) - Math.max(0, cells[source(b)][category] - sourceCategoryTarget + 1) || a - b,
    );
    for (const index of choices) {
      if (nodes >= maxSearchNodes) break;
      const name = source(index);
      selected.push(index);
      categoryCounts[category] += 1;
      sourceCounts[name] += 1;
      cells[name][category] += 1;
      // Every feasible set has an increasing index order within each category.
      // Enforce it to avoid retrying permutations of the same selected set.
      const result = search(valid.filter((other) =>
        (pool[other].category !== category || other > index) && compatible(index, other),
      ));
      if (result) return result;
      selected.pop();
      categoryCounts[category] -= 1;
      sourceCounts[name] -= 1;
      cells[name][category] -= 1;
    }
    return null;
  }
  const chosen = search(pool.map((_, index) => index)) || best;
  const ranks = Object.fromEntries(categories.map((category) => [category, 0]));
  return chosen.map((index) => ({ ...pool[index], categoryRank: ++ranks[pool[index].category] }));
}

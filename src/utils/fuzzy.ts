/**
 * Fuzzy matching for the incremental quick-open searches (Ctrl+P and the
 * project switcher).
 *
 * A query matches when its characters appear in order in the target, which is
 * what makes "srpgit" find "src/stores/git.ts". Matches score higher when they
 * land on word boundaries or run consecutively, so the shortest, tightest and
 * best-placed match sorts first.
 */

export interface FuzzyMatch {
  score: number
  /** Indices in the target that the query matched, for highlighting. */
  positions: number[]
}

/** Characters that start a new word in a path or identifier. */
const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " ", ":"])
const CAMEL = /[A-Z]/

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true
  const previous = target[index - 1]
  if (SEPARATORS.has(previous)) return true
  // camelCase or PascalCase boundary: "gitStatus" -> S.
  return CAMEL.test(target[index]) && !CAMEL.test(previous)
}

/**
 * Score `query` against `target`, or return null when it does not match.
 *
 * Not all characters have to be matched exhaustively: a greedy left-to-right
 * pass is used, which is fast enough for tens of thousands of paths and gives
 * predictable ordering.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] }
  if (query.length > target.length) return null

  const lowerQuery = query.toLowerCase()
  const lowerTarget = target.toLowerCase()

  // Fast reject: every query character must exist in the target at all.
  let lastIndex = -1
  const positions: number[] = []
  let score = 0
  let run = 0

  for (let q = 0; q < lowerQuery.length; q++) {
    const char = lowerQuery[q]
    const found = lowerTarget.indexOf(char, lastIndex + 1)
    if (found === -1) return null

    if (found === lastIndex + 1) {
      run++
      score += 8 + run * 4
    } else {
      run = 0
      // Gaps cost, but a gap that crosses a separator costs less, because
      // matching across directories is expected in a path search.
      const gap = found - lastIndex - 1
      score -= Math.min(gap, 12)
      if (gap > 0 && SEPARATORS.has(target[found - 1])) score += 6
    }
    if (isBoundary(target, found)) score += 12
    // Prefer matches in the basename over ones buried in ancestor directories.
    const slash = target.lastIndexOf("/")
    if (slash !== -1 && found > slash) score += 4

    positions.push(found)
    lastIndex = found
  }

  // Shorter targets win when the match quality is otherwise equal.
  score -= Math.round(target.length / 8)
  return { score, positions }
}

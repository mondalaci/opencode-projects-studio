/**
 * Turn the URLs in plain text into links.
 *
 * A reader's own message is drawn verbatim — it never goes through the markdown
 * renderer a reply does — so a URL typed into a prompt came out as plain text,
 * and the same goes for the reasoning window. This escapes the text and wraps
 * the URLs GFM would autolink, so the prose still reads exactly as it was
 * written and its URLs are clickable.
 *
 * The exception is anything that is deliberately code: a fenced block, a tool
 * call's input and output, a file's contents. A URL there is part of what is
 * being shown, not a destination to offer, so those paths do not come here.
 */

/** The URL forms GFM autolinks: an explicit scheme, or the `www.` a reader knows. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi

/** Punctuation that closes *around* a URL rather than belonging to it. */
const TRAILING_PUNCTUATION = ".,;:!?\"'"

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character])
}

/**
 * Where a match stops being the URL and starts being the sentence around it.
 *
 * A regex cannot tell `(see http://x)` from `http://x_(y)`, so the trailing run
 * of punctuation is given back — except a bracket or a paren that the URL itself
 * opened, which is what a Wikipedia-style path ends with.
 */
function urlEnd(match: string): number {
  let end = match.length
  while (end > 0) {
    const last = match[end - 1]
    if (TRAILING_PUNCTUATION.includes(last)) {
      end--
      continue
    }
    if (last === ")" || last === "]") {
      const opener = last === ")" ? "(" : "["
      const body = match.slice(0, end)
      if (body.split(last).length > body.split(opener).length) {
        end--
        continue
      }
    }
    break
  }
  return end
}

/** The given plain text as HTML, with every URL in it a link. */
export function linkify(text: string): string {
  let html = ""
  let cursor = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const end = start + urlEnd(match[0])
    if (end === start) continue
    const url = text.slice(start, end)
    html += escapeHtml(text.slice(cursor, start))
    // The scheme a `www.` URL left implicit is the one the link needs.
    const href = url.startsWith("www.") ? `http://${url}` : url
    html += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`
    cursor = end
  }
  return html + escapeHtml(text.slice(cursor))
}

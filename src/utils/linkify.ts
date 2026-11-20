/**
 * The links the chat makes out of plain text.
 *
 * A reader's own message is drawn verbatim — it never goes through the markdown
 * renderer a reply does — so a URL typed into a prompt came out as plain text,
 * and the same went for the reasoning window. This escapes the text and wraps
 * the two things in it that are worth a click: a URL, which GFM autolinks, and a
 * `Message-ID:` header, which is not a URL at all but is read like one here.
 *
 * The exception is anything that is deliberately code: a fenced block, a tool
 * call's input and output, a file's contents. A URL or an id there is part of
 * what is being shown, not a destination to offer, so those paths do not come
 * here.
 */

/** The Gmail account a Message-ID opens in. */
const GMAIL_ACCOUNT = 0

/**
 * A mail header's identifier: the `Message-ID:` label together with the
 * `id@domain` it carries in angle brackets.
 *
 * The label is what tells an identifier from an address that merely stands in
 * brackets — `<laci@monda.hu>` is a person, not a message — so it is part of what
 * is matched, and part of the link: what a reader takes out of the chat is the
 * header as it was written.
 */
export const MESSAGE_ID_HEADER = /Message-ID:[ \t]*<([^<>\s]+@[^<>\s]+)>/i

/**
 * What becomes a link: a URL — the forms GFM autolinks, an explicit scheme or
 * the `www.` a reader knows — or a Message-ID header, whose own pattern is
 * reused here so the two cannot drift apart.
 */
const TOKEN_PATTERN = new RegExp(
  `(?<url>\\b(?:https?://|www\\.)[^\\s<>]+)|(?<header>${MESSAGE_ID_HEADER.source})`,
  "gi",
)

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

/**
 * A Message-ID header as the link that reads it.
 *
 * The identifier is the one Gmail indexes a mail under, so the link is a search
 * for it, and `in:anywhere` reaches an archived thread as well — the same query,
 * in the same shape, that the Gmail extension falls back to when a notification
 * has no thread copy to open. The angle brackets belong to the header's syntax
 * rather than to the identifier, so the search drops them while the link keeps
 * the header reading as it was written.
 */
export function messageIdLink(header: string): string {
  const id = MESSAGE_ID_HEADER.exec(header)?.[1]
  if (!id) return escapeHtml(header)
  const search = encodeURIComponent(`rfc822msgid:${id} in:anywhere`)
  const href = `https://mail.google.com/mail/u/${GMAIL_ACCOUNT}/#search/${search}`
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(header)}</a>`
}

/** A URL as the link that reads it: the `www.` form gets the scheme it left implicit. */
function urlLink(url: string): string {
  const href = url.startsWith("www.") ? `http://${url}` : url
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`
}

/** The given plain text as HTML, with every URL and Message-ID in it a link. */
export function linkify(text: string): string {
  let html = ""
  let cursor = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0
    const { url, header } = match.groups ?? {}
    // `end` is where the link stops: a header runs to its closing bracket, a URL
    // to its last character, with the sentence's punctuation left outside it.
    const end = header ? start + header.length : url ? start + urlEnd(url) : start
    if (end === start) continue
    const target = text.slice(start, end)
    html += escapeHtml(text.slice(cursor, start))
    html += header ? messageIdLink(header) : urlLink(target)
    cursor = end
  }
  return html + escapeHtml(text.slice(cursor))
}

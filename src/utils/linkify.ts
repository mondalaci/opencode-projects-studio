/**
 * The links the chat makes out of plain text.
 *
 * A reader's own message is drawn verbatim — it never goes through the markdown
 * renderer a reply does — so a URL typed into a prompt came out as plain text,
 * and the same went for the reasoning window. This escapes the text and wraps
 * the three identifiers in it that are worth a click: a URL, which GFM
 * autolinks; a `Message-ID:` header, which is not a URL at all but is read like
 * one here; and a session id, which opens the conversation it names.
 *
 * The exception is anything that is deliberately code: a fenced block, a tool
 * call's input and output, a file's contents. An identifier there is part of what
 * is being shown, not a destination to offer, so those paths do not come here.
 */

/** The Gmail account a Message-ID opens in. */
const GMAIL_ACCOUNT = 0

/** The browser chat a session id opens in. */
const WEB_CHAT_ORIGIN = "http://chat.localhost"

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
 * A session id: the `ses_` opencode prefixes an identifier with, and the
 * alphanumeric run behind it. The run is 26 characters in the ids written now
 * and 32 in the older ones; the floor is only there so that the bare word `ses_`
 * cannot be one.
 */
export const SESSION_ID = /\bses_[A-Za-z0-9]{16,}/

/**
 * What becomes a link: a URL — the forms GFM autolinks, an explicit scheme or
 * the `www.` a reader knows — a Message-ID header, or a session id. Each carries
 * its own pattern, so the three cannot drift apart from the ones the marker on a
 * reply is built out of.
 */
const TOKEN_PATTERN = new RegExp(
  [
    `(?<url>\\b(?:https?://|www\\.)[^\\s<>]+)`,
    `(?<header>${MESSAGE_ID_HEADER.source})`,
    `(?<session>${SESSION_ID.source})`,
  ].join("|"),
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

/**
 * A session id as the link that opens it.
 *
 * A conversation belongs to the server rather than to either client, so there is
 * no page in the app's own tree to point at — but this machine serves the
 * browser chat on a hostname of its own, and a session id opens there. The link
 * is absolute for that reason and for the next one: the studio sends an external
 * link to the OS browser, so pointing at a conversation does not throw away the
 * one on screen.
 */
export function sessionLink(sessionId: string): string {
  const href = `${WEB_CHAT_ORIGIN}/?session=${encodeURIComponent(sessionId)}`
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(sessionId)}</a>`
}

/** The given plain text as HTML, with every identifier in it a link. */
export function linkify(text: string): string {
  let html = ""
  let cursor = 0
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0
    const { url, header, session } = match.groups ?? {}
    // Where the link stops: a URL gives back the sentence's punctuation, while
    // the two identifiers are exactly as long as they are written.
    const end = start + (header?.length ?? session?.length ?? (url ? urlEnd(url) : 0))
    if (end === start) continue
    const target = text.slice(start, end)
    const anchor = header ? messageIdLink(header) : session ? sessionLink(session) : urlLink(target)
    html += escapeHtml(text.slice(cursor, start)) + anchor
    cursor = end
  }
  return html + escapeHtml(text.slice(cursor))
}

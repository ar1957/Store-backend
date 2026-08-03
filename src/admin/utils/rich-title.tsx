import * as React from "react"

/**
 * Product/item names can carry manual formatting two ways:
 *  - Raw HTML (e.g. "<br>", "<b>", styled <span>s) for full control, at the
 *    cost of showing literal tags in surfaces we don't control (e.g.
 *    Medusa's own core order/product admin screens).
 *  - A "|" marker for a plain, safe line break — no HTML injection surface,
 *    and degrades to a readable inline separator anywhere it isn't rendered.
 */

function isHtml(str: string): boolean {
  return str.includes("<")
}

// dangerouslySetInnerHTML props for a name containing raw HTML, or null if it doesn't.
export function getRichTitleHtmlProps(
  text?: string | null
): { dangerouslySetInnerHTML: { __html: string } } | null {
  if (!text || !isHtml(text)) return null
  return { dangerouslySetInnerHTML: { __html: text } }
}

// React children for a name with no raw HTML — splits "|" into real <br/> line breaks.
export function getRichTitleChildren(text?: string | null): React.ReactNode {
  if (!text) return text
  if (!text.includes("|")) return text
  return text.split("|").map((part, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {part.trim()}
    </React.Fragment>
  ))
}

import MarkdownIt from "markdown-it";
import { full as emoji } from "markdown-it-emoji";

/**
 * Host-side Markdown for decrypted messages. Never send private text to GitHub's /markdown API.
 * Raw HTML is disabled and images become links, so rendering a message can't fetch anything
 * (no tracking pixels); the webview sanitizes the result again.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
md.use(emoji as unknown as Parameters<typeof md.use>[0]);

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet("src") ?? "");
  const alt = token.content || "image";
  return `<a href="${md.utils.escapeHtml(src)}">🖼 ${md.utils.escapeHtml(alt)}</a>`;
};

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const MENTION = /(^|[^\w`/])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b/g;

export function renderMarkdown(text: string): string {
  const html = md.render(text);
  // Highlight @mentions outside code (cheap: skip <code> blocks).
  return html
    .split(/(<code>[\s\S]*?<\/code>|<pre>[\s\S]*?<\/pre>)/)
    .map((part) => (part.startsWith("<code>") || part.startsWith("<pre>") ? part : part.replace(MENTION, '$1<span class="mention">@$2</span>')))
    .join("");
}

/** Strips the encrypted-message footer GitHub shows to everyone when a comment can't be read. */
export function undecryptableHtml(reason: string): string {
  return `<p class="muted">🔒 ${md.utils.escapeHtml(reason)}</p>`;
}

/** Messages between the chat host (extension) and its webview renderer. The host owns all state. */

export type Privacy = "private" | "public";

export interface ChannelView {
  id: string;
  number: number;
  title: string;
  privacy: Privacy;
  unread: number;
  url: string;
  /** Privacy marker edited by someone without write access: treated as private. */
  privacyWarning?: string;
}

/**
 * verified: decrypted and signed by a known device. unencrypted: plain text in a private channel
 * (visible to everyone). plain: ordinary comment in a public channel. undecryptable: no key (yet).
 * invalid: signature/authentication failed or replayed. pending/failed: local echo.
 */
export type MessageStatus = "verified" | "unencrypted" | "plain" | "undecryptable" | "invalid" | "pending" | "failed";

export interface ReactionView {
  content: string;
  emoji: string;
  count: number;
  viewerHasReacted: boolean;
}

export interface MessageView {
  id: string;
  localId?: string;
  author: { login: string; avatarUrl?: string };
  createdAt: string;
  /** HTML to show (sanitized again in the webview). */
  html: string;
  status: MessageStatus;
  statusDetail?: string;
  edited: boolean;
  /** Login of someone other than the author who edited the comment. */
  modifiedBy?: string;
  reactions: ReactionView[];
  canEdit: boolean;
  canDelete: boolean;
  /** Markdown source for editing (own messages only). */
  editableText?: string;
  url?: string;
  replies: MessageView[];
}

export interface EncryptionInfo {
  /** ready: can send encrypted. waiting: device registered, waiting for a key grant. noKey: not set up. notMember: no write access. */
  status: "ready" | "waiting" | "noKey" | "notMember" | "unavailable";
  recipients: number;
  devices: number;
  fingerprint?: string;
  /** Key holders lost write access: the key should be rotated. */
  rotateNeeded?: string[];
}

export interface ChatState {
  signedIn: boolean;
  setup: "ready" | "noDiscussions" | "noCategory" | "noChannels" | "loading";
  viewer?: string;
  canWrite: boolean;
  canMaintain: boolean;
  isAdmin: boolean;
  channels: ChannelView[];
  activeChannel?: string;
  messages: MessageView[];
  hasOlder: boolean;
  loading: boolean;
  encryption: EncryptionInfo;
  ccDefault: boolean;
  error?: string;
}

export type HostToWebview = { type: "state"; state: ChatState } | { type: "focusComposer" };

export type WebviewCommand = "newChannel" | "setPrivacy" | "manageDevices" | "rotateKey" | "openOnGitHub" | "signIn" | "setup" | "refresh";

export type WebviewToHost =
  | { type: "ready" }
  | { type: "selectChannel"; channelId: string }
  | { type: "send"; text: string; replyTo?: string; notify: boolean; localId: string }
  | { type: "retry"; localId: string }
  | { type: "loadOlder" }
  | { type: "react"; commentId: string; content: string; remove: boolean }
  | { type: "edit"; commentId: string; text: string }
  | { type: "delete"; commentId: string }
  | { type: "openLink"; href: string }
  | { type: "command"; command: WebviewCommand }
  | { type: "markRead" };

export const REACTIONS: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

const COMMANDS: WebviewCommand[] = ["newChannel", "setPrivacy", "manageDevices", "rotateKey", "openOnGitHub", "signIn", "setup", "refresh"];
const str = (x: unknown, max = 100_000): x is string => typeof x === "string" && x.length <= max;

/** Validates untrusted webview input before the host acts on it. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "loadOlder":
    case "markRead":
      return { type: m.type };
    case "selectChannel":
      return str(m.channelId, 200) ? { type: "selectChannel", channelId: m.channelId } : undefined;
    case "send":
      return str(m.text, 60_000) && str(m.localId, 100) && (m.replyTo === undefined || str(m.replyTo, 200))
        ? { type: "send", text: m.text, localId: m.localId, replyTo: m.replyTo as string | undefined, notify: m.notify === true }
        : undefined;
    case "retry":
      return str(m.localId, 100) ? { type: "retry", localId: m.localId } : undefined;
    case "react":
      return str(m.commentId, 200) && str(m.content, 40) && m.content in REACTIONS ? { type: "react", commentId: m.commentId, content: m.content, remove: m.remove === true } : undefined;
    case "edit":
      return str(m.commentId, 200) && str(m.text, 60_000) ? { type: "edit", commentId: m.commentId, text: m.text } : undefined;
    case "delete":
      return str(m.commentId, 200) ? { type: "delete", commentId: m.commentId } : undefined;
    case "openLink":
      return str(m.href, 4000) ? { type: "openLink", href: m.href } : undefined;
    case "command":
      return COMMANDS.includes(m.command as WebviewCommand) ? { type: "command", command: m.command as WebviewCommand } : undefined;
    default:
      return undefined;
  }
}

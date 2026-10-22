import type { GitHubClient } from "../github/client";
import type { KeyComment, Permission } from "./keystate";

export interface DiscussionCategory {
  id: string;
  name: string;
  slug: string;
}

export interface DiscussionSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  locked: boolean;
  author: string;
  editor?: string;
  lastEditedAt?: string | null;
  updatedAt: string;
  commentCount: number;
}

export interface ReactionGroup {
  content: string;
  viewerHasReacted: boolean;
  count: number;
}

export interface CommentNode {
  id: string;
  databaseId: number;
  url: string;
  author: { login: string; avatarUrl?: string };
  authorAssociation: string;
  body: string;
  bodyHTML: string;
  createdAt: string;
  lastEditedAt?: string | null;
  editor?: string;
  isMinimized: boolean;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  reactions: ReactionGroup[];
  replyToId?: string;
  replies: CommentNode[];
}

export interface CommentPage {
  comments: CommentNode[];
  /** Cursor for loading older comments (null when at the start). */
  olderCursor: string | null;
  totalCount: number;
}

const COMMENT_FIELDS = `
  id databaseId url
  author { login avatarUrl(size: 64) }
  authorAssociation body bodyHTML createdAt lastEditedAt
  editor { login }
  isMinimized viewerCanUpdate viewerCanDelete
  reactionGroups { content viewerHasReacted reactors { totalCount } }
  replyTo { id }
`;

const DISCUSSION_FIELDS = `
  id number title url body locked updatedAt lastEditedAt
  author { login }
  editor { login }
  comments { totalCount }
`;

function toComment(n: any): CommentNode {
  return {
    id: n.id,
    databaseId: n.databaseId,
    url: n.url,
    author: { login: n.author?.login ?? "ghost", avatarUrl: n.author?.avatarUrl },
    authorAssociation: n.authorAssociation,
    body: n.body ?? "",
    bodyHTML: n.bodyHTML ?? "",
    createdAt: n.createdAt,
    lastEditedAt: n.lastEditedAt,
    editor: n.editor?.login,
    isMinimized: Boolean(n.isMinimized),
    viewerCanUpdate: Boolean(n.viewerCanUpdate),
    viewerCanDelete: Boolean(n.viewerCanDelete),
    reactions: (n.reactionGroups ?? [])
      .map((g: any) => ({ content: g.content, viewerHasReacted: Boolean(g.viewerHasReacted), count: g.reactors?.totalCount ?? 0 }))
      .filter((g: ReactionGroup) => g.count > 0),
    replyToId: n.replyTo?.id,
    replies: (n.replies?.nodes ?? []).map(toComment),
  };
}

function toDiscussion(n: any): DiscussionSummary {
  return {
    id: n.id,
    number: n.number,
    title: n.title,
    url: n.url,
    body: n.body ?? "",
    locked: Boolean(n.locked),
    author: n.author?.login ?? "ghost",
    editor: n.editor?.login,
    lastEditedAt: n.lastEditedAt,
    updatedAt: n.updatedAt,
    commentCount: n.comments?.totalCount ?? 0,
  };
}

const PERMISSION_TTL_MS = 15 * 60_000;

/** GraphQL access to Discussions (there's no REST API for repository discussions). */
export class DiscussionsApi {
  private readonly permissions = new Map<string, { value: Permission; at: number }>();

  constructor(readonly client: GitHubClient) {}

  private get repo() {
    return this.client.repo;
  }

  async categories(): Promise<DiscussionCategory[]> {
    const r = await this.client.graphql<any>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussionCategories(first: 25) { nodes { id name slug } } } }`,
      { owner: this.repo.owner, name: this.repo.name },
    );
    return r.repository.discussionCategories.nodes;
  }

  async discussions(categoryId: string): Promise<DiscussionSummary[]> {
    const r = await this.client.graphql<any>(
      `query($owner: String!, $name: String!, $cat: ID!) { repository(owner: $owner, name: $name) {
        discussions(first: 50, categoryId: $cat, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ${DISCUSSION_FIELDS} } } } }`,
      { owner: this.repo.owner, name: this.repo.name, cat: categoryId },
    );
    return r.repository.discussions.nodes.map(toDiscussion);
  }

  async discussionByNumber(number: number): Promise<DiscussionSummary | undefined> {
    const r = await this.client.graphql<any>(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { discussion(number: $n) { ${DISCUSSION_FIELDS} } } }`,
      { owner: this.repo.owner, name: this.repo.name, n: number },
    );
    return r.repository.discussion ? toDiscussion(r.repository.discussion) : undefined;
  }

  /** ~1 point: what changed since last time, for many channels at once. */
  async heads(ids: string[]): Promise<Map<string, { updatedAt: string; commentCount: number }>> {
    const out = new Map<string, { updatedAt: string; commentCount: number }>();
    if (!ids.length) return out;
    const r = await this.client.graphql<any>(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Discussion { id updatedAt comments { totalCount } } } }`, { ids });
    for (const n of r.nodes ?? []) if (n?.id) out.set(n.id, { updatedAt: n.updatedAt, commentCount: n.comments.totalCount });
    return out;
  }

  /** The newest comments (with up to 20 replies each), or older ones before `before`. */
  async comments(discussionId: string, before?: string | null): Promise<CommentPage> {
    const r = await this.client.graphql<any>(
      `query($id: ID!, $before: String) { node(id: $id) { ... on Discussion {
        comments(last: 30, before: $before) {
          totalCount
          pageInfo { hasPreviousPage startCursor }
          nodes { ${COMMENT_FIELDS} replies(last: 20) { nodes { ${COMMENT_FIELDS} } } }
        } } } }`,
      { id: discussionId, before: before ?? null },
    );
    const c = r.node.comments;
    return { comments: c.nodes.map(toComment), olderCursor: c.pageInfo.hasPreviousPage ? c.pageInfo.startCursor : null, totalCount: c.totalCount };
  }

  /** Key-directory comments after `cursor`, oldest first (records are processed in order). */
  async keyComments(discussionId: string): Promise<KeyComment[]> {
    const comments: KeyComment[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: any = await this.client.graphql<any>(
        `query($id: ID!, $after: String) { node(id: $id) { ... on Discussion {
          comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id databaseId createdAt lastEditedAt body author { login } } } } } }`,
        { id: discussionId, after: cursor },
      );
      const c: any = r.node.comments;
      for (const n of c.nodes) comments.push({ id: n.id, databaseId: n.databaseId, createdAt: n.createdAt, lastEditedAt: n.lastEditedAt, author: n.author?.login ?? "ghost", body: n.body ?? "" });
      if (c.pageInfo.endCursor) cursor = c.pageInfo.endCursor;
      if (!c.pageInfo.hasNextPage) break;
    }
    return comments;
  }

  async addComment(discussionId: string, body: string, replyToId?: string): Promise<CommentNode> {
    const r = await this.client.graphql<any>(
      `mutation($id: ID!, $body: String!, $reply: ID) { addDiscussionComment(input: { discussionId: $id, body: $body, replyToId: $reply }) { comment { ${COMMENT_FIELDS} } } }`,
      { id: discussionId, body, reply: replyToId ?? null },
    );
    return toComment(r.addDiscussionComment.comment);
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.client.graphql(`mutation($id: ID!, $body: String!) { updateDiscussionComment(input: { commentId: $id, body: $body }) { comment { id } } }`, { id: commentId, body });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.client.graphql(`mutation($id: ID!) { deleteDiscussionComment(input: { id: $id }) { comment { id } } }`, { id: commentId });
  }

  async react(subjectId: string, content: string, remove: boolean): Promise<void> {
    const op = remove ? "removeReaction" : "addReaction";
    await this.client.graphql(`mutation($id: ID!, $c: ReactionContent!) { ${op}(input: { subjectId: $id, content: $c }) { clientMutationId } }`, { id: subjectId, c: content });
  }

  async createDiscussion(categoryId: string, title: string, body: string): Promise<DiscussionSummary> {
    const r = await this.client.graphql<any>(
      `mutation($repo: ID!, $cat: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repo, categoryId: $cat, title: $title, body: $body }) { discussion { ${DISCUSSION_FIELDS} } } }`,
      { repo: this.repo.nodeId, cat: categoryId, title, body },
    );
    return toDiscussion(r.createDiscussion.discussion);
  }

  async lock(discussionId: string): Promise<void> {
    await this.client.graphql(`mutation($id: ID!) { lockLockable(input: { lockableId: $id }) { clientMutationId } }`, { id: discussionId });
  }

  async updateDiscussionBody(discussionId: string, body: string): Promise<void> {
    await this.client.graphql(`mutation($id: ID!, $body: String!) { updateDiscussion(input: { discussionId: $id, body: $body }) { discussion { id } } }`, { id: discussionId, body });
  }

  /** Mutes GitHub's notification emails for a channel (the extension notifies instead). */
  async setSubscribed(subscribableId: string, subscribed: boolean): Promise<void> {
    await this.client.graphql(`mutation($id: ID!, $state: SubscriptionState!) { updateSubscription(input: { subscribableId: $id, state: $state }) { clientMutationId } }`, {
      id: subscribableId,
      state: subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
    });
  }

  /**
   * A user's current repository permission (cached 15 min). Readers can't call this endpoint, so
   * they fall back to "write" for members (unverified; the server still enforces locks).
   */
  async permission(login: string): Promise<Permission> {
    const key = login.toLowerCase();
    const hit = this.permissions.get(key);
    if (hit && Date.now() - hit.at < PERMISSION_TTL_MS) return hit.value;
    let value: Permission;
    try {
      const { data } = await this.client.rest.repos.getCollaboratorPermissionLevel({ ...this.client.params, username: login });
      const role = (data as { role_name?: string }).role_name;
      value = role === "maintain" ? "maintain" : role === "triage" ? "triage" : ((data.permission as Permission) ?? "none");
    } catch (e) {
      const status = (e as { status?: number }).status;
      value = status === 404 ? "none" : status === 403 ? "write" : "none";
    }
    this.permissions.set(key, { value, at: Date.now() });
    return value;
  }

  invalidatePermissions(): void {
    this.permissions.clear();
  }
}

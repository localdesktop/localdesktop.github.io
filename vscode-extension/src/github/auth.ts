import * as vscode from "vscode";

/** `repo` covers dispatch, artifacts, labels, PRs, Discussions and repository webhooks. */
export const GITHUB_SCOPES = ["repo"];
const PAT_KEY = "localdesktop.github.pat";

export interface AuthSession {
  token: string;
  /** Login from the VS Code session; PAT logins are resolved by the client. */
  login?: string;
  source: "vscode" | "pat";
}

/**
 * GitHub credentials: the editor's built-in GitHub account, or a PAT kept in SecretStorage for
 * editors without the GitHub auth provider (VSCodium, some forks).
 */
export class GitHubAuth implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private cached: AuthSession | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subs.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") this.invalidate();
      }),
      context.secrets.onDidChange((e) => {
        if (e.key === PAT_KEY) this.invalidate();
      }),
    );
  }

  private invalidate(): void {
    this.cached = undefined;
    this.changed.fire();
  }

  /** Returns the current session without prompting (undefined when signed out). */
  async current(): Promise<AuthSession | undefined> {
    if (this.cached) return this.cached;
    const pat = await this.context.secrets.get(PAT_KEY);
    if (pat) return (this.cached = { token: pat, source: "pat" });
    try {
      const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { silent: true });
      if (s) return (this.cached = { token: s.accessToken, login: s.account.label, source: "vscode" });
    } catch {
      // no GitHub auth provider in this editor
    }
    return undefined;
  }

  /** Prompts to sign in with the editor's GitHub account. */
  async signIn(): Promise<AuthSession | undefined> {
    try {
      const s = await vscode.authentication.getSession("github", GITHUB_SCOPES, { createIfNone: true });
      this.cached = { token: s.accessToken, login: s.account.label, source: "vscode" };
      this.changed.fire();
      return this.cached;
    } catch (e) {
      const choice = await vscode.window.showWarningMessage(
        `GitHub sign-in isn't available here (${e instanceof Error ? e.message : String(e)}). Use a personal access token instead?`,
        "Use Token",
      );
      return choice ? this.signInWithToken() : undefined;
    }
  }

  async signInWithToken(): Promise<AuthSession | undefined> {
    const token = await vscode.window.showInputBox({
      title: "GitHub personal access token",
      prompt: "Classic token with the `repo` scope (or a fine-grained token with Actions, Contents, Discussions, Issues, Pull requests and Webhooks access).",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 20 ? "That doesn't look like a token" : undefined),
    });
    if (!token) return undefined;
    await this.context.secrets.store(PAT_KEY, token.trim());
    this.cached = { token: token.trim(), source: "pat" };
    this.changed.fire();
    return this.cached;
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(PAT_KEY);
    this.invalidate();
    void vscode.window.showInformationMessage("Forgot the stored GitHub token. To sign out of the editor's GitHub account, use the Accounts menu.");
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

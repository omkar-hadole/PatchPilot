export interface GitHubClientOptions {
  token: string;
  apiBaseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
}

export interface GitHubIssueComment {
  id: number;
  html_url: string;
}

export interface GitHubContentFile {
  path: string;
  sha: string;
  encoding: string;
  content: string;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

export interface GitHubCommit {
  sha: string;
  tree: { sha: string };
}

export interface GitHubTree {
  sha: string;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
}

export interface GitHubCollaboratorPermission {
  permission: string;
}

export class GitHubRestClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? "Byter/0.1.0";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}`);
  }

  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<GitHubContentFile> {
    const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<GitHubContentFile>(
      `${repoBasePath(owner, repo)}/contents/${encodeRepositoryPath(path)}${params}`
    );
  }

  async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels })
    });
  }

  async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
    await this.request(
      `${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}/labels/${encodeURIComponent(expectNonEmpty(label, "label name"))}`,
      { method: "DELETE" }
    );
  }

  async createLabel(owner: string, repo: string, name: string, color: string, description: string): Promise<void> {
    if (!/^[0-9a-f]{6}$/i.test(color)) {
      throw new Error("Invalid GitHub label color");
    }

    await this.request(`${repoBasePath(owner, repo)}/labels`, {
      method: "POST",
      body: JSON.stringify({
        name: expectNonEmpty(name, "label name"),
        color,
        description
      })
    });
  }

  async updateLabel(owner: string, repo: string, name: string, color: string, description: string): Promise<void> {
    if (!/^[0-9a-f]{6}$/i.test(color)) {
      throw new Error("Invalid GitHub label color");
    }

    await this.request(`${repoBasePath(owner, repo)}/labels/${encodeURIComponent(expectNonEmpty(name, "label name"))}`, {
      method: "PATCH",
      body: JSON.stringify({ color, description })
    });
  }

  async getCollaboratorPermission(owner: string, repo: string, username: string): Promise<GitHubCollaboratorPermission> {
    return this.request<GitHubCollaboratorPermission>(
      `${repoBasePath(owner, repo)}/collaborators/${encodeURIComponent(expectNonEmpty(username, "GitHub username"))}/permission`
    );
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<GitHubIssueComment> {
    return this.request<GitHubIssueComment>(`${repoBasePath(owner, repo)}/issues/${validateIssueNumber(issueNumber)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GitHubIssueComment> {
    if (!Number.isInteger(commentId) || commentId < 1) {
      throw new Error("Invalid GitHub issue comment id");
    }

    return this.request<GitHubIssueComment>(`${repoBasePath(owner, repo)}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body })
    });
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch> {
    return this.request<GitHubBranch>(`${repoBasePath(owner, repo)}/branches/${encodeURIComponent(validateBranchName(branch))}`);
  }

  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.request(`${repoBasePath(owner, repo)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${validateBranchName(branch)}`,
        sha: validateSha(sha)
      })
    });
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.request(`${repoBasePath(owner, repo)}/git/refs/heads/${encodeBranchPath(branch)}`, {
      method: "DELETE"
    });
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(`${repoBasePath(owner, repo)}/git/commits/${validateSha(sha)}`);
  }

  async createTree(
    owner: string,
    repo: string,
    input: {
      baseTree: string;
      files: Array<{ path: string; content: string }>;
    }
  ): Promise<GitHubTree> {
    return this.request<GitHubTree>(`${repoBasePath(owner, repo)}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: validateSha(input.baseTree),
        tree: input.files.map((file) => ({
          path: validateRepositoryPath(file.path),
          mode: "100644",
          type: "blob",
          content: file.content
        }))
      })
    });
  }

  async createCommit(
    owner: string,
    repo: string,
    input: {
      message: string;
      tree: string;
      parents: string[];
    }
  ): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(`${repoBasePath(owner, repo)}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: expectNonEmpty(input.message, "commit message"),
        tree: validateSha(input.tree),
        parents: input.parents.map(validateSha)
      })
    });
  }

  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    input: {
      branch: string;
      message: string;
      content: string;
      sha?: string;
    }
  ): Promise<void> {
    await this.request(`${repoBasePath(owner, repo)}/contents/${encodeRepositoryPath(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        branch: validateBranchName(input.branch),
        message: expectNonEmpty(input.message, "commit message"),
        content: Buffer.from(input.content, "utf8").toString("base64"),
        ...(input.sha ? { sha: validateSha(input.sha) } : {})
      })
    });
  }

  async createPullRequest(
    owner: string,
    repo: string,
    input: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft?: boolean;
    }
  ): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(`${repoBasePath(owner, repo)}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: expectNonEmpty(input.title, "pull request title"),
        body: input.body,
        head: validateBranchName(input.head),
        base: validateBranchName(input.base),
        draft: input.draft ?? true
      })
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${response.status} ${response.statusText}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function repoBasePath(owner: string, repo: string): string {
  return `/repos/${encodeOwner(owner)}/${encodeRepo(repo)}`;
}

function encodeOwner(owner: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Invalid GitHub owner");
  }

  return encodeURIComponent(owner);
}

function encodeRepo(repo: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw new Error("Invalid GitHub repository name");
  }

  return encodeURIComponent(repo);
}

function validateIssueNumber(issueNumber: number): number {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Invalid GitHub issue number");
  }

  return issueNumber;
}

function validateBranchName(branch: string): string {
  if (
    branch.length === 0 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("\\") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error("Invalid GitHub branch name");
  }

  return branch;
}

function encodeBranchPath(branch: string): string {
  return validateBranchName(branch).split("/").map(encodeURIComponent).join("/");
}

function validateSha(sha: string): string {
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("Invalid Git commit sha");
  }

  return sha;
}

function encodeRepositoryPath(path: string): string {
  return validateRepositoryPath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function validateRepositoryPath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
    throw new Error("Invalid GitHub repository path");
  }

  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("Invalid GitHub repository path");
    }
  }

  return path;
}

function expectNonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

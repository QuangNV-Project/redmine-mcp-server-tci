import type { AxiosInstance } from "axios";
import axios from "axios";

export interface RedmineIssue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  subject: string;
  description: string;
  start_date?: string;
  due_date?: string;
  done_ratio: number;
  created_on: string;
  updated_on: string;
  journals?: RedmineJournal[];
  children?: { id: number; subject: string }[];
  parent?: { id: number };
}

export interface RedmineJournal {
  id: number;
  user: { id: number; name: string };
  notes: string;
  created_on: string;
  details: Array<{
    property: string;
    name: string;
    old_value?: string;
    new_value?: string;
  }>;
}

export interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
  description: string;
  status: number;
  created_on: string;
  updated_on: string;
}

export interface IssueListParams {
  project_id?: string;
  status_id?: string | "open" | "closed" | "*";
  assigned_to_id?: string | "me";
  tracker_id?: number;
  limit?: number;
  offset?: number;
  sort?: string;
}

type CredentialProvider = (sessionId?: string) => { username: string; password: string };

export class RedmineClient {
  private client: AxiosInstance;
  private credentialProvider?: CredentialProvider;
  private sessionId?: string;

  constructor(
    baseUrl: string,
    usernameOrProvider: string | CredentialProvider,
    password?: string
  ) {
    // Support both static credentials and credential provider function
    let finalUsername: string;
    let finalPassword: string;

    if (typeof usernameOrProvider === "function") {
      this.credentialProvider = usernameOrProvider;
      const creds = this.credentialProvider();
      finalUsername = creds.username;
      finalPassword = creds.password;
    } else {
      finalUsername = usernameOrProvider;
      finalPassword = password || "";
    }

    this.client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ""),
      auth: { username: finalUsername, password: finalPassword },
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Set session ID for credential provider to use
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    if (this.credentialProvider) {
      const creds = this.credentialProvider(sessionId);
      this.client.defaults.auth = { username: creds.username, password: creds.password };
    }
  }

  async getIssue(issueId: number, includeJournals = true): Promise<RedmineIssue> {
    const include = includeJournals ? "journals,children,attachments" : "";
    const params = include ? { include } : {};
    const res = await this.client.get(`/issues/${issueId}.json`, { params });
    return res.data.issue;
  }

  async listIssues(
    params: IssueListParams
  ): Promise<{ issues: RedmineIssue[]; total_count: number }> {
    const res = await this.client.get("/issues.json", {
      params: {
        ...params,
        limit: params.limit || 25,
      },
    });
    return res.data;
  }

  async getProject(projectId: string): Promise<RedmineProject> {
    const res = await this.client.get(`/projects/${projectId}.json`);
    return res.data.project;
  }

  async listProjects(): Promise<RedmineProject[]> {
    const res = await this.client.get("/projects.json", {
      params: { limit: 100 },
    });
    return res.data.projects;
  }

  async updateIssueStatus(issueId: number, statusId: number, notes?: string): Promise<void> {
    await this.client.put(`/issues/${issueId}.json`, {
      issue: {
        status_id: statusId,
        ...(notes ? { notes } : {}),
      },
    });
  }

  async addComment(issueId: number, notes: string): Promise<void> {
    await this.client.put(`/issues/${issueId}.json`, {
      issue: { notes },
    });
  }

  async getIssueStatuses(): Promise<Array<{ id: number; name: string; is_closed: boolean }>> {
    const res = await this.client.get("/issue_statuses.json");
    return res.data.issue_statuses;
  }
}

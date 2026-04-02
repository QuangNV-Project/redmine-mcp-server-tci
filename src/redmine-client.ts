import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from "axios";
import axios from "axios";
import { load } from "cheerio";
import { logger } from "./logger.js";

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

export interface RedmineAuthCredentials {
  redmineCookie?: string;
}

type CredentialProvider = (sessionId?: string) => RedmineAuthCredentials;
type TraceableRequestConfig = InternalAxiosRequestConfig & {
  __traceMeta?: {
    startedAt: number;
  };
};

export class RedmineClient {
  private client: AxiosInstance;
  private credentialProvider?: CredentialProvider;
  private sessionId?: string;
  private redmineCookie?: string;

  constructor(
    baseUrl: string,
    credentialsOrProvider: CredentialProvider | RedmineAuthCredentials
  ) {
    let creds: RedmineAuthCredentials;

    if (typeof credentialsOrProvider === "function") {
      this.credentialProvider = credentialsOrProvider;
      creds = this.credentialProvider();
    } else {
      creds = credentialsOrProvider;
    }

    this.redmineCookie = this.normalizeCookie(creds.redmineCookie);

    this.client = axios.create({
      baseURL: baseUrl.replace(/\/$/, ""),
      headers: {
        "Content-Type": "application/json",
      },
    });

    this.setupTracing();
  }

  private setupTracing(): void {
    this.client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      const tracedConfig = config as TraceableRequestConfig;
      tracedConfig.__traceMeta = { startedAt: Date.now() };

      logger.debug("redmine-http", "Request", {
        authMode: this.redmineCookie ? "cookie" : "none",
        method: config.method?.toUpperCase(),
        url: `${config.baseURL || ""}${config.url || ""}`,
        params: config.params,
      });

      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        const tracedConfig = response.config as TraceableRequestConfig;
        const durationMs = tracedConfig.__traceMeta
          ? Date.now() - tracedConfig.__traceMeta.startedAt
          : undefined;

        logger.debug("redmine-http", "Response", {
          authMode: this.redmineCookie ? "cookie" : "none",
          method: response.config.method?.toUpperCase(),
          url: `${response.config.baseURL || ""}${response.config.url || ""}`,
          status: response.status,
          durationMs,
        });

        return response;
      },
      (error: AxiosError) => {
        const tracedConfig = error.config as TraceableRequestConfig | undefined;
        const durationMs = tracedConfig?.__traceMeta
          ? Date.now() - tracedConfig.__traceMeta.startedAt
          : undefined;

        logger.error("redmine-http", "Request failed", {
          authMode: this.redmineCookie ? "cookie" : "none",
          method: error.config?.method?.toUpperCase(),
          url: `${error.config?.baseURL || ""}${error.config?.url || ""}`,
          status: error.response?.status,
          statusText: error.response?.statusText,
          responseData: error.response?.data,
          errorMessage: error.message,
          durationMs,
        });

        if (error.response?.status === 401) {
          logger.warn("redmine-auth", "Authentication failed for Redmine request (check redmine cookie)", {
            authMode: this.redmineCookie ? "cookie" : "none",
            url: `${error.config?.baseURL || ""}${error.config?.url || ""}`,
            method: error.config?.method?.toUpperCase(),
          });
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * Set session ID for credential provider to use
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    if (this.credentialProvider) {
      const creds = this.credentialProvider(sessionId);
      this.redmineCookie = this.normalizeCookie(creds.redmineCookie) || this.redmineCookie;

      logger.debug("redmine-auth", "Updated client auth from credential provider", {
        sessionId,
        authMode: this.redmineCookie ? "cookie" : "none",
      });
    }
  }

  async validateConnection(): Promise<void> {
    if (!this.redmineCookie) {
      throw new Error("Missing Redmine cookie. Provide x-redmine-cookie or redmine_cookie.");
    }

    await this.client.get("/my/page", {
      headers: this.buildHtmlHeaders(),
      responseType: "text",
    });
  }

  async getIssue(issueId: number, includeJournals = true): Promise<RedmineIssue> {
    if (!this.redmineCookie) {
      throw new Error("Missing Redmine cookie. Provide x-redmine-cookie or redmine_cookie.");
    }

    return this.getIssueFromHtml(issueId, includeJournals);
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

  private normalizeCookie(rawCookie: string | undefined): string | undefined {
    if (!rawCookie) return undefined;
    const trimmed = rawCookie.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildHtmlHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "Upgrade-Insecure-Requests": "1",
    };

    if (this.redmineCookie) {
      headers.Cookie = this.redmineCookie;
    }

    return headers;
  }

  private async getIssueFromHtml(issueId: number, includeJournals: boolean): Promise<RedmineIssue> {
    if (!this.redmineCookie) {
      throw new Error("Missing Redmine cookie. Provide cookie credentials to read ticket HTML.");
    }

    const res = await this.client.get<string>(`/issues/${issueId}`, {
      headers: this.buildHtmlHeaders(),
      responseType: "text",
    });

    return this.parseIssueHtml(issueId, res.data, includeJournals);
  }

  private parseIssueHtml(issueId: number, html: string, includeJournals: boolean): RedmineIssue {
    const $ = load(html);
    const issueRoot = $("div.issue").first();

    if (!issueRoot.length) {
      throw new Error(
        "Unable to parse Redmine issue HTML response. Check cookie validity and access permissions."
      );
    }

    const clean = (value: string | null | undefined): string =>
      (value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const parseHrefId = (href: string | undefined): number => {
      if (!href) return 0;
      const match = href.match(/\/(?:users|issues)\/(\d+)/);
      return match ? Number(match[1]) : 0;
    };

    const toIsoDateTime = (input: string | undefined): string | undefined => {
      const raw = clean(input);
      if (!raw) return undefined;

      const dmYHm = raw.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
      if (dmYHm) {
        const [, dd, mm, yyyy, hh = "00", mi = "00"] = dmYHm;
        const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00+07:00`;
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
      }

      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    };

    const toIssueDate = (input: string | undefined): string | undefined => {
      const raw = clean(input);
      if (!raw) return undefined;

      const dmY = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmY) {
        return `${dmY[3]}-${dmY[2]}-${dmY[1]}`;
      }

      const yMd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (yMd) {
        return raw;
      }

      return undefined;
    };

    const extractWikiText = (node: ReturnType<typeof issueRoot.first>): string => {
      const cloned = node.clone();
      cloned.find("br").replaceWith("\n");

      cloned.find("p").each((_idx, p) => {
        const text = clean($(p).text());
        $(p).replaceWith(text ? `${text}\n\n` : "");
      });

      cloned.find("li").each((_idx, li) => {
        const text = clean($(li).text());
        $(li).replaceWith(text ? `- ${text}\n` : "");
      });

      return cloned
        .text()
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line, index, arr) => line.length > 0 || (index > 0 && arr[index - 1].length > 0))
        .join("\n")
        .trim();
    };

    const issueClass = issueRoot.attr("class") || "";
    const trackerId = Number(issueClass.match(/\btracker-(\d+)\b/)?.[1] || "0");
    const statusId = Number(issueClass.match(/\bstatus-(\d+)\b/)?.[1] || "0");
    const priorityId = Number(issueClass.match(/\bpriority-(\d+)\b/)?.[1] || "0");

    const projectName =
      clean($("span.current-project").first().text()) ||
      clean($("#project-jump .drdn-trigger").first().text()) ||
      "Unknown Project";
    const projectId = Number($("#issue_project_id option[selected=selected]").first().attr("value") || "0");

    const issueHeaderText = clean($("h2").first().text());
    const trackerNameFromHeader = clean(issueHeaderText.split("#")[0]);
    const trackerName =
      clean($("#issue_tracker_id option[selected=selected]").first().text()) ||
      trackerNameFromHeader ||
      "Unknown";

    const statusName = clean(issueRoot.find(".status.attribute .value").first().text()) || "Unknown";
    const priorityName = clean(issueRoot.find(".priority.attribute .value").first().text()) || "Normal";

    const authorAnchor = issueRoot.find("p.author a.user").first();
    const authorName = clean(authorAnchor.text()) || "Unknown";
    const authorId = parseHrefId(authorAnchor.attr("href"));

    const assignedAnchor = issueRoot.find(".assigned-to.attribute .value a").first();
    const assignedName = clean(assignedAnchor.text());
    const assignedId = parseHrefId(assignedAnchor.attr("href"));

    const subject = clean(issueRoot.find(".subject h3").first().text()) || `Issue #${issueId}`;
    const descriptionNode = issueRoot.find(".description .wiki").first();
    const description = descriptionNode.length ? extractWikiText(descriptionNode) : "";

    const startDate = toIssueDate(clean(issueRoot.find(".start-date.attribute .value").first().text()));
    const dueDate = toIssueDate(clean(issueRoot.find(".due-date.attribute .value").first().text()));

    const doneRatioRaw = clean(issueRoot.find(".progress .percent").first().text());
    const doneRatioMatch = doneRatioRaw.match(/(\d{1,3})%?/);
    const doneRatio = doneRatioMatch ? Number(doneRatioMatch[1]) : 0;

    const authorTimeLinks = issueRoot.find("p.author a[title]");
    const createdOn = toIsoDateTime($(authorTimeLinks.get(0)).attr("title")) || new Date().toISOString();
    const updatedOn = toIsoDateTime($(authorTimeLinks.get(1)).attr("title")) || createdOn;

    const childrenMap = new Map<number, string>();
    $("#issue_tree a[href*='/issues/']").each((_idx, el) => {
      const id = parseHrefId($(el).attr("href"));
      if (!id || id === issueId) return;

      const text = clean($(el).text());
      if (!text) return;

      const subjectText = text.replace(/^#?\d+\s*[:\-]?\s*/, "").trim() || text;
      childrenMap.set(id, subjectText);
    });

    const children = Array.from(childrenMap.entries()).map(([id, childSubject]) => ({
      id,
      subject: childSubject,
    }));

    const parentRaw = clean(String($("#issue_parent_issue_id").attr("value") || ""));
    const parentId = parentRaw ? Number(parentRaw) : 0;

    const journals: RedmineJournal[] = [];
    if (includeJournals) {
      $("#history .journal").each((index, element) => {
        const journalNode = $(element);
        const journalDomId = journalNode.attr("id") || "";
        const parsedId = Number(journalDomId.replace(/\D/g, ""));
        const journalId = parsedId > 0 ? parsedId : index + 1;

        const userAnchor = journalNode.find(".note-header a.user").first();
        const userName = clean(userAnchor.text()) || "Unknown";
        const userId = parseHrefId(userAnchor.attr("href"));

        const createdLink = journalNode.find(".note-header a[title]").first();
        const createdAt = toIsoDateTime(createdLink.attr("title")) || updatedOn;

        const notesNode = journalNode.find("[id^='journal-'][id$='-notes']").first();
        const notes = notesNode.length ? extractWikiText(notesNode) : "";

        const details: RedmineJournal["details"] = [];
        journalNode.find("ul.details > li").each((_detailIdx, li) => {
          const detailNode = $(li);
          const name = clean(detailNode.find("strong").first().text()).replace(/:$/, "") || "change";
          const text = clean(detailNode.text());
          if (!text) return;

          const changeMatch = text.match(/thay đổi từ\s+(.+?)\s+tới\s+(.+)/i);

          details.push({
            property: "attr",
            name,
            old_value: changeMatch ? clean(changeMatch[1]) : undefined,
            new_value: changeMatch ? clean(changeMatch[2]) : text,
          });
        });

        journals.push({
          id: journalId,
          user: { id: userId, name: userName },
          notes,
          created_on: createdAt,
          details,
        });
      });
    }

    return {
      id: issueId,
      project: {
        id: projectId,
        name: projectName,
      },
      tracker: {
        id: trackerId,
        name: trackerName,
      },
      status: {
        id: statusId,
        name: statusName,
      },
      priority: {
        id: priorityId,
        name: priorityName,
      },
      author: {
        id: authorId,
        name: authorName,
      },
      assigned_to: assignedName
        ? {
          id: assignedId,
          name: assignedName,
        }
        : undefined,
      subject,
      description,
      start_date: startDate,
      due_date: dueDate,
      done_ratio: Number.isFinite(doneRatio) ? doneRatio : 0,
      created_on: createdOn,
      updated_on: updatedOn,
      journals: includeJournals ? journals : undefined,
      children: children.length > 0 ? children : undefined,
      parent: parentId > 0 ? { id: parentId } : undefined,
    };
  }
}

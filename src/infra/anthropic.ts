import { z } from "zod";
import { AccountId, type OAuthCredential, type Profile } from "../domain/account.ts";
import type { LimitWindow, UsageReading } from "../domain/usage.ts";

export interface AnthropicApi {
  profile(accessToken: string): Promise<Profile>;
  usage(accessToken: string): Promise<UsageReading>;
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

export type ApiErrorKind = "unauthorized" | "invalid_grant" | "rate_limited" | "server" | "network" | "malformed";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpApiOptions {
  apiBase?: string;
  tokenUrl?: string;
  clientId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const ProfileResponse = z.object({
  account: z.object({
    uuid: z.string(),
    email: z.string(),
    has_claude_max: z.boolean().nullish(),
    has_claude_pro: z.boolean().nullish(),
  }),
  organization: z
    .object({
      uuid: z.string(),
      name: z.string().nullish(),
      organization_type: z.string().nullish(),
      rate_limit_tier: z.string().nullish(),
    })
    .nullish(),
});

const LimitEntry = z.object({
  kind: z.string(),
  group: z.string().nullish(),
  percent: z.number().nullish(),
  resets_at: z.string().nullish(),
  scope: z.unknown().nullish(),
});

const LegacyWindow = z.object({ utilization: z.number().nullish(), resets_at: z.string().nullish() }).nullish();

const UsageResponse = z.object({
  limits: z.array(LimitEntry).nullish(),
  five_hour: LegacyWindow,
  seven_day: LegacyWindow,
});

const RefreshResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  refresh_token_expires_in: z.number().nullish(),
  scope: z.string().nullish(),
});

export class HttpAnthropicApi implements AnthropicApi {
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpApiOptions = {}) {
    this.apiBase = options.apiBase ?? "https://api.anthropic.com";
    this.tokenUrl = options.tokenUrl ?? "https://platform.claude.com/v1/oauth/token";
    this.clientId = options.clientId ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async profile(accessToken: string): Promise<Profile> {
    const body = ProfileResponse.parse(await this.get("/api/oauth/profile", accessToken));
    return {
      id: AccountId(body.account.uuid),
      email: body.account.email,
      organizationUuid: body.organization?.uuid ?? null,
      organizationName: body.organization?.name ?? null,
      organizationType: body.organization?.organization_type ?? null,
      rateLimitTier: body.organization?.rate_limit_tier ?? null,
      hasClaudeMax: body.account.has_claude_max ?? false,
      hasClaudePro: body.account.has_claude_pro ?? false,
    };
  }

  async usage(accessToken: string): Promise<UsageReading> {
    const body = UsageResponse.parse(await this.get("/api/oauth/usage", accessToken));
    return { fetchedAt: new Date().toISOString(), windows: toWindows(body) };
  }

  async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    const response = await this.request(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: this.clientId,
        scope: credential.scopes.join(" "),
      }),
    });
    if (response.status === 400 || response.status === 401) {
      const text = await response.text();
      throw new ApiError(text.includes("invalid_grant") ? "invalid_grant" : "unauthorized", `refresh rejected: ${response.status}`);
    }
    const body = RefreshResponse.parse(await this.json(response));
    const now = Date.now();
    return {
      ...credential,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? credential.refreshToken,
      expiresAt: now + body.expires_in * 1000,
      ...(body.refresh_token_expires_in ? { refreshTokenExpiresAt: now + body.refresh_token_expires_in * 1000 } : {}),
      scopes: body.scope ? body.scope.split(" ").filter(Boolean) : credential.scopes,
    };
  }

  private async get(path: string, accessToken: string): Promise<unknown> {
    const response = await this.request(`${this.apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401 || response.status === 403) throw new ApiError("unauthorized", `${path}: ${response.status}`);
    return this.json(response);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { "User-Agent": "claude-switch", ...init.headers },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ApiError("network", err instanceof Error ? err.message : String(err));
    }
    if (response.status === 429) throw new ApiError("rate_limited", `${url}: 429`);
    if (response.status >= 500) throw new ApiError("server", `${url}: ${response.status}`);
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new ApiError("server", `unexpected status ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new ApiError("malformed", "response was not JSON");
    }
  }
}

function toWindows(body: z.infer<typeof UsageResponse>): LimitWindow[] {
  if (body.limits && body.limits.length > 0) {
    return body.limits.map((l) => ({
      kind: l.kind,
      group: l.group ?? l.kind,
      percent: Math.round(l.percent ?? 0),
      resetsAt: l.resets_at ?? null,
      scope: describeScope(l.scope),
    }));
  }
  const windows: LimitWindow[] = [];
  if (body.five_hour) windows.push(legacy("session", body.five_hour));
  if (body.seven_day) windows.push(legacy("weekly", body.seven_day));
  return windows;
}

function legacy(group: string, w: NonNullable<z.infer<typeof LegacyWindow>>): LimitWindow {
  return { kind: group, group, percent: Math.round(w.utilization ?? 0), resetsAt: w.resets_at ?? null, scope: null };
}

const ScopeShape = z.object({
  model: z.object({ display_name: z.string().nullish(), id: z.string().nullish() }).nullish(),
  surface: z.string().nullish(),
});

function describeScope(scope: unknown): string | null {
  if (scope === null || scope === undefined) return null;
  const parsed = ScopeShape.safeParse(scope);
  if (!parsed.success) return "scoped";
  const parts = [parsed.data.model?.display_name ?? parsed.data.model?.id, parsed.data.surface].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "scoped";
}

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return `${err.kind}: ${err.message}`;
  if (err instanceof z.ZodError) return "malformed: response shape changed";
  return err instanceof Error ? err.message : String(err);
}

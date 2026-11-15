import type { paths } from "./api-types.d.ts";

type ApiPath = keyof paths;
type ApiMethod<P extends ApiPath> = Extract<keyof paths[P], "get" | "post" | "delete">;
type Operation<P extends ApiPath, M extends ApiMethod<P>> = paths[P][M];
type RequestBody<P extends ApiPath, M extends ApiMethod<P>> = Operation<P, M> extends {
  requestBody?: infer Body;
} ? Body extends { content: infer Content } ? Content[keyof Content] extends { schema: infer Schema }
    ? Schema
  : never
  : never
  : never;
type ClientRequestBody<P extends ApiPath, M extends ApiMethod<P>> = RequestBody<P, M> |
  (P extends "/v1/images" ? Blob : never);
type SuccessResponse<P extends ApiPath, M extends ApiMethod<P>> = Operation<P, M> extends {
  responses: infer Responses;
} ? {
    [Status in keyof Responses]: `${Status & string}` extends `2${string}`
      ? Responses[Status] extends { content: infer Content }
        ? Content[keyof Content] extends { schema: infer Schema } ? Schema
        : never
      : undefined
      : never;
  }[keyof Responses]
  : never;
type Parameters<P extends ApiPath, M extends ApiMethod<P>> = Operation<P, M> extends {
  parameters?: infer Value;
} ? Value
  : never;

export interface ClientOptions {
  baseUrl: string;
  accessToken?: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string | null,
    readonly body: unknown,
  ) {
    super(`MetaGlasses API request failed with status ${status}.`);
  }
}

export function createClient({ baseUrl, accessToken, fetch: fetcher = fetch }: ClientOptions) {
  return {
    async request<P extends ApiPath, M extends ApiMethod<P>>(
      path: P,
      method: M,
      options: {
        params?: Parameters<P, M>;
        body?: ClientRequestBody<P, M>;
        signal?: AbortSignal;
      } = {},
    ): Promise<SuccessResponse<P, M>> {
      const parameters = options.params as {
        path?: Record<string, string | number>;
        query?: Record<string, string | number | boolean | null | undefined>;
      } | undefined;
      const resolvedPath = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
        const value = parameters?.path?.[key];
        if (value === undefined) throw new TypeError(`Missing path parameter: ${key}`);
        return encodeURIComponent(String(value));
      });
      const url = new URL(resolvedPath.replace(/^\//, ""), `${baseUrl.replace(/\/+$/, "")}/`);
      for (const [key, value] of Object.entries(parameters?.query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }

      const headers = new Headers();
      if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
      let body: BodyInit | undefined;
      if (options.body !== undefined) {
        const requestBody: unknown = options.body;
        if (requestBody instanceof Blob) {
          if (path === "/v1/images" && !["image/jpeg", "image/png"].includes(requestBody.type)) {
            throw new TypeError("Image uploads must use image/jpeg or image/png.");
          }
          body = requestBody;
          headers.set("Content-Type", requestBody.type);
        } else {
          body = JSON.stringify(requestBody);
          headers.set("Content-Type", "application/json");
        }
      }

      const response = await fetcher(url, {
        method: method.toUpperCase(),
        headers,
        body,
        signal: options.signal ?? AbortSignal.timeout(30_000),
      });
      const requestId = response.headers.get("x-request-id");
      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = undefined;
        }
        throw new ApiError(response.status, requestId, errorBody);
      }
      return (response.status === 204 ? undefined : await response.json()) as SuccessResponse<P, M>;
    },
  };
}

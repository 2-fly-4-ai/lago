export type ApiErrorBody = {
  status: number;
  error: string;
  code: string;
  message: string;
  request_id: string;
  error_details?: unknown;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: ApiError, requestId: string): Response {
  const body: ApiErrorBody = {
    status: error.status,
    error: statusName(error.status),
    code: error.code,
    message: error.message,
    request_id: requestId,
  };
  if (error.details !== undefined) body.error_details = error.details;

  return json(body, { status: error.status, requestId });
}

export function json(body: unknown, options: { status?: number; requestId: string }): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": options.requestId,
    },
  });
}

export async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const raw = await readBoundedText(request, 256 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes`);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new ApiError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new ApiError(422, "validation_error", `${key} must be an object`);
  }
  return nested as Record<string, unknown>;
}

export function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new ApiError(422, "validation_error", `${key} is required`);
  }
  return candidate.trim();
}

export function optionalString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  if (candidate === undefined || candidate === null || candidate === "") return null;
  if (typeof candidate !== "string") {
    throw new ApiError(422, "validation_error", `${key} must be a string`);
  }
  return candidate.trim() || null;
}

function statusName(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 413:
      return "Payload Too Large";
    case 415:
      return "Unsupported Media Type";
    case 422:
      return "Unprocessable Entity";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

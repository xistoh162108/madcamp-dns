export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "API_KEY_REVOKED"
  | "STUDENT_DISABLED"
  | "FORBIDDEN"
  | "FORBIDDEN_RECORD"
  | "NOT_FOUND"
  | "INVALID_RECORD_NAME"
  | "UNSUPPORTED_RECORD_TYPE"
  | "INVALID_RECORD_CONTENT"
  | "DNS_RECORD_CONFLICT"
  | "RECORD_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "CLOUDFLARE_ERROR"
  | "INTERNAL_ERROR";

export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly message: string,
    public readonly statusCode: number,
    public readonly details?: ErrorDetails
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function unauthorized(message = "Missing or invalid API key."): AppError {
  return new AppError("UNAUTHORIZED", message, 401);
}

export function apiKeyRevoked(): AppError {
  return new AppError(
    "API_KEY_REVOKED",
    "This API key has been revoked. Ask the administrator to issue a new key.",
    401
  );
}

export function studentDisabled(): AppError {
  return new AppError(
    "STUDENT_DISABLED",
    "This student account is disabled.",
    403
  );
}

export function forbidden(message = "Access denied."): AppError {
  return new AppError("FORBIDDEN", message, 403);
}

export function forbiddenRecord(): AppError {
  return new AppError(
    "FORBIDDEN_RECORD",
    "You can only access your own DNS records.",
    403
  );
}

export function notFound(resource = "Resource"): AppError {
  return new AppError("NOT_FOUND", `${resource} not found.`, 404);
}

export function invalidRequest(message: string, details?: ErrorDetails): AppError {
  return new AppError("INVALID_REQUEST", message, 400, details);
}

export function invalidRecordName(message: string): AppError {
  return new AppError("INVALID_RECORD_NAME", message, 400);
}

export function unsupportedRecordType(): AppError {
  return new AppError(
    "UNSUPPORTED_RECORD_TYPE",
    "Only A, AAAA, CNAME, and TXT records are supported.",
    400
  );
}

export function invalidRecordContent(message: string): AppError {
  return new AppError("INVALID_RECORD_CONTENT", message, 400);
}

export function dnsConflict(message: string): AppError {
  return new AppError("DNS_RECORD_CONFLICT", message, 409);
}

export function recordLimitExceeded(limit: number): AppError {
  return new AppError(
    "RECORD_LIMIT_EXCEEDED",
    `You can create up to ${limit} DNS records.`,
    403
  );
}

export function rateLimited(limit: number, windowSeconds: number, retryAfterSeconds: number): AppError {
  return new AppError(
    "RATE_LIMITED",
    "Too many requests. Try again later.",
    429,
    { limit, windowSeconds, retryAfterSeconds }
  );
}

export function cloudflareError(message: string, details?: ErrorDetails): AppError {
  return new AppError("CLOUDFLARE_ERROR", message, 502, details);
}

export function internalError(message = "An unexpected error occurred."): AppError {
  return new AppError("INTERNAL_ERROR", message, 500);
}

export function toErrorResponse(err: AppError) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

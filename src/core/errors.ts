export type ErrorCode =
  | "INVALID_PNG"
  | "UNSUPPORTED_PNG"
  | "APNG_NOT_SUPPORTED"
  | "LIMIT_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PAYLOAD"
  | "NOT_FOUND"
  | "MAGIC_NOT_FOUND"
  | "LENGTH_INVALID"
  | "PAYLOAD_CORRUPT"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function fail(code: string, message: string, statusCode = 400): never {
  throw new AppError(code, message, statusCode);
}

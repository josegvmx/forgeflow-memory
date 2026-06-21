export class ValidationError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UpstreamError extends Error {
  readonly status = 503 as const;
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class AppError extends Error {
  readonly status = 500 as const;
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

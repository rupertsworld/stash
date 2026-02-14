export class SyncError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
} as const;

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SyncError && !err.retryable) throw err;
      if (attempt === RETRY_CONFIG.maxAttempts) throw err;

      const delay = Math.min(
        RETRY_CONFIG.baseDelayMs *
          Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
        RETRY_CONFIG.maxDelayMs,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}

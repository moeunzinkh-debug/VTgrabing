import { AppError, normalizeError } from './errors';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function jsonOk<T>(data: T, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function jsonError(error: unknown): Response {
  const appError = normalizeError(error);
  if (!(error instanceof AppError)) {
    console.error(`[vtgrab] unhandled error: ${appError.message}`, error);
  }
  return new Response(JSON.stringify(appError.toJSON()), {
    status: appError.status,
    headers: JSON_HEADERS,
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('bad_request', 'Request body must be valid JSON');
  }
}

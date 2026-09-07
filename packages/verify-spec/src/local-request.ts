import type { IncomingMessage } from 'node:http';

/** Local users/processes are trusted, not authenticated. Block browser origins/rebinding. */
export function localRequestStatus(
  req: IncomingMessage,
  jsonMutation = false,
): 403 | 415 | undefined {
  const host = req.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return 403;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return 403;
  }
  if (Number(url.port || 80) !== req.socket.localPort) return 403;
  // React Native Android supplies this same HTTP origin for ws:// connections.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== url.origin) return 403;
  if (
    jsonMutation &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') &&
    req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  )
    return 415;
  return undefined;
}

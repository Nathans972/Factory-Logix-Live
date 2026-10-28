/**
 * Why a `fetch()` to FactoryLogix failed, in words an admin can act on. Node's fetch (undici) rejects
 * with the bare "fetch failed" (or "terminated" when the body stops halfway) and keeps the real reason,
 * an error with a `code` such as ECONNREFUSED or DEPTH_ZERO_SELF_SIGNED_CERT, in `cause`.
 */

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  reason?: unknown;
  cause?: unknown;
  errors?: unknown;
}

/** Plain words for the `code` on the cause. Other TLS and certificate codes are matched in `labelFor`. */
const FETCH_FAILURES = new Map<string, string>([
  ['ECONNREFUSED', 'connection refused'],
  ['ECONNRESET', 'connection reset'],
  ['EPIPE', 'connection closed by the server'],
  ['UND_ERR_SOCKET', 'connection closed by the server'],
  ['ENOTFOUND', 'host not found'],
  ['EAI_AGAIN', 'host name lookup failed'],
  ['EHOSTUNREACH', 'host unreachable'],
  ['ENETUNREACH', 'network unreachable'],
  ['ETIMEDOUT', 'no answer, a firewall may be dropping the connection'],
  ['UND_ERR_CONNECT_TIMEOUT', 'no answer, a firewall may be dropping the connection'],
  // What OpenSSL says when the other side does not speak TLS at all.
  ['ERR_SSL_WRONG_VERSION_NUMBER', 'TLS handshake failed, the server may not use https on this port'],
  ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'TLS handshake failed, the server may not use https on this port'],
]);

function labelFor(code: string): string | null {
  const known = FETCH_FAILURES.get(code);
  if (known) return known;
  if (code.startsWith('ERR_SSL_')) return 'TLS handshake failed';
  // OpenSSL's verify codes (DEPTH_ZERO_SELF_SIGNED_CERT, UNABLE_TO_VERIFY_LEAF_SIGNATURE, CERT_HAS_EXPIRED ...)
  // and Node's ERR_TLS_CERT_ALTNAME_INVALID.
  if (/CERT|LEAF_SIGNATURE|INVALID_CA/.test(code)) return 'certificate not trusted';
  return null;
}

function errorLike(value: unknown): ErrorLike | null {
  return value !== null && typeof value === 'object' ? (value as ErrorLike) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One error's own words: OpenSSL errors keep them in `reason`, their message is a multi-line dump. */
function detailOf(err: ErrorLike): string {
  return (
    (str(err.reason) || str(err.message).split('\n')[0])
      // Newer Node suggests --use-system-ca, which does not help inside the Docker image.
      .replace(/; if the root CA is installed locally.*$/, '')
      .trim()
  );
}

/** E.g. "connection refused (connect ECONNREFUSED 10.0.0.5:6065)". */
export function describeFetchError(err: unknown): string {
  const top = errorLike(err);
  const topMessage = str(top?.message) || String(err);
  const cause = errorLike(top?.cause);
  if (!cause) return str(top?.cause) ? `${topMessage} (${str(top?.cause)})` : topMessage;
  // A host name with several addresses (localhost is ::1 and 127.0.0.1) fails with an AggregateError:
  // empty message, the first address's code, one error per address.
  const inner = Array.isArray(cause.errors) ? cause.errors.map(errorLike).filter((e): e is ErrorLike => e !== null) : [];
  const code = str(cause.code) || str(inner[0]?.code);
  let detail = [...new Set([cause, ...inner].map(detailOf).filter(Boolean))].join(', ');
  if (code && !detail.includes(code)) detail = detail ? `${detail}, ${code}` : code;
  const label = labelFor(code) ?? topMessage;
  return detail ? `${label} (${detail})` : label;
}

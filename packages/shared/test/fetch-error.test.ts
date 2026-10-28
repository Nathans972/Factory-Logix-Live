import { describe, expect, it } from 'vitest';
import { describeFetchError } from '../src/fetch-error.js';

// The shapes Node's fetch (undici) rejects with: a bare "fetch failed" and the real reason in `cause`.
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function nodeError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

describe('describeFetchError', () => {
  it('names connection and name lookup failures and keeps the address', () => {
    const cases: [Error, string][] = [
      [nodeError('connect ECONNREFUSED 10.0.0.5:6065', { code: 'ECONNREFUSED' }), 'connection refused (connect ECONNREFUSED 10.0.0.5:6065)'],
      [nodeError('getaddrinfo ENOTFOUND fl-server', { code: 'ENOTFOUND' }), 'host not found (getaddrinfo ENOTFOUND fl-server)'],
      [nodeError('getaddrinfo EAI_AGAIN fl-server', { code: 'EAI_AGAIN' }), 'host name lookup failed (getaddrinfo EAI_AGAIN fl-server)'],
      [nodeError('read ECONNRESET', { code: 'ECONNRESET' }), 'connection reset (read ECONNRESET)'],
      [nodeError('other side closed', { name: 'SocketError', code: 'UND_ERR_SOCKET' }), 'connection closed by the server (other side closed, UND_ERR_SOCKET)'],
      [nodeError('connect EHOSTUNREACH 10.0.0.5:6065', { code: 'EHOSTUNREACH' }), 'host unreachable (connect EHOSTUNREACH 10.0.0.5:6065)'],
      [nodeError('connect ENETUNREACH 10.0.0.5:6065', { code: 'ENETUNREACH' }), 'network unreachable (connect ENETUNREACH 10.0.0.5:6065)'],
    ];
    for (const [cause, expected] of cases) expect(describeFetchError(fetchFailed(cause))).toBe(expected);
  });

  it('points at a firewall when nothing answers the connect', () => {
    const timeout = nodeError('Connect Timeout Error (attempted address: 10.0.0.5:6065, timeout: 10000ms)', {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    expect(describeFetchError(fetchFailed(timeout))).toBe(
      'no answer, a firewall may be dropping the connection (Connect Timeout Error (attempted address: 10.0.0.5:6065, timeout: 10000ms), UND_ERR_CONNECT_TIMEOUT)',
    );
  });

  it('lists every address of a host name that has several', () => {
    const both = Object.assign(
      new AggregateError(
        [
          nodeError('connect ECONNREFUSED ::1:6065', { code: 'ECONNREFUSED' }),
          nodeError('connect ECONNREFUSED 127.0.0.1:6065', { code: 'ECONNREFUSED' }),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    expect(describeFetchError(fetchFailed(both))).toBe(
      'connection refused (connect ECONNREFUSED ::1:6065, connect ECONNREFUSED 127.0.0.1:6065)',
    );
  });

  it('says the certificate is not trusted, and why, without the --use-system-ca hint', () => {
    const cases: [Error, string][] = [
      [
        nodeError('self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca', {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
        'certificate not trusted (self-signed certificate, DEPTH_ZERO_SELF_SIGNED_CERT)',
      ],
      [
        nodeError('unable to verify the first certificate', { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
        'certificate not trusted (unable to verify the first certificate, UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
      ],
      [
        nodeError('self-signed certificate in certificate chain', { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
        'certificate not trusted (self-signed certificate in certificate chain, SELF_SIGNED_CERT_IN_CHAIN)',
      ],
      [nodeError('certificate has expired', { code: 'CERT_HAS_EXPIRED' }), 'certificate not trusted (certificate has expired, CERT_HAS_EXPIRED)'],
      [
        nodeError("Hostname/IP does not match certificate's altnames: Host: fl-server. is not in the cert's altnames: DNS:other", {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
          reason: "Host: fl-server. is not in the cert's altnames: DNS:other",
        }),
        "certificate not trusted (Host: fl-server. is not in the cert's altnames: DNS:other, ERR_TLS_CERT_ALTNAME_INVALID)",
      ],
    ];
    for (const [cause, expected] of cases) expect(describeFetchError(fetchFailed(cause))).toBe(expected);
  });

  it('gives the short OpenSSL reason for a failed TLS handshake', () => {
    const notTls = nodeError(
      '001D4D54677C0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:../deps/openssl/openssl/ssl/record/methods/tls_common.c:660:\n',
      { code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG', reason: 'packet length too long' },
    );
    expect(describeFetchError(fetchFailed(notTls))).toBe(
      'TLS handshake failed, the server may not use https on this port (packet length too long, ERR_SSL_PACKET_LENGTH_TOO_LONG)',
    );
    const alert = nodeError('...:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure:...', {
      code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
      reason: 'sslv3 alert handshake failure',
    });
    expect(describeFetchError(fetchFailed(alert))).toBe(
      'TLS handshake failed (sslv3 alert handshake failure, ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE)',
    );
  });

  it('reads the cause of a response body that stops halfway', () => {
    const terminated = new TypeError('terminated', { cause: nodeError('other side closed', { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });
    expect(describeFetchError(terminated)).toBe('connection closed by the server (other side closed, UND_ERR_SOCKET)');
  });

  it('keeps the message, with any cause it has no words for', () => {
    expect(describeFetchError(fetchFailed(new Error('unknown scheme')))).toBe('fetch failed (unknown scheme)');
    expect(describeFetchError(fetchFailed(nodeError('Headers Timeout Error', { code: 'UND_ERR_HEADERS_TIMEOUT' })))).toBe(
      'fetch failed (Headers Timeout Error, UND_ERR_HEADERS_TIMEOUT)',
    );
    expect(describeFetchError(new Error('boom'))).toBe('boom');
    expect(describeFetchError('boom')).toBe('boom');
  });
});

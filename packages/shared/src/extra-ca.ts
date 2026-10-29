/**
 * The CA certificate docker-compose.yml hands the api and the collector as NODE_EXTRA_CA_CERTS when `.env`
 * sets FACTORYLOGIX_CA_CERT, so they trust an https:// FactoryLogix whose certificate is self-signed or comes
 * from the plant's own CA (docs/INSTALL.md, section 10). Node reads that file once, at start, and only warns
 * when it cannot open it: a DER file (what Windows exports by default), a directory or a file with no
 * certificate in it is skipped without a word, and Test connection keeps saying "certificate not trusted".
 * Both services log what this says at start instead.
 */

export interface ExtraCaCheck {
  ok: boolean;
  message: string;
}

/** The PEM armours OpenSSL reads a certificate from. */
const PEM_CERTIFICATE = /-----BEGIN (?:X509 )?CERTIFICATE-----/g;

const SEE = 'docs/INSTALL.md, section 10';

function codeOf(err: unknown): string {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * `path` is NODE_EXTRA_CA_CERTS: empty or unset without FACTORYLOGIX_CA_CERT, which needs no line in the log.
 * `read` returns the file as text (latin1 will do: only the PEM armour is looked for) or throws Node's error.
 */
export function checkExtraCaFile(path: string | undefined, read: (path: string) => string): ExtraCaCheck | null {
  if (!path) return null;
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    return {
      ok: false,
      message:
        `FACTORYLOGIX_CA_CERT: cannot read ${path} (${codeOf(err)}), so an https:// FactoryLogix with a certificate from that CA ` +
        `is not trusted. Put the CA certificate in the certs folder next to docker-compose.yml, readable by everyone ` +
        `(chmod 644), and set FACTORYLOGIX_CA_CERT in .env to its file name alone (${SEE})`,
    };
  }
  const count = text.match(PEM_CERTIFICATE)?.length ?? 0;
  if (count === 0) {
    return {
      ok: false,
      message:
        `FACTORYLOGIX_CA_CERT: ${path} holds no PEM certificate (no "-----BEGIN CERTIFICATE-----" line), so it is ignored. ` +
        `A certificate exported as DER converts with: openssl x509 -inform der -in plant-ca.cer -out plant-ca.pem (${SEE})`,
    };
  }
  return {
    ok: true,
    message: `FACTORYLOGIX_CA_CERT: ${path} holds ${count} certificate${count === 1 ? '' : 's'}, trusted for https:// FactoryLogix`,
  };
}

/**
 * Which X-Forwarded-For entries to believe when working out a request's client address (`req.ip`:
 * the key of the login rate limit and the address a failed login logs).
 *
 * The api is only reachable through the bundled nginx (docker-compose publishes nothing else), and
 * nginx appends the address it saw to whatever X-Forwarded-For the client sent. So the direct peer
 * is trusted and the entry nginx appended is the client. Anything left of that was written by the
 * client, unless it came through one of the site's own reverse proxies listed in TRUSTED_PROXIES.
 */
import { BlockList, isIP } from 'node:net';

/** An IPv4 or IPv6 address, optionally with a prefix length (`10.1.0.0/16`). */
export function isAddressOrRange(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
}

/** Fastify `trustProxy`: the direct peer (nginx), then only hops whose address is in `trusted`. */
export function proxyTrust(trusted: readonly string[] = []): (address: string, hop: number) => boolean {
  const listed = new BlockList();
  for (const entry of trusted) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) listed.addAddress(address, family);
    else listed.addSubnet(address, Number(prefix), family);
  }
  return (address, hop) => {
    if (hop === 0) return true;
    const family = isIP(address);
    return family !== 0 && listed.check(address, family === 6 ? 'ipv6' : 'ipv4');
  };
}

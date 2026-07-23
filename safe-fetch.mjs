// Shared hardened fetch for user-supplied URLs.
//
// The chat "save this linked recipe" path lets a household member hand us an arbitrary
// URL that the SERVER then fetches. Without guarding, that is a classic SSRF vector: a
// URL like http://169.254.169.254/ (cloud metadata) or http://192.168.1.1/ (LAN device)
// would be fetched by our server from inside the trust boundary. This module refuses any
// URL that resolves to a private / loopback / link-local / reserved address, re-validates
// every redirect hop, bounds the request with a timeout, and caps how many bytes we read
// so a hostile or runaway response can't exhaust memory.
//
// Threat model note: this is a family app. We close the realistic hole (a member pasting an
// internal address, and a public page redirecting to one). We do NOT defend against a
// determined DNS-rebinding attacker who controls a domain's resolver and races the check
// against the connect (TOCTOU) — that is out of scope for this deployment.

import net from 'node:net';
import dns from 'node:dns';

export class SsrfError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'SsrfError';
    this.code = 'ssrf_blocked';
    this.reason = reason;
  }
}

// Private / reserved ranges we refuse to fetch. net.BlockList does the CIDR math for us.
const blockedRanges = new net.BlockList();
// IPv4
blockedRanges.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
blockedRanges.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918 private
blockedRanges.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
blockedRanges.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blockedRanges.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local (incl. 169.254.169.254 metadata)
blockedRanges.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918 private
blockedRanges.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blockedRanges.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
blockedRanges.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918 private
blockedRanges.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blockedRanges.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
blockedRanges.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
blockedRanges.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blockedRanges.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved (incl. 255.255.255.255)
// IPv6
blockedRanges.addAddress('::1', 'ipv6'); // loopback
blockedRanges.addAddress('::', 'ipv6'); // unspecified
blockedRanges.addSubnet('fc00::', 7, 'ipv6'); // unique local
blockedRanges.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockedRanges.addSubnet('ff00::', 8, 'ipv6'); // multicast
blockedRanges.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blockedRanges.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 12000;

// dns.lookup returns IPv4 addresses in dotted form, so the common IPv4-mapped-IPv6 case
// arrives as "::ffff:10.0.0.5" — fold it back to plain IPv4 so BlockList's v4 rules apply.
function normalizeAddress(address) {
  const trimmed = String(address ?? '').trim().replace(/^\[|\]$/g, '');
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return mapped ? mapped[1] : trimmed;
}

export function isBlockedAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true; // unrecognizable → refuse
  return blockedRanges.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

async function defaultLookup(hostname) {
  return await dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// Validates scheme + that EVERY resolved address for the host is publicly routable.
// Throws SsrfError when the URL must not be fetched. Returns the parsed URL on success.
export async function assertAllowedUrl(rawUrl, { lookup = defaultLookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    throw new SsrfError('invalid_url', 'That is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError('bad_scheme', `Refused to fetch a non-HTTP(S) URL (${parsed.protocol}).`);
  }
  const hostname = normalizeAddress(parsed.hostname);
  if (!hostname) {
    throw new SsrfError('no_host', 'That URL has no host.');
  }
  if (/^localhost$/i.test(hostname) || /\.local$/i.test(hostname)) {
    throw new SsrfError('private_host', 'Refused to fetch a local or internal hostname.');
  }

  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(parsed.hostname);
    } catch {
      throw new SsrfError('dns_failed', 'Could not resolve that host.');
    }
  }
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) {
    throw new SsrfError('dns_empty', 'Could not resolve that host.');
  }
  for (const entry of list) {
    if (isBlockedAddress(entry?.address)) {
      throw new SsrfError('private_address', 'Refused to fetch a private or internal network address.');
    }
  }
  return parsed;
}

async function readBodyCapped(response, maxBytes) {
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (received + value.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - received);
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        try {
          await reader.cancel();
        } catch {}
        received = maxBytes;
        break;
      }
      chunks.push(value);
      received += value.length;
    }
    if (chunks.length === 0) return '';
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }
  // Fallback for fetch implementations / mocks without a stream body.
  if (typeof response?.text === 'function') {
    const text = await response.text();
    return String(text ?? '').slice(0, maxBytes);
  }
  return '';
}

// Fetches a user-supplied URL with SSRF validation on every hop, a wall-clock timeout,
// and a hard byte cap on the body. Returns { response, bodyText, finalUrl, redirectChain }.
// Redirects are followed manually so each Location target is re-validated before we connect.
export async function safeFetch(rawUrl, {
  fetchImpl = globalThis.fetch,
  lookup,
  headers = {},
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new SsrfError('no_fetch', 'Server-side fetching is unavailable.');
  }
  let currentUrl = String(rawUrl ?? '');
  const redirectChain = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertAllowedUrl(currentUrl, { lookup });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
      const status = Number(response?.status) || 0;
      const location = response?.headers?.get?.('location');
      if (REDIRECT_STATUSES.has(status) && location) {
        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new SsrfError('bad_redirect', 'The site redirected to an invalid URL.');
        }
        redirectChain.push({ from: currentUrl, to: nextUrl, status });
        // Release the socket before following the redirect.
        try {
          if (response.body?.cancel) await response.body.cancel();
          else if (typeof response.text === 'function') await response.text();
        } catch {}
        currentUrl = nextUrl;
        continue;
      }
      const bodyText = await readBodyCapped(response, maxBytes);
      return { response, bodyText, finalUrl: currentUrl, redirectChain };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SsrfError('too_many_redirects', 'That link redirected too many times.');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SsrfError,
  isBlockedAddress,
  assertAllowedUrl,
  safeFetch,
} from '../safe-fetch.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

// A fetch mock that never redirects: returns a plain 200 with a text() body.
function okFetch(body = '<html><body>ok</body></html>', overrides = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => body,
      ...overrides,
    };
  };
  impl.calls = calls;
  return impl;
}

test('isBlockedAddress flags private / loopback / link-local / reserved', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.9.9',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata endpoint
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedAddress allows public addresses', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('assertAllowedUrl rejects non-HTTP schemes', async () => {
  await assert.rejects(() => assertAllowedUrl('file:///etc/passwd'), (e) => e instanceof SsrfError && e.reason === 'bad_scheme');
  await assert.rejects(() => assertAllowedUrl('ftp://example.com/x'), (e) => e.reason === 'bad_scheme');
  await assert.rejects(() => assertAllowedUrl('gopher://example.com'), (e) => e.reason === 'bad_scheme');
});

test('assertAllowedUrl rejects a literal private/metadata IP without any DNS', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://169.254.169.254/latest/meta-data/'),
    (e) => e instanceof SsrfError && e.reason === 'private_address'
  );
  await assert.rejects(() => assertAllowedUrl('http://127.0.0.1:6379/'), (e) => e.reason === 'private_address');
  await assert.rejects(() => assertAllowedUrl('http://[::1]/'), (e) => e.reason === 'private_address');
});

test('assertAllowedUrl rejects localhost and *.local by name', async () => {
  await assert.rejects(() => assertAllowedUrl('http://localhost:3000/'), (e) => e.reason === 'private_host');
  await assert.rejects(() => assertAllowedUrl('http://printer.local/'), (e) => e.reason === 'private_host');
});

test('assertAllowedUrl rejects a public-looking host that RESOLVES to a private address', async () => {
  await assert.rejects(
    () => assertAllowedUrl('http://sneaky.example.com/', { lookup: privateLookup }),
    (e) => e instanceof SsrfError && e.reason === 'private_address'
  );
});

test('assertAllowedUrl allows a host that resolves to a public address', async () => {
  const parsed = await assertAllowedUrl('https://recipes.example.com/beef-stew', { lookup: publicLookup });
  assert.equal(parsed.hostname, 'recipes.example.com');
});

test('safeFetch refuses a private initial URL before calling fetch', async () => {
  const impl = okFetch();
  await assert.rejects(
    () => safeFetch('http://192.168.1.10/admin', { fetchImpl: impl }),
    (e) => e instanceof SsrfError && e.reason === 'private_address'
  );
  assert.equal(impl.calls.length, 0, 'fetch must not be called for a blocked host');
});

test('safeFetch returns capped body + finalUrl on a public success', async () => {
  const impl = okFetch('<html><body>hello</body></html>');
  const { bodyText, finalUrl, response, redirectChain } = await safeFetch('https://recipes.example.com/x', {
    fetchImpl: impl,
    lookup: publicLookup,
  });
  assert.match(bodyText, /hello/);
  assert.equal(finalUrl, 'https://recipes.example.com/x');
  assert.equal(response.status, 200);
  assert.equal(redirectChain.length, 0);
  assert.equal(impl.calls[0].options.redirect, 'manual');
});

test('safeFetch follows a public -> public redirect, re-validating', async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === 'https://recipes.example.com/start') {
      return {
        status: 302,
        headers: new Headers({ location: 'https://recipes.example.com/final' }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html>final</html>',
    };
  };
  const { finalUrl, bodyText, redirectChain } = await safeFetch('https://recipes.example.com/start', {
    fetchImpl: impl,
    lookup: publicLookup,
  });
  assert.equal(finalUrl, 'https://recipes.example.com/final');
  assert.match(bodyText, /final/);
  assert.equal(redirectChain.length, 1);
  assert.equal(calls.length, 2);
});

test('safeFetch blocks a redirect that points to an internal address', async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    // First hop (public) 302s to the cloud metadata endpoint.
    return {
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      text: async () => '',
    };
  };
  await assert.rejects(
    () => safeFetch('https://recipes.example.com/start', { fetchImpl: impl, lookup: publicLookup }),
    (e) => e instanceof SsrfError && e.reason === 'private_address'
  );
  assert.equal(calls.length, 1, 'should stop after the first hop, before fetching the internal target');
});

test('safeFetch caps an oversized body (text() fallback path)', async () => {
  const huge = 'x'.repeat(9_000_000);
  const impl = okFetch(huge);
  const { bodyText } = await safeFetch('https://recipes.example.com/big', {
    fetchImpl: impl,
    lookup: publicLookup,
    maxBytes: 1000,
  });
  assert.equal(bodyText.length, 1000);
});

test('safeFetch caps an oversized streaming body', async () => {
  // A ReadableStream that emits more bytes than maxBytes across multiple chunks.
  const chunk = new Uint8Array(400).fill(97); // 'a'
  const impl = async (url) => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk); // 4000 bytes total
        controller.close();
      },
    }),
  });
  const { bodyText } = await safeFetch('https://recipes.example.com/stream', {
    fetchImpl: impl,
    lookup: publicLookup,
    maxBytes: 1000,
  });
  assert.equal(bodyText.length, 1000);
});

test('safeFetch stops after too many redirects', async () => {
  let n = 0;
  const impl = async (url) => {
    n += 1;
    return {
      status: 302,
      headers: new Headers({ location: `https://recipes.example.com/hop-${n}` }),
      text: async () => '',
    };
  };
  await assert.rejects(
    () => safeFetch('https://recipes.example.com/loop', { fetchImpl: impl, lookup: publicLookup, maxRedirects: 3 }),
    (e) => e instanceof SsrfError && e.reason === 'too_many_redirects'
  );
});

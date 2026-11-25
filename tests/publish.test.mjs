import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { targetDomain } from '../scripts/domain.mjs';
import { assertSafeDns, ensureZone, existingServices, publish } from '../scripts/publish.mjs';

const sha = 'a'.repeat(40);
const env = { DEPLOY_DOMAIN: 'tools.example.com', CF_PAGES_PROJECT: 'example-tools', RELEASE_SHA: sha };
const activeZone = { id: 'zone', name: 'example.com', type: 'full', status: 'active' };

test('normalizes exact DNS names and rejects URLs, public suffixes and shared hosts', () => {
  assert.deepEqual(targetDomain(' Tools.Example.co.uk. '), { hostname: 'tools.example.co.uk', zoneName: 'example.co.uk' });
  assert.equal(targetDomain('工具.example.com').hostname, 'xn--h6qv61a.example.com');
  for (const input of ['https://example.com', 'example.com/path', 'example.com:443', '*.example.com', 'co.uk', 'my.pages.dev', '']) {
    assert.throws(() => targetDomain(input), /hostname/);
  }
});

test('migration ignores documented parking shapes and stops for website or email records', () => {
  const records = [
    { type: 'SOA', name: '@', data: 'ns' },
    { type: 'A', name: '@', data: 'Parked' },
    { type: 'CNAME', name: 'www', data: '@' },
    { type: 'MX', name: '@', data: 'mail.example.com' },
    { type: 'A', name: 'app', data: '192.0.2.1' },
  ];
  assert.deepEqual(existingServices(records, 'example.com'), records.slice(3));
  assert.doesNotThrow(() => assertSafeDns([{ type: 'CNAME', content: 'example-tools.pages.dev.' }], 'example-tools.pages.dev'));
  assert.throws(() => assertSafeDns([{ type: 'A', content: '192.0.2.1' }], 'example-tools.pages.dev'), /Existing DNS/);
});

test('zone onboarding changes nameservers only after ownership, records and DNSSEC checks', async () => {
  const original = ['ns01.domaincontrol.com', 'ns02.domaincontrol.com'];
  const target = ['one.ns.cloudflare.com', 'two.ns.cloudflare.com'];
  let state;
  let mutations = 0;
  let records = [{ name: '@', type: 'MX', data: 'mail.example.com' }];
  let ds = false;
  const dependencies = {
    zoneName: 'example.com',
    timeoutMs: 20,
    publicNs: async () => original,
    dsRecord: async () => ds,
    cf: {
      zone: async () => state,
      createZone: async () => {
        mutations++;
        return state = { ...activeZone, status: 'pending', name_servers: target };
      },
    },
    registrar: () => ({
      domain: async () => ({ domain: 'example.com', status: 'ACTIVE', nameServers: original }),
      dnsRecords: async () => records,
      replaceNameservers: async (domain, servers) => {
        assert.equal(domain, 'example.com');
        assert.deepEqual(servers, target);
        mutations++;
        state = { ...activeZone, name_servers: target };
      },
    }),
  };
  await assert.rejects(() => ensureZone(dependencies), /MX/);
  assert.equal(mutations, 0);
  records = [];
  ds = true;
  await assert.rejects(() => ensureZone(dependencies), /DNSSEC/);
  assert.equal(mutations, 0);
  ds = false;
  assert.equal((await ensureZone(dependencies)).status, 'active');
  assert.equal(mutations, 2);
});

test('publication verifies the expected revision and safely reuses an existing release', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'geo-publish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const releaseFile = join(dir, 'release.json');
  const siteUrl = 'https://' + env.DEPLOY_DOMAIN;
  await writeFile(releaseFile, JSON.stringify({ revision: sha, site: siteUrl, opportunity: 'utm-link-builder' }));
  const domainRecords = [];
  let binding = null;
  let uploads = 0;
  let deployed = false;
  const project = { name: env.CF_PAGES_PROJECT, production_branch: 'main', subdomain: env.CF_PAGES_PROJECT + '.pages.dev' };

  const dependencies = {
    releaseFile,
    timeoutMs: 25,
    cf: {
      zone: async () => activeZone,
      project: async () => project,
      dnsRecords: async () => domainRecords,
      bindings: async () => binding ? [{ name: env.DEPLOY_DOMAIN }] : [],
      binding: async () => binding,
      bind: async () => binding = { status: 'active' },
      addCname: async (_, name, content) => domainRecords.push({ type: 'CNAME', name, content }),
    },
    upload: async () => {
      uploads++;
      deployed = true;
    },
    verify: async ({ sha: revision, siteUrl: url }) => deployed && revision === sha && url === siteUrl,
  };

  assert.equal((await publish(env, dependencies)).status, 'verified');
  assert.equal((await publish(env, dependencies)).url, siteUrl);
  assert.equal(uploads, 1);
  assert.equal(domainRecords.length, 1);
  await assert.rejects(() => publish({ ...env, RELEASE_SHA: 'b'.repeat(40) }, dependencies), /same DEPLOY_DOMAIN and RELEASE_SHA/);
  await assert.rejects(() => publish(env, {
    ...dependencies,
    cf: { ...dependencies.cf, bindings: async () => [{ name: 'existing.example.com' }] },
  }), /already serves another custom hostname/);
  await assert.rejects(() => publish(env, { ...dependencies, verify: async () => false }), /live revision is still pending/);
});

test('Autoloop emits an approval card for the specified revision', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'geo-autoloop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contextFile = join(dir, 'context.json');
  const repo = 'example/geo';
  const domain = env.DEPLOY_DOMAIN;
  const id = createHash('sha256').update([repo, domain, sha].join(':')).digest('hex').slice(0, 24);
  await writeFile(contextFile, JSON.stringify({
    events: [{ type: 'site.release.requested', detail: JSON.stringify({ domain, sha, id }) }],
  }));
  const output = execFileSync(process.execPath, ['scripts/autoloop.mjs', 'handle'], {
    env: { ...process.env, GEO_GITHUB_REPO: repo, AGENT_AUTOLOOP_CONTEXT: contextFile },
    encoding: 'utf8',
  });
  const receipt = JSON.parse(output.split('\n')[2]);
  assert.deepEqual(receipt.ask[0].options, ['上线', '暂缓']);
  assert.match(receipt.ask[0].text, /example\/geo/);
  assert.equal(JSON.parse(receipt.ask[0].about).sha, sha);
});

test('the live check rejects a real revision when robots denies OpenAI search', async t => {
  const { verifyRelease } = await import('../scripts/publish.mjs');
  const siteUrl = 'https://tools.example.com';
  const homepage = '<link rel="canonical" href="' + siteUrl + '/">';
  const sitemap = '<urlset><url><loc>' + siteUrl + '/</loc></url></urlset>';
  let robots = 'User-agent: *\nAllow: /\nSitemap: ' + siteUrl + '/sitemap.xml\n';
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/release.json?')) return Response.json({ site: siteUrl, revision: sha });
    if (url.endsWith('/robots.txt')) return new Response(robots);
    if (url.endsWith('/sitemap.xml')) return new Response(sitemap);
    return new Response(homepage);
  });
  assert.equal(await verifyRelease({ siteUrl, sha }), true);
  robots += '\nUser-agent: OAI-SearchBot\nDisallow: /\n';
  assert.equal(await verifyRelease({ siteUrl, sha }), false);
});

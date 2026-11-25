import { execFile } from 'node:child_process';
import { resolveNs } from 'node:dns/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import robotsParser from 'robots-parser';
import { deploymentSettings } from './domain.mjs';
import { cloudflareClient, goDaddyClient, hasDsRecord } from './providers.mjs';

const execute = promisify(execFile);
const normalize = record => String(record ?? '').toLowerCase().replace(/\.$/, '');
const sameServers = (left, right) =>
  Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
  left.map(normalize).sort().join(',') === right.map(normalize).sort().join(',');

export function existingServices(records, zoneName) {
  return records.filter(record => {
    const name = normalize(record.name);
    const value = normalize(record.data);
    const apex = name === '@' || name === zoneName;
    const www = name === 'www' || name === 'www.' + zoneName;
    const connect = name === '_domainconnect' || name === '_domainconnect.' + zoneName;
    if (apex && ['NS', 'SOA'].includes(record.type)) return false;
    if (apex && record.type === 'A' && value === 'parked') return false;
    if (www && record.type === 'CNAME' && ['@', zoneName].includes(value)) return false;
    if (connect && record.type === 'CNAME' && value === '_domainconnect.gd.domaincontrol.com') return false;
    return true;
  });
}

export function assertSafeDns(records, destination) {
  const conflicts = records.filter(record => {
    if (record.type === 'CNAME') return normalize(record.content) !== normalize(destination);
    return ['A', 'AAAA', 'NS'].includes(record.type);
  });
  if (conflicts.length) {
    throw new Error('Existing DNS target or delegation at this hostname. Review the target in Cloudflare before releasing.');
  }
}

async function waitFor(check, description, timeoutMs, pause = sleep) {
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await check();
    if (ready) return ready;
    if (Date.now() < deadline) await pause(Math.min(10_000, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error(description + ' is still pending. Re-run this release after propagation.');
}

export async function ensureZone({ cf, registrar, zoneName, timeoutMs, publicNs = resolveNs, dsRecord = hasDsRecord }) {
  let zone = await cf.zone(zoneName);
  if (zone?.status === 'active' && zone.type === 'full') return zone;
  if (zone && (zone.type !== 'full' || zone.status !== 'pending')) {
    throw new Error('Cloudflare zone is not an active or pending full DNS zone. Review its configuration before releasing.');
  }

  const gd = registrar();
  const domain = await gd.domain(zoneName);
  const nameservers = domain?.nameServers;
  if (normalize(domain?.domain) !== zoneName || domain?.status !== 'ACTIVE' || !Array.isArray(nameservers) || nameservers.length < 2) {
    throw new Error('GoDaddy does not report this domain as active and owned by the configured account.');
  }

  if (!zone || !sameServers(nameservers, zone.name_servers)) {
    if (!nameservers.every(value => normalize(value).endsWith('.domaincontrol.com'))) {
      throw new Error('Existing nameservers are outside GoDaddy DNS. Review and migrate the DNS zone before releasing.');
    }
    const authoritative = await publicNs(zoneName);
    if (!sameServers(nameservers, authoritative)) throw new Error('Public DNS and GoDaddy disagree on nameservers. Retry after propagation.');
    const existing = existingServices(await gd.dnsRecords(zoneName), zoneName);
    if (existing.length) {
      const summary = existing.map(record => String(record.type).replace(/[^A-Z]/g, '') + ' ' + String(record.name).replace(/[^a-z0-9@_.-]/gi, '')).join(', ');
      throw new Error('Existing GoDaddy DNS records need a migration review: ' + summary);
    }
    if (await dsRecord(zoneName)) throw new Error('The zone has an active DNSSEC delegation. Review the migration before changing nameservers.');
    zone ??= await cf.createZone(zoneName);
    if (!Array.isArray(zone.name_servers) || zone.name_servers.length < 2) throw new Error('Cloudflare did not assign nameservers to this zone.');
    await gd.replaceNameservers(zoneName, zone.name_servers);
  }

  return waitFor(async () => {
    const current = await cf.zone(zoneName);
    return current?.status === 'active' && current.type === 'full' ? current : null;
  }, 'Cloudflare DNS activation', timeoutMs);
}

async function fetchPublished(url, type) {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000) });
    return response.ok ? await response[type]() : null;
  } catch {
    return null;
  }
}

export async function verifyRelease(settings) {
  const base = settings.siteUrl;
  const versionUrl = base + '/release.json?revision=' + settings.sha;
  const release = await fetchPublished(versionUrl, 'json');
  if (release?.revision !== settings.sha || release.site !== base) return false;
  const [home, robots, sitemap] = await Promise.all([
    fetchPublished(base + '/', 'text'),
    fetchPublished(base + '/robots.txt', 'text'),
    fetchPublished(base + '/sitemap.xml', 'text'),
  ]);
  if (!robots?.includes('Sitemap: ' + base + '/sitemap.xml')) return false;
  const crawlPolicy = robotsParser(base + '/robots.txt', robots);
  return Boolean(home?.includes('rel="canonical"') && home.includes(base + '/') &&
    sitemap?.includes('<loc>' + base + '/</loc>') &&
    ['Googlebot', 'OAI-SearchBot'].every(bot => crawlPolicy.isAllowed(base + '/', bot) !== false));
}

async function uploadPages(project, settings, env) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const { stdout, stderr } = await execute(process.execPath, [
    cli, 'pages', 'deploy', 'dist', '--project-name', project.name, '--branch', 'main', '--commit-hash', settings.sha,
  ], { env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, timeout: 300_000, maxBuffer: 2_000_000 });
  process.stderr.write(stdout + stderr);
}

export async function publish(env, {
  cf = cloudflareClient(env),
  registrar = () => goDaddyClient(env.GODADDY_PAT),
  upload = (project, settings) => uploadPages(project, settings, env),
  verify = verifyRelease,
  timeoutMs = 600_000,
  releaseFile = 'dist/release.json',
} = {}) {
  const settings = deploymentSettings(env);
  const release = JSON.parse(await readFile(releaseFile, 'utf8'));
  if (release.revision !== settings.sha || release.site !== settings.siteUrl) {
    throw new Error('Build dist for the same DEPLOY_DOMAIN and RELEASE_SHA before publishing.');
  }
  const current = await cf.project(settings.project);
  if (current && current.production_branch !== 'main') {
    throw new Error('Configure main as the Pages production branch before releasing.');
  }
  if (current?.source && current.source.config?.production_deployments_enabled !== false) {
    throw new Error('Disable Pages automatic production deployments. GitHub Actions controls production releases.');
  }
  if (current) {
    const domains = await cf.bindings(current.name);
    if (domains.some(domain => normalize(domain.name) !== settings.hostname)) {
      throw new Error('This Pages project already serves another custom hostname. Use a separate project for this site.');
    }
  }
  const zone = await ensureZone({ cf, registrar, zoneName: settings.zoneName, timeoutMs });
  const destination = current?.subdomain ?? settings.project + '.pages.dev';
  assertSafeDns(await cf.dnsRecords(zone.id, settings.hostname), destination);
  const project = current ?? await cf.createProject(settings.project);
  if (project.subdomain !== destination) throw new Error('Pages returned an unexpected project hostname. Review it before uploading.');
  let binding = await cf.binding(project.name, settings.hostname);

  if (!binding || !await verify(settings)) {
    await upload(project, settings);
  }
  binding ??= await cf.bind(project.name, settings.hostname);

  // The Pages dashboard can create the CNAME. Reconcile it when provisioning via API.
  const records = await cf.dnsRecords(zone.id, settings.hostname);
  assertSafeDns(records, destination);
  if (!records.some(record => record.type === 'CNAME' && normalize(record.content) === destination)) {
    await cf.addCname(zone.id, settings.hostname, destination);
  }

  await waitFor(async () => {
    const domain = await cf.binding(project.name, settings.hostname);
    return domain?.status === 'active' && await verify(settings);
  }, 'Pages domain, TLS or live revision', timeoutMs);

  return { status: 'verified', url: settings.siteUrl, revision: settings.sha, opportunity: release.opportunity, project: settings.project };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await publish(process.env);
    const body = JSON.stringify(report, null, 2) + '\n';
    await writeFile('publish-report.json', body);
    process.stdout.write(body);
  } catch (error) {
    const message = error.cmd ? 'Wrangler could not upload the build. Check the Pages project and deployment token.' : error.message;
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}

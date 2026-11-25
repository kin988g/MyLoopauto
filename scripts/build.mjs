import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { targetDomain } from './domain.mjs';

const path = new URL('../opportunities/utm-link-builder.json', import.meta.url);
const card = JSON.parse(readFileSync(path, 'utf8'));
const website = card.site ?? {};

if (
  !/^[a-z0-9-]+$/.test(card.id ?? '') ||
  typeof card.locale !== 'string' ||
  [website.name, website.title, website.description, card.demand, card.market].some(value => typeof value !== 'string' || !value.trim()) ||
  !card.evidence?.length ||
  card.evidence.some(entry => !URL.canParse(entry.url) || !entry.url.startsWith('https://') || !entry.note) ||
  !/^[a-z][a-z0-9_]*$/.test(card.conversion?.event ?? '')
) {
  throw new Error('The opportunity card must include a valid ID, site brief, evidence and conversion event.');
}

const env = { ASTRO_TELEMETRY_DISABLED: '1', ...process.env };
if (env.DEPLOY_DOMAIN) {
  env.SITE_URL = 'https://' + targetDomain(env.DEPLOY_DOMAIN).hostname;
}
if (env.SITE_URL) {
  const site = new URL(env.SITE_URL);
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash || site.port || site.username || site.password) {
    throw new Error('SITE_URL must be a bare HTTPS origin.');
  }
}

const astroCli = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));
const result = spawnSync(process.execPath, [astroCli, 'build'], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

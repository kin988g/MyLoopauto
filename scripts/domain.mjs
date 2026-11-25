import { domainToASCII } from 'node:url';
import { parse } from 'tldts';

export function targetDomain(input) {
  const name = String(input ?? '').trim().replace(/\.$/, '');
  const value = /^[\p{Letter}\p{Mark}\p{Number}.-]+$/u.test(name) ? domainToASCII(name) : '';
  const result = parse(value, { allowPrivateDomains: true });
  if (
    value.length > 253 ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ||
    value.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
    !result.domain || !result.isIcann
  ) {
    throw new Error('Enter a hostname such as example.com or tools.example.com, without a URL, port or wildcard.');
  }
  return { hostname: value, zoneName: result.domain };
}

export function deploymentSettings(env) {
  const { hostname, zoneName } = targetDomain(env.DEPLOY_DOMAIN);
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(env.CF_PAGES_PROJECT ?? '')) {
    throw new Error('Set CF_PAGES_PROJECT to the name of the Cloudflare Pages project.');
  }
  if (!/^[a-f0-9]{40}$/.test(env.RELEASE_SHA ?? '')) {
    throw new Error('RELEASE_SHA must be the 40-character Git commit SHA.');
  }
  return {
    hostname,
    zoneName,
    siteUrl: 'https://' + hostname,
    project: env.CF_PAGES_PROJECT,
    sha: env.RELEASE_SHA,
  };
}

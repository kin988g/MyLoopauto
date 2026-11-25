import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(operation, status, code) {
    super(operation + ' failed (HTTP ' + status + (code ? ', code ' + code : '') + ').');
    this.status = status;
  }
}

async function jsonRequest(url, { operation, token, method = 'GET', body, headers = {} }) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    const code = data?.errors?.[0]?.code ?? data?.code;
    throw new ApiError(operation, response.status, /^[a-z0-9_-]+$/i.test(String(code)) && code);
  }
  return data;
}

export function cloudflareClient(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[0-9a-f]{32}$/i.test(account ?? '') || !token) {
    throw new Error('Configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  }

  const request = async (path, operation, method, body) => {
    const result = await jsonRequest('https://api.cloudflare.com/client/v4' + path, { operation, token, method, body });
    return result.result;
  };
  const projects = '/accounts/' + account + '/pages/projects';
  const projectPath = project => projects + '/' + encodeURIComponent(project);
  const domainPath = (project, hostname) => projectPath(project) + '/domains/' + encodeURIComponent(hostname);

  return {
    async zone(name) {
      const zones = await request('/zones?' + new URLSearchParams({ name, 'account.id': account }), 'Read Cloudflare zone');
      return zones.find(zone => zone.name === name && zone.account?.id === account);
    },
    createZone(name) {
      return request('/zones', 'Create Cloudflare DNS zone', 'POST', { name, account: { id: account }, type: 'full' });
    },
    dnsRecords(zoneId, hostname) {
      return request('/zones/' + zoneId + '/dns_records?' + new URLSearchParams({ name: hostname, per_page: 100 }), 'Check Cloudflare DNS records');
    },
    addCname(zoneId, hostname, destination) {
      return request('/zones/' + zoneId + '/dns_records', 'Add Pages DNS record', 'POST', {
        type: 'CNAME', name: hostname, content: destination, ttl: 1, proxied: true,
      });
    },
    async project(project) {
      try {
        return await request(projectPath(project), 'Read Pages project');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    createProject(project) {
      return request(projects, 'Create Pages Direct Upload project', 'POST', { name: project, production_branch: 'main' });
    },
    bindings(project) {
      return request(projectPath(project) + '/domains', 'List Pages domain bindings');
    },
    async binding(project, hostname) {
      try {
        return await request(domainPath(project, hostname), 'Read Pages domain binding');
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    bind(project, hostname) {
      return request(projectPath(project) + '/domains', 'Bind domain to Pages project', 'POST', { name: hostname });
    },
  };
}

export function goDaddyClient(token) {
  if (!token) throw new Error('Set GODADDY_PAT to onboard a GoDaddy domain, or connect its Cloudflare zone first.');
  const root = 'https://api.godaddy.com/v3/domains';
  const request = (path, operation, options) => jsonRequest(root + path, { operation, token, ...options });
  return {
    domain(name) {
      return request('/domain-names/' + encodeURIComponent(name), 'Verify domain ownership in GoDaddy');
    },
    async dnsRecords(name) {
      const path = '/zones/' + encodeURIComponent(name) + '/dns-records';
      const records = [];
      let page = 1;
      let totalPages;
      do {
        const result = await request(path + '?' + new URLSearchParams({ page, pageSize: 100, totalRequired: true }), 'Inspect existing GoDaddy records');
        if (!Array.isArray(result?.items) || !Number.isInteger(result.totalPages) || result.totalPages < 0 || result.totalPages > 100) {
          throw new Error('GoDaddy did not return a complete DNS record listing. Review the domain before changing nameservers.');
        }
        records.push(...result.items);
        totalPages = result.totalPages;
        page++;
      } while (page <= totalPages);
      return records;
    },
    replaceNameservers(name, nameservers) {
      return request('/domain-names/' + encodeURIComponent(name) + '/nameservers', 'Set GoDaddy nameservers', {
        method: 'PUT', body: nameservers, headers: { 'Idempotency-Key': randomUUID() },
      });
    },
  };
}

export async function hasDsRecord(name) {
  const url = 'https://cloudflare-dns.com/dns-query?' + new URLSearchParams({ name, type: 'DS' });
  const result = await jsonRequest(url, { operation: 'Check public DNSSEC delegation', headers: { Accept: 'application/dns-json' } });
  if (result?.Status !== 0) throw new Error('Could not confirm DNSSEC status. Check public DNS before changing nameservers.');
  return (result.Answer ?? []).some(record => record.type === 43);
}

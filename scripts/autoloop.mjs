import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { targetDomain } from './domain.mjs';
import { verifyRelease } from './publish.mjs';

const execute = promisify(execFile);
const requestType = 'site.release.requested';
const titleFor = data => 'Publish ' + data.domain + ' ' + data.id;

function repository() {
  const repo = process.env.GEO_GITHUB_REPO ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Set GEO_GITHUB_REPO to owner/repository.');
  return repo;
}

async function gh(...args) {
  const result = await execute('gh', args, {
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  return result.stdout.trim();
}

function releaseData(domainInput, shaInput) {
  const domain = targetDomain(domainInput).hostname;
  const sha = String(shaInput);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release commit.');
  const repo = repository();
  const id = createHash('sha256').update([repo, domain, sha].join(':')).digest('hex').slice(0, 24);
  return { domain, sha, id };
}

function parseRelease(value) {
  const input = JSON.parse(value);
  const data = releaseData(input.domain, input.sha);
  if (data.id !== input.id) throw new Error('Release identifier does not match the repository, domain and commit.');
  return data;
}

function receipt(summary, actions = {}) {
  console.log(summary);
  if (Object.keys(actions).length) {
    console.log('\x60\x60\x60agent-autoloop\n' + JSON.stringify(actions) + '\n\x60\x60\x60');
  }
}

async function enqueue(input) {
  const repo = repository();
  const sha = await gh('api', 'repos/' + repo + '/commits/main', '--jq', '.sha');
  const data = releaseData(input, sha);
  const token = process.env.GEO_AUTOLOOP_SOURCE_TOKEN;
  if (!token) throw new Error('Set GEO_AUTOLOOP_SOURCE_TOKEN to the Autoloop geo source token.');
  const base = process.env.GEO_AUTOLOOP_URL;
  if (!base) throw new Error('Set GEO_AUTOLOOP_URL to the Autoloop hub URL.');
  const url = new URL('/v1/events', base);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: data.id, type: requestType, subject: data.domain,
      summary: 'Release request for ' + data.domain, detail: JSON.stringify(data),
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Autoloop did not accept the event (HTTP ' + response.status + ').');
  const report = await response.json();
  if (!report.duplicate && !report.routed?.length) throw new Error('Event was accepted without a matching rule. Load the GEO release rule.');
  console.log(JSON.stringify(report));
}

async function githubRun(data) {
  const rows = await gh('run', 'list', '--repo', repository(), '--workflow', 'publish.yml', '--branch', 'main',
    '--limit', '60', '--json', 'displayTitle,status,conclusion,url,headSha');
  return JSON.parse(rows).find(run => run.displayTitle === titleFor(data) && run.headSha === data.sha);
}

function poll(data, attempt) {
  return { key: 'publish-' + data.id,
    at: new Date(Date.now() + 120_000).toISOString(),
    about: JSON.stringify({ ...data, attempt }),
  };
}

async function handle(context) {
  const ask = [];
  const later = [];
  const notice = [];
  const handled = new Set();

  for (const answer of context.answers ?? []) {
    const data = parseRelease(answer.about);
    handled.add(data.id);
    if (answer.chosen !== '上线') continue;
    if (!await githubRun(data)) {
      await gh('workflow', 'run', 'publish.yml', '--repo', repository(), '--ref', 'main',
        '-f', 'domain=' + data.domain, '-f', 'expected_sha=' + data.sha, '-f', 'release_id=' + data.id);
    }
    later.push(poll(data, 1));
  }

  for (const timer of context.timers ?? []) {
    const data = parseRelease(timer.about);
    handled.add(data.id);
    const { attempt } = JSON.parse(timer.about);
    const run = await githubRun(data);
    if (run?.status === 'completed' && run.conclusion === 'success' &&
        await verifyRelease({ siteUrl: 'https://' + data.domain, sha: data.sha })) {
      notice.push({ title: '上线已验收', text: 'https://' + data.domain + '\n' + run.url, key: 'live-' + data.id, fyi: true });
    } else if ((run?.status === 'completed' && run.conclusion !== 'success') || attempt >= 24) {
      notice.push({ title: '上线有待复查', text: data.domain + '\n' + (run?.url ?? 'GitHub 发布记录尚未找到。'), key: 'review-' + data.id, fyi: true });
    } else {
      later.push(poll(data, attempt + 1));
    }
  }

  for (const event of context.events ?? []) {
    if (event.type !== requestType) continue;
    const data = parseRelease(event.detail);
    if (handled.has(data.id)) continue;
    ask.push({
      key: 'release-' + data.id,
      title: '确认上线 ' + data.domain,
      text: repository() + ' · main ' + data.sha.slice(0, 12),
      options: ['上线', '暂缓'],
      recommend: 1,
      about: JSON.stringify(data),
    });
  }

  const actions = { ...(ask.length && { ask }), ...(later.length && { later }), ...(notice.length && { notice }) };
  receipt(Object.keys(actions).length ? '已处理发布事项。' : '没事可做：没有待处理的发布动作。', actions);
}

if (process.argv[2] === 'enqueue') {
  await enqueue(process.argv[3]);
} else if (process.argv[2] === 'handle' && process.env.AGENT_AUTOLOOP_CONTEXT) {
  await handle(JSON.parse(await readFile(process.env.AGENT_AUTOLOOP_CONTEXT, 'utf8')));
} else {
  throw new Error('Use enqueue <domain>, or run handle through the Autoloop worker.');
}

import { expect, test } from '@playwright/test';
import { targetDomain } from '../scripts/domain.mjs';

test('builds and copies a campaign URL and emits a usage event', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.evaluate(() => {
    window.addEventListener('geo:conversion', event => {
      document.body.dataset.conversion = event.detail.name;
    });
  });
  await page.getByLabel('Destination URL').fill('https://example.com/demo?ref=a#intro');
  await page.getByLabel('Campaign source').fill('weekly newsletter');
  await page.getByLabel('Campaign medium').fill('email');
  await page.getByLabel('Campaign name').fill('launch');
  await page.getByRole('button', { name: 'Build link' }).click();
  const output = page.getByLabel('Tagged URL');
  await expect(output).toHaveValue('https://example.com/demo?ref=a&utm_source=weekly+newsletter&utm_medium=email&utm_campaign=launch#intro');
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status')).toHaveText('Link copied.');
  await expect(page.locator('body')).toHaveAttribute('data-conversion', 'campaign_link_copied');
  await page.getByLabel('Campaign name').fill('updated');
  await expect(output).toBeHidden();
});

test('renders page, crawler routes and the expected build revision', async ({ request }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.ok()).toBeTruthy();
  expect(await robots.text()).toContain('Allow: /');
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.ok()).toBeTruthy();
  expect(await sitemap.text()).toContain('<urlset');
  const release = await request.get('/release.json');
  const identity = await release.json();
  expect(identity.opportunity).toBe('utm-link-builder');
  expect(identity.revision).toBe(process.env.RELEASE_SHA || 'local');
  if (process.env.DEPLOY_DOMAIN) {
    expect(identity.site).toBe('https://' + targetDomain(process.env.DEPLOY_DOMAIN).hostname);
    expect(await sitemap.text()).toContain('<loc>' + identity.site + '/</loc>');
  }
});

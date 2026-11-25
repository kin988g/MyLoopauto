import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const homepage = site?.protocol === 'https:' ? '<url><loc>' + site.href + '</loc></url>' : '';
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + homepage + '</urlset>',
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};

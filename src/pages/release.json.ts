import type { APIRoute } from 'astro';
import opportunity from '../../opportunities/utm-link-builder.json';

export const GET: APIRoute = ({ site }) => Response.json({
  opportunity: opportunity.id,
  revision: process.env.RELEASE_SHA || 'local',
  site: site?.origin,
});

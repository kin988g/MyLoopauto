const tagNames = ['source', 'medium', 'campaign', 'term', 'content'] as const;
type Tags = Partial<Record<(typeof tagNames)[number], string>>;

export function campaignUrl(destination: string, tags: Tags): string {
  const url = new URL(destination.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS website URL.');
  }

  if (['source', 'medium', 'campaign'].some(key => !tags[key as keyof Tags]?.trim())) {
    throw new Error('Enter a source, medium, and campaign.');
  }

  for (const name of tagNames) {
    const value = tags[name]?.trim();
    if (value) url.searchParams.set('utm_' + name, value);
  }
  return url.toString();
}

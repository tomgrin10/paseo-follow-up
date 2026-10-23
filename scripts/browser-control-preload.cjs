const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const parsed = new URL(typeof url === 'string' ? url : url.url ?? url);
  if (parsed.origin === 'https://api.graphite.com' && parsed.pathname.startsWith('/v1/graphite/')) return original(process.env.FOLLOW_TEST_GRAPHITE_URL + parsed.pathname, init);
  return original(url, init);
};

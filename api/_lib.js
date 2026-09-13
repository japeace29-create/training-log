// Upstash Redis REST API. The Vercel Marketplace integration injects KV_REST_API_*;
// a database created directly in the Upstash console uses UPSTASH_REDIS_REST_*.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvCommand(command) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('База не подключена: добавьте Upstash Redis в разделе Storage проекта на Vercel');
  }
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(command)
  });
  if (!res.ok) {
    throw new Error('KV request failed: ' + res.status);
  }
  const data = await res.json();
  return data.result;
}

async function kvGet(key) {
  return kvCommand(['GET', key]);
}

async function kvSet(key, value) {
  return kvCommand(['SET', key, value]);
}

module.exports = { kvGet, kvSet };

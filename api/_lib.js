// Общий модуль для работы с Vercel KV (Upstash Redis REST API).
// Переменные KV_REST_API_URL / KV_REST_API_TOKEN подставляются
// автоматически, когда в проекте на Vercel подключено хранилище KV.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvCommand(command) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('KV не подключено: нет KV_REST_API_URL / KV_REST_API_TOKEN');
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

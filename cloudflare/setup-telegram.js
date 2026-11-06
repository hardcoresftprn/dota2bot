// Run locally after deployment. Secrets are sent over stdin, never CLI arguments.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootEnv = new URL('../.env', import.meta.url);
const varsPath = new URL('.dev.vars', import.meta.url);
const config = { ...(existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, 'utf8')) : {}), ...process.env };
const local = existsSync(varsPath) ? parseEnv(readFileSync(varsPath, 'utf8')) : {};
const args = process.argv.slice(2);
const index = args.indexOf('--url');
const value = index >= 0 ? args[index + 1] : config.PUBLIC_WORKER_URL;
if (!value || !/^\d+:[A-Za-z0-9_-]+$/.test(config.TELEGRAM_BOT_TOKEN || '')) {
  console.error('Нужны TELEGRAM_BOT_TOKEN в ../.env и адрес: node setup-telegram.js --url https://ИМЯ.ПОДДОМЕН.workers.dev --upload-secrets');
  process.exit(1);
}
const url = new URL(value);
if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.workers.dev') || url.search || url.hash || !['', '/'].includes(url.pathname)) {
  console.error('Укажите HTTPS-адрес развёрнутого бота на workers.dev без пути и параметров.'); process.exit(1);
}
const secret = local.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString('hex');
const secrets = { TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: secret };
if (config.OPENAI_API_KEY) {
  secrets.OPENAI_API_KEY = config.OPENAI_API_KEY;
  secrets.OPENAI_MODEL = config.OPENAI_MODEL || 'gpt-4.1-mini';
}
const call = async (method, data) => {
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${result.error_code || response.status}`);
  return result.result;
};
try {
  const health = await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(20000) });
  if (!health.ok || (await health.text()).trim() !== 'ok') throw new Error('Worker health check failed');
  const me = await call('getMe', {});
  const webhook = await call('getWebhookInfo', {});
  const target = new URL('/telegram', url).toString();
  if (webhook.url && webhook.url !== target && !args.includes('--replace-webhook')) throw new Error('Бот уже использует другой webhook. Для переноса добавьте --replace-webhook.');
  if (args.includes('--upload-secrets')) {
    const wrangler = fileURLToPath(new URL('node_modules/.bin/wrangler', import.meta.url));
    const upload = spawnSync(wrangler, ['secret', 'bulk'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), input: JSON.stringify(secrets), encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    if (upload.status !== 0) throw new Error('Загрузка секретов не завершена');
  }
  writeFileSync(varsPath, Object.entries(secrets).map(([key, val]) => `${key}=${JSON.stringify(val)}`).join('\n') + '\n', { mode: 0o600 });
  await call('setMyCommands', { commands: [
    { command: 'start', description: 'Подписаться на важные обновления' },
    { command: 'stop', description: 'Отключить рассылку' },
    { command: 'latest', description: 'Последний сохранённый разбор' },
    { command: 'status', description: 'Подписка и проверка источников' },
    { command: 'help', description: 'Как пользоваться ботом' },
  ] });
  await call('setWebhook', { url: target, secret_token: secret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false });
  const check = await call('getWebhookInfo', {});
  if (check.url !== target) throw new Error('Webhook not confirmed');
  console.log(`Бот подключён: https://t.me/${me.username}`);
  console.log('Откройте бота и отправьте /start. Источники будут проверены в ближайшие 10 минут.');
} catch (error) {
  // Don't print request URLs or exception stacks containing credentials.
  console.error(error.message?.startsWith('Telegram ') || error.message?.startsWith('Бот уже') ? error.message : `Не удалось завершить подключение (${error.name}). Проверьте авторизацию и настройки.`);
  process.exit(1);
}

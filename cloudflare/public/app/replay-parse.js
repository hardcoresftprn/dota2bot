import { DataError } from './dota-core.js';
import { clientPublicData } from './public-data.js?v=5';

const origin = 'https://api.opendota.com/api';
const validMatch = id => /^[1-9]\d{0,11}$/.test(String(id));
const validJob = id => /^[1-9]\d{0,19}$/.test(String(id));

// Parse requests use the visitor's public OpenDota allowance (a POST costs 10 calls).
// Never attach Telegram initData, cookies or API keys, and never retry a POST.
async function request(path, method, signal) {
  const response = await fetch(origin + path, {
    method, credentials: 'omit', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (response.status === 429) throw new DataError('OpenDota ограничил запросы. Подождите немного и проверьте готовность позже.', 429);
  if ([400, 404].includes(response.status)) throw new DataError('OpenDota не нашёл матч или запрос разбора. Откройте матч в OpenDota для проверки.', response.status);
  if (!response.ok) throw new DataError('OpenDota временно не может обработать запрос. Попробуйте позже.');
  const value = await response.json();
  if (value?.error) throw new DataError('OpenDota не смог обработать реплей. Подробности доступны на странице матча в OpenDota.');
  return value;
}

export async function requestReplayParse(id, { signal } = {}) {
  if (!validMatch(id)) throw new DataError('Проверьте ID матча.', 400);
  signal?.throwIfAborted();
  const result = await request(`/request/${id}`, 'POST', signal);
  if (!validJob(result?.job?.jobId)) throw new DataError('OpenDota не подтвердил постановку в очередь. Проверьте матч в OpenDota перед повторным запросом.');
  return String(result.job.jobId);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function watchReplayParse(id, jobId, { signal, pause = wait, loadMatch = clientPublicData } = {}) {
  if (!validMatch(id) || !validJob(jobId)) throw new DataError('Неверный запрос разбора.', 400);
  // A missing queue job means it ended, not necessarily that parsing succeeded.
  // Only a fresh match response can confirm that detailed data actually exists.
  let finishedWithoutData = 0;
  for (let attempt = 0; attempt < 18; attempt++) {
    signal?.throwIfAborted();
    if (attempt) await pause(10000, signal);
    const job = await request(`/request/${jobId}`, 'GET', signal);
    if (job === null) {
      const data = await loadMatch(`/api/analysis/match?id=${id}`, { signal, refresh: true });
      signal?.throwIfAborted();
      if (data.parsed) return { state: 'complete', data };
      // Give the match endpoint time to publish the result after the job disappears.
      if (++finishedWithoutData >= 3) return { state: 'unavailable', data };
      continue;
    }
    if (!validJob(job?.jobId) || String(job.jobId) !== String(jobId)) throw new DataError('OpenDota вернул неизвестный статус. Проверьте готовность позже.');
  }
  return { state: 'pending' };
}

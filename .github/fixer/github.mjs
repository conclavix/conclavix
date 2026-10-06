import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadConfig(dir = HERE) {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}

export function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** Neutralises mentions and HTML comments in model output before it is posted. */
export function sanitize(text, max = 2000) {
  const clean = String(text ?? '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[A-Za-z0-9])/g, '&#64;');
  return clean.length > max ? `${clean.slice(0, max)} [truncated]` : clean;
}

/** Single line, printable ASCII only, for commit messages. */
export function plain(text, max = 300) {
  const clean = String(text ?? '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export function createClient({ token, repository, api, fetchImpl = fetch }) {
  const base = api || 'https://api.github.com';
  return async function request(method, path, body, { raw = false } = {}) {
    const url =
      path.startsWith('/repos/') || path.startsWith('/users/')
        ? path
        : `/repos/${repository}${path}`;
    const response = await fetchImpl(`${base}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  };
}

/** Reads all pages of a list endpoint; `key` selects the array in wrapped responses. */
export async function paginate(request, path, key, maxPages = 10) {
  const all = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await request('GET', `${path}${sep}per_page=100&page=${page}`);
    const batch = key ? (data?.[key] ?? []) : (data ?? []);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export function clientFromEnv() {
  return createClient({
    token: env('GITHUB_TOKEN'),
    repository: env('GITHUB_REPOSITORY'),
    api: process.env.GITHUB_API_URL,
  });
}

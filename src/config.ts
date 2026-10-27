import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, noLinks, safePath } from './paths.js';
import { FishError } from './types.js';

export interface Config {
  enabled: boolean; groups: string[]; admins: string[]; names: string[];
  autonomous: boolean; autoReply: boolean; probability: number; activity: number;
  cooldownMs: number; dailyInterjections: number; windowSize: number; maxChars: number;
  quietHours: number[]; interests: string[]; bufferMs: number; historyHours: number;
  dailyTokens: number; groupDailyTokens: number; userDailyRequests: number; maxOutputTokens: number;
  search: boolean; searchDaily: number; searchCount: number; searchTimeoutMs: number;
  codex: boolean; codexDaily: number; codexTimeoutMs: number; codexDailyMs: number;
  maxFiles: number; maxArtifactBytes: number; images: boolean; imageDaily: number;
  port: number; model: string;
}
export const defaults: Config = {
  enabled: true, groups: [], admins: [], names: ['小鱼', 'DeepSeekFish'],
  autonomous: false, autoReply: false, probability: 0.02, activity: 0.5,
  cooldownMs: 480000, dailyInterjections: 12, windowSize: 20, maxChars: 600,
  quietHours: [0, 7], interests: ['AI', '编程', '游戏'], bufferMs: 1200, historyHours: 24,
  dailyTokens: 120000, groupDailyTokens: 60000, userDailyRequests: 50, maxOutputTokens: 256,
  search: false, searchDaily: 20, searchCount: 3, searchTimeoutMs: 10000,
  codex: false, codexDaily: 22, codexTimeoutMs: 300000, codexDailyMs: 6600000,
  maxFiles: 20, maxArtifactBytes: 10485760, images: false, imageDaily: 20,
  port: 17861, model: 'deepseek-v4-flash',
};
export function validateConfig(input: Record<string, unknown>): Config {
  const c = { ...defaults, ...input } as Config;
  for (const [k, v] of Object.entries(input)) {
    if (!(k in defaults) || typeof v !== typeof defaults[k as keyof Config]) throw new FishError('INVALID_CONFIG_' + k);
  }
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 ||
      (!['probability', 'activity'].includes(k) && !Number.isInteger(v)))) throw new FishError('INVALID_CONFIG_' + k);
  }
  for (const key of ['groups', 'admins', 'names', 'interests'] as const) {
    if (!Array.isArray(c[key]) || !c[key].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) throw new FishError('INVALID_CONFIG_' + key);
  }
  if (!Array.isArray(c.quietHours) || c.quietHours.length !== 2 || !c.quietHours.every(v => Number.isInteger(v) && v >= 0 && v < 24) ||
    c.probability > 1 || c.activity > 1 || c.maxOutputTokens < 1 || c.maxOutputTokens > 4096 ||
    c.windowSize < 1 || c.windowSize > 100 || c.maxChars < 32 || c.maxChars > 4000 ||
    c.searchCount < 1 || c.searchCount > 5 || c.codexTimeoutMs < 10 || c.codexTimeoutMs > 1800000 ||
    c.port < 1024 || c.port > 65535 || c.historyHours < 1 || c.historyHours > 168 || c.bufferMs > 10000 ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(c.model)) throw new FishError('INVALID_CONFIG');
  return c;
}
export function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (path.dirname(dir) !== dir) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).name === 'deepseekfish') return dir;
    dir = path.dirname(dir);
  }
  throw new FishError('PROJECT_ROOT_MISSING');
}
export function prepare(root: string): void {
  noLinks(root);
  if(process.platform!=='win32')process.umask(0o077);
  for (const p of ['runtime/data', 'runtime/logs', 'runtime/cache', 'runtime/tmp', 'runtime/workspace', 'runtime/outputs', 'runtime/codex-home']) makeDir(root, p);
  // All application caches/temp are project-owned; never redirect or copy existing credentials.
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = safePath(root, 'runtime/tmp');
  process.env.XDG_CACHE_HOME = safePath(root, 'runtime/cache');
}
export function loadConfig(root: string): Config {
  const p = safePath(root, 'config/local.json');
  return validateConfig(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
}
export function loadSecrets(root: string): void {
  const p = safePath(root, '.env');
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

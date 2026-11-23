import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { safePath } from '../paths.js';
import { browsedTwitterPosts } from '../search/public-web.js';
import type { SocialPost } from '../search/social-common.js';
import { redact } from '../storage/db.js';
import { FishError, type ModelTool } from '../types.js';

type Platform = 'tieba' | 'twitter';
type EventKind = 'read' | 'received' | 'sent';
type Person = { platform: Platform; uid: string; name: string; handle: string; firstSeenAt: number; lastSeenAt: number };
type Observation = Pick<Person, 'platform' | 'uid' | 'name' | 'handle'> & {
  kind: EventKind; ref: string; forum: string; topic: string; text: string; publishedAt: string;
};
type History = Pick<Observation, 'kind' | 'ref' | 'forum' | 'topic' | 'text' | 'publishedAt'> & { seenAt: number };
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const excerpt = (value: unknown, max: number) => typeof value === 'string' ? redact(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max) : '';
const rows = (value: unknown): any[] => Array.isArray(value) ? value : [];
const published = (value: unknown) => typeof value === 'number' && value > 0 && value < 8640000000000000
  ? new Date(value).toISOString() : excerpt(value, 80);

function tiebaLink(url: unknown, threadId?: string) {
  if (typeof url !== 'string' || url.length > 2048) return;
  try {
    const source = new URL(url);
    if (source.hostname !== 'tieba.baidu.com' || !['https:', 'http:'].includes(source.protocol) || source.port || source.username || source.password) return;
    const path = /^\/p\/([1-9]\d{0,19})\/?$/.exec(source.pathname)?.[1];
    const thread = path ?? (source.pathname === '/p/comment' ? source.searchParams.get('tid') : undefined);
    if (!numericId(thread) || threadId && thread !== threadId) return;
    const parent = source.searchParams.get('pid'), anchor = source.hash.slice(1);
    return `https://tieba.baidu.com/p/${thread}` + (numericId(parent) ? `?pid=${parent}` : '') +
      (numericId(anchor) && anchor !== parent ? `#${anchor}` : '');
  } catch { return; }
}

function tiebaObservation(row: any, page: { forum: string; topic: string; threadId?: string; ownUid?: string }, kind: EventKind): Observation | undefined {
  const uid = row?.author?.id;
  const ref = tiebaLink(row?.targetStatus === 'verified' && row.replyTarget ? row.replyTarget : row?.url, page.threadId);
  if (!numericId(uid) || !ref || uid === page.ownUid) return;
  return { platform: 'tieba', uid, name: excerpt(row.author.name, 100), handle: '', kind, ref,
    forum: page.forum, topic: page.topic || excerpt(row.threadTitle ?? row.title, 200),
    text: excerpt(row.content ?? row.text, 500), publishedAt: published(row.publishedAt ?? row.time) };
}

function twitterObservation(post: SocialPost): Observation | undefined {
  if (!numericId(post.id) || !numericId(post.author?.id) || post.kind === 'unavailable') return;
  return { platform: 'twitter', uid: post.author.id, name: excerpt(post.author.name, 100),
    handle: excerpt(post.author.handle, 15), kind: 'read', ref: `https://x.com/i/web/status/${post.id}`,
    forum: '', topic: '', text: excerpt(post.text, 500), publishedAt: published(post.publishedAt) };
}

function styleFrom(history: History[]) {
  const samples = [...new Map(history.filter(event => event.kind !== 'sent' && event.text)
    .map(event => [event.ref, event])).values()];
  const signals: string[] = [];
  if (samples.length >= 2) {
    const common = (matches: (text: string) => boolean) => samples.filter(event => matches(event.text)).length >= Math.max(2, Math.ceil(samples.length / 2));
    if (common(text => text.length <= 35)) signals.push('样本多为短句');
    if (common(text => /[?？]/u.test(text))) signals.push('常用问句');
    if (common(text => /[!！]/u.test(text))) signals.push('常用感叹号');
    if (common(text => /哈哈|笑死|[😂🤣]|\blol\b/iu.test(text))) signals.push('常带笑声或玩笑语气');
    if (common(text => /谢谢|辛苦了|麻烦你|多谢|\bthanks\b/iu.test(text))) signals.push('常用道谢或客气用语');
    if (common(text => /因为|所以|例如|比如|换句话说|\bbecause\b/iu.test(text))) signals.push('常说明原因或举例');
  }
  return { samples: samples.length, signals, basis: samples.length < 2 ? '样本不足' : '仅描述最近发言样本，不代表固定性格' };
}

const schema = `
  CREATE TABLE IF NOT EXISTS external_people (
    owner TEXT NOT NULL, platform TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL, handle TEXT NOT NULL,
    firstSeenAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, PRIMARY KEY(owner,platform,uid)
  );
  CREATE TABLE IF NOT EXISTS external_people_events (
    owner TEXT NOT NULL, platform TEXT NOT NULL, uid TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
    forum TEXT NOT NULL, topic TEXT NOT NULL, text TEXT NOT NULL, publishedAt TEXT NOT NULL, seenAt INTEGER NOT NULL,
    PRIMARY KEY(owner,platform,kind,ref)
  );
  CREATE INDEX IF NOT EXISTS external_people_events_contact ON external_people_events(owner,platform,uid,seenAt DESC);`;

export const externalPeopleTool: ModelTool = { type: 'function', function: {
  name: 'recall_external_people',
  description: '查自己在贴吧或 X（推特）认得的外部熟人。query 可填昵称、@用户名或稳定平台 UID，platform 用 tieba / twitter。结果分阅读、收到和发出，带原链接，风格只基于实际样本。无记录就说未记到。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', maxLength: 100 }, platform: { type: 'string', enum: ['tieba', 'twitter'] },
  } },
} };

export class ExternalPeople {
  constructor(private root: string, private mock = false, private now = Date.now) {}

  private get filename() {
    return safePath(this.root, this.mock ? 'runtime/data/external-people-mock.sqlite' : 'runtime/data/external-people.sqlite');
  }

  private card(db: DatabaseSync, owner: string, person: Person, compact = false) {
    const recent = db.prepare(`SELECT kind,ref,forum,topic,text,publishedAt,seenAt FROM external_people_events
      WHERE owner=? AND platform=? AND uid=? ORDER BY CASE WHEN kind='read' THEN 1 ELSE 0 END,seenAt DESC,ref LIMIT 12`)
      .all(owner, person.platform, person.uid) as unknown as History[];
    const styleSamples = db.prepare(`SELECT kind,ref,forum,topic,text,publishedAt,seenAt FROM external_people_events
      WHERE owner=? AND platform=? AND uid=? AND kind!='sent' AND text!='' ORDER BY seenAt DESC,ref LIMIT 12`)
      .all(owner, person.platform, person.uid) as unknown as History[];
    const forums = db.prepare(`SELECT forum,MAX(seenAt) AS latest FROM external_people_events
      WHERE owner=? AND platform=? AND uid=? AND forum!='' GROUP BY forum ORDER BY latest DESC,forum LIMIT 5`)
      .all(owner, person.platform, person.uid).map(row => row.forum);
    const interactions = db.prepare(`SELECT kind,COUNT(*) AS n FROM external_people_events
      WHERE owner=? AND platform=? AND uid=? GROUP BY kind`).all(owner, person.platform, person.uid);
    const events = recent.slice(0, compact ? 2 : 6).map(row => ({ ...row, text: row.text.slice(0, compact ? 150 : 380) }));
    return { ...person, forums, counts: Object.fromEntries(interactions.map(row => [row.kind as string, row.n])),
      speakingStyle: styleFrom(styleSamples), events };
  }

  recall(owner: string, input: Record<string, unknown>) {
    const { query = '', platform } = input;
    if (Object.keys(input).some(key => !['query', 'platform'].includes(key)) || typeof query !== 'string' || query.length > 100 ||
        platform !== undefined && platform !== 'tieba' && platform !== 'twitter') throw new FishError('EXTERNAL_PEOPLE_QUERY_INVALID');
    const filename = this.filename, people: ReturnType<ExternalPeople['card']>[] = [];
    if (!fs.existsSync(filename)) return { people, untrusted: true };
    const term = query.trim().replace(/^@/, '').toLowerCase();
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=500');
      const matches = db.prepare(`SELECT platform,uid,name,handle,firstSeenAt,lastSeenAt FROM external_people
        WHERE owner=? AND (? IS NULL OR platform=?) AND (?='' OR uid=? OR instr(lower(name),?)>0 OR instr(lower(handle),?)>0)
        ORDER BY (uid=? OR lower(name)=? OR lower(handle)=?) DESC,lastSeenAt DESC,platform,uid LIMIT 4`)
        .all(owner, platform ?? null, platform ?? null, term, term, term, term, term, term, term) as unknown as Person[];
      for (const person of matches) people.push(this.card(db, owner, person, !term || matches.length > 1));
      return { people, untrusted: true, ...(people.length > 1 ? { notice: '按各自平台与 UID 区分，请勿把同名结果当成同一个人。' } : {}) };
    } finally { db.close(); }
  }

  private observe(owner: string, observations: Observation[], includeKnown = false) {
    if (!observations.length) return [];
    const filename = this.filename;
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=500; PRAGMA journal_mode=WAL;'+schema);
      db.exec('BEGIN IMMEDIATE');
      try {
        const read = db.prepare('SELECT platform,uid,name,handle,firstSeenAt,lastSeenAt FROM external_people WHERE owner=? AND platform=? AND uid=?');
        const event = db.prepare(`INSERT INTO external_people_events VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(owner,platform,kind,ref) DO UPDATE SET text=CASE WHEN length(excluded.text)>length(text) THEN excluded.text ELSE text END,
            topic=COALESCE(NULLIF(topic,''),excluded.topic),forum=COALESCE(NULLIF(forum,''),excluded.forum)
          WHERE uid=excluded.uid AND (length(excluded.text)>length(text) OR topic='' AND excluded.topic!='' OR forum='' AND excluded.forum!='')`);
        const person = db.prepare(`INSERT INTO external_people VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner,platform,uid) DO UPDATE
          SET name=COALESCE(NULLIF(excluded.name,''),name),handle=COALESCE(NULLIF(excluded.handle,''),handle),lastSeenAt=MAX(lastSeenAt,excluded.lastSeenAt)`);
        const known = [], checked = new Set<string>();
        const now = this.now();
        for (const row of observations) {
          const key = row.platform + ':' + row.uid;
          if (includeKnown && known.length < 3 && !checked.has(key)) {
            checked.add(key);
            const existing = read.get(owner, row.platform, row.uid) as Person | undefined;
            if (existing) known.push(this.card(db, owner, existing, true));
          }
          if (event.run(owner, row.platform, row.uid, row.kind, row.ref, row.forum, row.topic, row.text, row.publishedAt, now).changes) {
            person.run(owner, row.platform, row.uid, row.name, row.handle, now, now);
          }
        }
        db.exec('COMMIT');
        return known;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }

  browse<T>(owner: string, page: T) {
    const source = page as any;
    if (source?.status !== 'content' && source?.status !== 'partial') return page;
    const twitterPosts = source[browsedTwitterPosts] as SocialPost[] | undefined;
    const observations: Observation[] = [];
    if (twitterPosts) {
      for (const post of twitterPosts) {
        const row = twitterObservation(post);
        if (row) observations.push(row);
      }
    } else if (source.access?.mode === 'public' && numericId(source.forum?.id)) {
      const threadId = numericId(source.thread?.id) ? source.thread.id : undefined;
      const context = { forum: excerpt(source.forum.name, 100), topic: excerpt(source.thread?.title, 200),
        threadId, ownUid: source.access?.account?.id };
      const candidates = [...rows(source.posts).slice(0, 24), ...(source.parentPost ? [source.parentPost] : []),
        ...(threadId ? [{ ...source.thread, url: `https://tieba.baidu.com/p/${threadId}` }] : [])];
      for (const post of candidates) {
        // Thread previews and a later page-one read share a topic reference.
        const entry = post.floor === 1 && post.parentPostId === null && threadId
          ? { ...post, url: `https://tieba.baidu.com/p/${threadId}` } : post;
        const row = tiebaObservation(entry, context, 'read');
        if (row) observations.push(row);
      }
    }
    const people = this.observe(owner, observations, true);
    return people.length ? { ...page, externalPeople: { people, untrusted: true } } : page;
  }

  incoming<T>(owner: string, page: T) {
    const source = page as any, ownUid = source?.accountId ?? source?.account?.id;
    if (!numericId(ownUid)) return page;
    const observations: Observation[] = [];
    for (const message of [...rows(source.replies).slice(0, 24), ...rows(source.mentions).slice(0, 24)]) {
      if (!numericId(message?.threadId) || !numericId(message?.id)) continue;
      const row = tiebaObservation(message, { ownUid, threadId: message.threadId, forum: excerpt(message.forum, 100),
        topic: excerpt(message.threadTitle, 200) }, 'received');
      if (row) observations.push(row);
    }
    const people = this.observe(owner, observations, true);
    return people.length ? { ...page, externalPeople: { people, untrusted: true } } : page;
  }

  sent(owner: string, result: any) {
    if (result?.published !== true || result.deliveryStatus !== 'confirmed') return;
    const source = result.confirmedReply;
    if (!['reply','comment'].includes(result.action) || !numericId(source?.threadId) || !numericId(source.ownUid)) return;
    const author = result.action === 'comment' ? result.forum?.replyTo : result.forum?.threadAuthor;
    const row = tiebaObservation({ author, url: result.url, text: source.content }, { threadId: source.threadId,
      forum: excerpt(result.forum?.name, 100), topic: '', ownUid: source.ownUid }, 'sent');
    if (row) this.observe(owner, [row]);
  }
}

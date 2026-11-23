import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { TurnContext } from '../src/agent/context.js';
import { ExternalPeople } from '../src/memory/external-people.js';
import { browsePage, type PublicReader } from '../src/search/public-web.js';
import { TiebaPosting } from '../src/tieba/posting.js';
import { fixture, message } from './helpers.js';

const thread = 'https://tieba.baidu.com/p/100';
const owner = '20002';
const forum = { id: '81', name: '大肥鱼' };
const author = { id: '42', name: '湟鱼' };
const post = (id: string, name: typeof author, content: string) => ({ id, author: name, url: `${thread}?pid=${id}`, content });
const page = (...posts: ReturnType<typeof post>[]) => ({ status: 'content', text: '贴吧正文', forum,
  access: { mode: 'public' }, thread: { id: '100', title: '周末练习' }, posts });

test('public encounters and confirmed interactions are separate, persistent and source-scoped', () => {
  const f = fixture();
  const storage = path.join(f.root, 'runtime/data/knowledge.sqlite');
  fs.writeFileSync(storage, 'existing knowledge');
  try {
    const people = new ExternalPeople(f.root);
    const seen = page(post('101', author, '今晚练习吗？'), post('102', author, '打哪张地图？'),
      post('103', { id: '77', name: '湟鱼' }, '同名的另一个人'));
    assert.equal(people.browse(owner, seen), seen);
    const reread = people.browse(owner, seen);
    const viewed = new TurnContext().result('browse_page', 'read1', reread, 0);
    assert.equal(JSON.parse(String(viewed.content)).externalPeople.people[0].uid, '42');
    people.browse(owner, { ...page(post('104', author, '仅登录能读的内容')), access: { mode: 'authenticated' } });
    const notice = { account: { id: '90' }, replies: [
      { ...post('105', author, '一起看录像？'), threadId: '100', forum: forum.name },
      { ...post('106', { id: '90', name: '肥鱼' }, '自己的话'), threadId: '100', forum: forum.name },
    ] };
    people.incoming(owner, notice);
    people.incoming(owner, notice);
    const receipt = { action: 'comment', url: `${thread}?pid=105#107`, forum: { ...forum, replyTo: author },
      confirmedReply: { ownUid: '90', threadId: '100', content: '好，我晚点看。' } };
    people.sent(owner, { ...receipt, published: false, deliveryStatus: 'accepted' });
    assert.equal(people.recall(owner, { query: '42' }).people[0].counts.sent, undefined);
    people.sent(owner, { ...receipt, published: true, deliveryStatus: 'confirmed' });
    people.sent(owner, { ...receipt, published: true, deliveryStatus: 'confirmed' });
    const cards = new ExternalPeople(f.root).recall(owner, { query: '湟鱼' }).people;
    assert.equal(cards.length, 2);
    const first = cards.find(card => card.uid === '42')!;
    assert.deepEqual(first.counts, { read: 2, received: 1, sent: 1 });
    assert.deepEqual(first.forums, [forum.name]);
    assert.ok(first.speakingStyle.signals.includes('常用问句'));
    assert.ok(first.events.some(event => event.kind === 'sent' && event.ref.endsWith('?pid=105#107')));
    assert.deepEqual(people.recall('30003', {}).people, []);
    assert.deepEqual(people.recall(owner, { query: '肥鱼' }).people, []);
    assert.equal(fs.readFileSync(storage, 'utf8'), 'existing knowledge');
    assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='external_people'").get(), undefined);
  } finally { f.cleanup(); }
});

test('X browse keeps the original author and text, and leaves handle-only results unbound', async () => {
  const f = fixture();
  const base = 'https://x.com/i/web/status/200';
  const account = { id: '42', name: '湟鱼', screen_name: 'example_fish' };
  const read: PublicReader = async (url) => ({ url, type: 'application/json', bytes: Buffer.from(JSON.stringify({
    code: 200, status: { id: '200', url: base, author: account, text: '原作者的内容',
      reposted_by: { id: '78', name: '转发的人', screen_name: 'example_repost' },
      quote: { id: '201', url: 'https://x.com/i/web/status/201', author: { name: '只有昵称' }, text: '缺少稳定 ID' },
    },
  })) });
  try {
    const people = new ExternalPeople(f.root);
    people.browse(owner, page(post('101', author, '贴吧的同名账号')));
    const result = await browsePage(base, 0, undefined, read);
    assert.equal(result.status, 'content');
    assert.ok('posts' in result);
    assert.equal(JSON.stringify(result.posts).includes('原作者的内容'), false);
    people.browse(owner, result);
    const x = people.recall(owner, { platform: 'twitter', query: '@example_fish' }).people;
    assert.equal(x.length, 1);
    assert.equal(x[0].events[0].text, '原作者的内容');
    assert.equal(x[0].events[0].ref, base);
    assert.equal(x[0].uid, '42');
    assert.equal(people.recall(owner, { platform: 'twitter' }).people.length, 1);
    assert.equal(people.recall(owner, { query: '42' }).people.length, 2);
  } finally { f.cleanup(); }
});

test('a later Tieba readback adds the reply only after public confirmation', async () => {
  const f = fixture(), posting = new TiebaPosting(f.root), people = new ExternalPeople(f.root);
  const self = { id: '90', name: '肥鱼' }, content = '今晚可以一起看录像。';
  const reply = { ...post('109', self, content), publishedAt: new Date().toISOString() };
  const resultPage = { ...page(reply), thread: { id: '100', title: '周末练习', author } };
  let visible = false;
  const reader = { followed: async () => [forum], read: async () => resultPage,
    publicRead: async () => visible ? resultPage : { status: 'empty', forum, posts: [] } };
  try {
    const accepted = await posting.publish({ action: 'reply', forumId: forum.id, target: thread, content },
      'reply-attempt', self, { mode: 'live', accountId: self.id }, reader, async () => ({ id: '109', url: reply.url }));
    assert.equal(accepted.deliveryStatus, 'accepted');
    people.sent(owner, accepted);
    assert.deepEqual(people.recall(owner, {}).people, []);
    visible = true;
    const verified = await posting.verify('reply-attempt', self, reader);
    assert.equal(verified.deliveryStatus, 'confirmed');
    people.sent(owner, verified);
    const [card] = people.recall(owner, { query: '湟鱼' }).people;
    assert.equal(card.counts.sent, 1);
    assert.equal(card.events[0].text, content);
  } finally { posting.close(); f.cleanup(); }
});

test('the QQ read tool is offered only to the configured owner in private', async () => {
  const f = fixture();
  const app = createApp(f.root, true, { qqTransport: 'onebot', privateUsers: [owner, '30003'], quietHours: [0, 0] });
  try {
    app.explorationState.save({ owner });
    new ExternalPeople(f.root, true).browse(owner, page(post('101', author, '记住我参加过练习。')));
    const visibility: boolean[] = [];
    app.model.complete = async (_group, user, messages, options) => {
      const available = !!options?.tools?.some(tool => tool.function.name === 'recall_external_people');
      visibility.push(available);
      if (user === owner && !messages.some(message => message.role === 'tool')) {
        return { text: '', usage: { input: 40, output: 15 }, tool_calls: [{ id: 'recall', type: 'function',
          function: { name: 'recall_external_people', arguments: '{"query":"湟鱼"}' } }] };
      }
      const last = messages.at(-1);
      if (user === owner) assert.ok(String(last?.content).includes('记住我参加过练习。'));
      return { text: '收到。', usage: { input: 45, output: 10 } };
    };
    for (const user of [owner, '30003']) {
      await app.bot.receive(message('你记得湟鱼吗？', { group: 'private:'+user, user }));
      await app.bot.flush();
    }
    assert.deepEqual(visibility, [true, true, false]);
  } finally {
    await app.exploration.stop();
    await app.bot.stop();
    app.store.close();
    f.cleanup();
  }
});

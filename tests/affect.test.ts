import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Affect, directTone } from '../src/affect.js';
import { createApp } from '../src/app.js';
import { ModelResponseError } from '../src/agent/model.js';
import { MockTransport } from '../src/qq/adapter.js';
import { Store } from '../src/storage/db.js';
import { createWebApp } from '../src/web/app.js';
import { fixture, message } from './helpers.js';

test('mood counts only clear feedback addressed to the companion', () => {
  assert.equal(directTone('肥鱼真棒！', false), 'praise');
  assert.equal(directTone('你这次太笨了。', true), 'blame');
  for (const text of ['转发：你真棒', '“你太蠢了”', '你朋友真厉害', '你不是真没用', '请你说 “你真棒”']) {
    assert.equal(directTone(text, true), undefined, text);
  }
  assert.equal(directTone('你真棒！', false), undefined);
});

test('companion state persists across connections, deduplicates events and recovers independently of knowledge', () => {
  const f = fixture();
  const peer = new Store(f.root);
  const knowledge = path.join(f.root, 'runtime/data/knowledge.sqlite');
  fs.writeFileSync(knowledge, 'existing data');
  const start = Date.now();
  let now = start;
  try {
    const affect = new Affect(f.store, () => now);
    const other = new Affect(peer, () => now);
    affect.configure({moodBaseline: 50, praiseGain: 20, blameLoss: 10, moodHalfLifeHours: 1,
      staminaTokens: 1000, staminaRestMinutes: 5, staminaHalfLifeHours: 1});
    affect.feedback('m1', '你真棒', true);
    assert.equal(other.status().mood, 70);
    other.feedback('m1', '你真棒', true);
    other.feedback('m2', '你这次太笨了', true);
    assert.equal(affect.status().mood, 60);
    affect.spend('request1', {input: 300, output: 200});
    other.spend('request1', {input: 300, output: 200});
    assert.equal(affect.status().stamina, 50);
    now += 5 * 60000;
    assert.equal(other.status().stamina, 50);
    now += 3600000;
    assert.equal(other.status().stamina, 75);
    assert.equal(other.status().mood, 55);
    assert.throws(() => other.configure({moodFloor: 80}), /AFFECT_SETTINGS_INVALID/);
    assert.throws(() => other.configure({stamina: 100}), /AFFECT_SETTINGS_INVALID/);
    assert.equal(other.configure({moodEnabled: false}).mood, null);
    assert.equal(affect.expression(), '');
    assert.equal(fs.readFileSync(knowledge, 'utf8'), 'existing data');
  } finally {
    peer.close();
    f.cleanup();
  }
});

test('existing stamina can grow past 100 and settings accept larger costs and fractional times', () => {
  const f = fixture();
  let now = Date.now();
  try {
    const affect = new Affect(f.store, () => now);
    affect.spend('before', {input: 18000, output: 6000});
    f.store.db.exec("UPDATE companion_affect SET settings=json_remove(settings,'$.staminaCapacity')");
    assert.equal(affect.status().stamina, 80);
    const changed = affect.configure({staminaCapacity: 350, staminaTokens: 50000000, staminaRestMinutes: 3000.5,
      staminaHalfLifeHours: 200.25, moodBaseline: 68.5, moodFloor: 0.25, moodHalfLifeHours: 0.025, moodThreshold: 0.1, praiseGain: 150.25});
    assert.equal(changed.staminaMax, 350);
    assert.equal(changed.stamina, 330);
    assert.equal(changed.settings.moodHalfLifeHours, 0.025);
    assert.equal(affect.expression(), '');
    affect.spend('after', {input: 20000000, output: 5000000});
    assert.equal(affect.status().stamina, 280);
    now += 3000.5 * 60000 + 200.25 * 3600000;
    assert.equal(affect.status().stamina, 315);
    assert.equal(affect.configure({staminaTokens: 1}).settings.staminaTokens, 1);
    assert.throws(() => affect.configure({staminaCapacity: 3.5}), /AFFECT_SETTINGS_INVALID/);
    assert.throws(() => affect.configure({staminaHalfLifeHours: 0}), /AFFECT_SETTINGS_INVALID/);
  } finally { f.cleanup(); }
});

test('WebUI can change mood settings and still completes ordinary chat', async () => {
  const f = fixture();
  const app = createWebApp(f.root, true);
  try {
    assert.deepEqual(app.sessions(), []);
    app.configureCompanion({moodBaseline: 50, praiseGain: 13});
    const session = app.createSession();
    const events: string[] = [];
    await app.chat(session.id, '肥鱼，你真棒！', 'chat', new AbortController().signal, event => events.push(event.type));
    assert.equal(app.status().companion.mood, 63);
    assert.ok(events.includes('answer'));
    assert.equal(app.detail(session.id).turns[0].state, 'completed');
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('QQ chat and exploration keep working while feedback and known usage update state', async () => {
  const f = fixture();
  const app = createApp(f.root, true, {qqTransport: 'onebot', privateUsers: ['20002'], quietHours: [0, 0]});
  try {
    const affect = new Affect(app.store);
    affect.configure({staminaTokens: 1000, staminaRestMinutes: 10});
    const m = message('肥鱼，你真棒！', {group: 'private:20002', user: '20002'});
    await app.bot.receive(m);
    await app.bot.receive(m);
    await app.bot.flush();
    assert.ok(app.transport instanceof MockTransport);
    assert.equal(app.transport.sent.length, 1);
    assert.equal(affect.status().mood, 70);

    app.explorationState.save({enabled: true});
    let fail = false;
    app.model.complete = async () => {
      if (fail) throw new ModelResponseError('DEEPSEEK_TOOL_OUTPUT_TRUNCATED', {input: 100, output: 50}, {});
      return {text: '', usage: {input: 250, output: 50}, tool_calls: [
        {id: 'end', type: 'function', function: {name: 'finish_exploration', arguments: '{}'}},
      ]};
    };
    const ok = app.explorationState.manual().run;
    await app.exploration.tick();
    await app.exploration.idle();
    assert.equal(app.explorationState.get(ok.id).state, 'completed');
    assert.equal(affect.status().stamina, 70);

    fail = true;
    const interrupted = app.explorationState.manual().run;
    await app.exploration.tick();
    await app.exploration.idle();
    assert.equal(app.explorationState.get(interrupted.id).state, 'failed');
    // The failed tool decision and failed closing request each returned billable usage.
    assert.equal(affect.status().stamina, 40);
  } finally {
    await app.exploration.stop();
    await app.bot.stop();
    app.store.close();
    f.cleanup();
  }
});

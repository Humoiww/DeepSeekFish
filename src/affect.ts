import { createHash } from 'node:crypto';
import type { Store } from './storage/db.js';
import { FishError, type Usage } from './types.js';

type Tone = 'praise' | 'blame';
type MoodInfluence = 'off' | 'changes' | 'current';

const defaults = {
  moodEnabled: true, moodInfluence: 'changes' as MoodInfluence,
  moodBaseline: 65, moodFloor: 0, praiseGain: 5, blameLoss: 7, moodHalfLifeHours: 8, moodThreshold: 5,
  staminaEnabled: true, staminaCapacity: 100, staminaTokens: 120000, staminaRestMinutes: 10, staminaHalfLifeHours: 3,
};
type Settings = typeof defaults;
type State = { mood: number | null; moodAt: number; stamina: number; staminaAt: number; workedAt: number };
const fishNames = ['大肥鱼', '肥鱼', '鲸酱', '小鱼'];
const hour = 3600000;
const clamp = (n: number, floor = 0) => Math.min(100, Math.max(floor, n));
const recover = (n: number, baseline: number, elapsed: number, halfLife: number) =>
  baseline + (n - baseline) * 2 ** (-Math.max(0, elapsed) / hour / halfLife);

function within(value: number, min: number, max: number) {
  return Number.isFinite(value) && value >= min && value <= max;
}

export class AffectSettingsError extends FishError {
  constructor(readonly detail: string) { super('AFFECT_SETTINGS_INVALID'); }
}

function validate(settings: Settings) {
  if (typeof settings.moodEnabled !== 'boolean' || typeof settings.staminaEnabled !== 'boolean' ||
      !['off', 'changes', 'current'].includes(settings.moodInfluence)) throw new AffectSettingsError('请选择有效的开关和心情表现方式。');
  if (!within(settings.moodBaseline, 0, 100)) throw new AffectSettingsError('平常心情应在 0 到 100 分之间。');
  if (!within(settings.moodFloor, 0, settings.moodBaseline)) throw new AffectSettingsError('最低心情应在 0 分和平常心情之间。');
  for (const [value, name] of [[settings.praiseGain, '夸奖增加'], [settings.blameLoss, '责骂减少'],
    [settings.moodThreshold, '明显变化'], [settings.staminaRestMinutes, '开始恢复前的休息时间']] as const) {
    if (!Number.isFinite(value) || value < 0) throw new AffectSettingsError(`${name}请填 0 或正数。`);
  }
  for (const [value, name] of [[settings.moodHalfLifeHours, '心情平复时间'], [settings.staminaHalfLifeHours, '耐力恢复时间']] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new AffectSettingsError(`${name}请填大于 0 的小时数。`);
  }
  if (!Number.isSafeInteger(settings.staminaCapacity) || settings.staminaCapacity < 1) throw new AffectSettingsError('耐力上限请填可精确表示的正整数。');
  if (!Number.isSafeInteger(settings.staminaTokens) || settings.staminaTokens < 1) throw new AffectSettingsError('每消耗 100 点所需的 Token 请填可精确表示的正整数。');
}

/** Interpret only clear, direct feedback. Callers supply the original human input. */
export function directTone(text: string, addressed: boolean, names: readonly string[] = []): Tone | undefined {
  if (text.length > 2000) return;
  let content = text.normalize('NFKC').trim();
  if (!content || /```|^\s*>|\bCQ:|\[(?:转发|引用)|(?:转发|引用|转述|复述|举例|比如|例如|原话|原文|翻译|假设|假如|提示词|关键词|他说|她说|别人说|这句|请你说|骂你一句|夸你一句)/mu.test(content)) return;
  content = content.replace(/“[^”]*”|「[^」]*」|『[^』]*』|《[^》]*》|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|https?:\/\/\S+/gu, '').trim();
  const name = [...fishNames, ...names].find(item => {
    const prefix = item.normalize('NFKC');
    return prefix && content.startsWith(prefix) && /^(?:[\s,，:：、!！]|你|真|太|好|很|辛苦)/u.test(content.slice(prefix.length));
  });
  if (!addressed && !name) return;
  if (name) {
    const words = content.slice(name.normalize('NFKC').length).replace(/^[\s,，:：、!！]+/u, '');
    content = /^(?:真|太|好|很)/u.test(words) ? '你'+words : words;
  }
  if (/[@?？]|^(?:如果|并非|不是说|我没说|不要说|别说|听说|你(?:不是|没有|并不))|(?:你朋友|你同事|你家\S{1,8}|你说的那个人)/u.test(content)) return;
  if (/^(?:你.{0,12}(?:真差劲|真蠢|太蠢|太笨|真笨|笨蛋|傻瓜|蠢货|废物|垃圾|傻逼|没用|又搞砸了|真不靠谱|真不行)|笨蛋|蠢货|废物|傻逼)(?:[啊呀啦了哈呢。!,，！\s]|$)/u.test(content)) return 'blame';
  if (/(?:并不|不是|不算|不够|一点也不|哪有|根本不|谈不上).{0,6}(?:棒|厉害|靠谱|喜欢|感谢)/u.test(content)) return;
  if (/^(?:你(?:今天|这次|这回|做得|答得|说得|表现得|可|也|真的|真是|真|太|好|很|可真|可太){0,5}(?:棒|厉害|靠谱|贴心|优秀|可爱|乖|牛)|你(?:做得|答得|说得|表现得)(?:真|很|挺|特别)?好|谢谢你|感谢你|我喜欢你|好棒|太棒|厉害|辛苦了|干得漂亮)(?:[啊呀啦了呢嘛哦哈。!,，！\s]|$)/u.test(content)) return 'praise';
}

export class Affect {
  constructor(private store: Store, private now = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_affect (
      id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companion_affect_events (id TEXT PRIMARY KEY);`);
  }

  private read() {
    const row = this.store.db.prepare('SELECT settings,state FROM companion_affect WHERE id=1').get() as
      { settings: string; state: string } | undefined;
    const at = this.now();
    return {
      settings: { ...defaults, ...(row ? JSON.parse(row.settings) : {}) } as Settings,
      state: row ? JSON.parse(row.state) as State : { mood: null, moodAt: at, stamina: defaults.staminaCapacity, staminaAt: at, workedAt: 0 },
      at,
    };
  }

  private save(settings: Settings, state: State) {
    this.store.db.prepare(`INSERT INTO companion_affect VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET settings=excluded.settings,state=excluded.state`)
      .run(JSON.stringify(settings), JSON.stringify(state));
  }

  private project(settings: Settings, state: State, at: number) {
    const restUntil = state.workedAt + settings.staminaRestMinutes * 60000;
    return {
      mood: clamp(recover(state.mood ?? settings.moodBaseline, settings.moodBaseline,
        at - state.moodAt, settings.moodHalfLifeHours), settings.moodFloor),
      stamina: recover(state.stamina, settings.staminaCapacity, at - Math.max(state.staminaAt, restUntil), settings.staminaHalfLifeHours),
    };
  }

  status() {
    const { settings, state, at } = this.read();
    const values = this.project(settings, state, at);
    return { settings, mood: settings.moodEnabled ? Math.round(values.mood) : null,
      stamina: settings.staminaEnabled ? Math.round(values.stamina) : null, staminaMax: settings.staminaCapacity };
  }

  configure(input: Record<string, unknown>) {
    if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new FishError('AFFECT_SETTINGS_INVALID');
    return this.store.transaction(() => {
      const { settings, state, at } = this.read();
      const next = { ...settings, ...input };
      validate(next);
      const values = this.project(settings, state, at);
      const spent = Math.max(0, settings.staminaCapacity - values.stamina);
      this.save(next, { ...state, mood: state.mood === null ? null : clamp(values.mood, next.moodFloor),
        moodAt: at, stamina: Math.max(0, next.staminaCapacity - spent), staminaAt: at });
      return this.status();
    });
  }

  private event(key: string) {
    const hash = createHash('sha256').update(key).digest('hex');
    return this.store.db.prepare('INSERT OR IGNORE INTO companion_affect_events VALUES (?)').run(hash).changes > 0;
  }

  feedback(source: string, text: string, addressed: boolean, names?: readonly string[]) {
    const tone = directTone(text, addressed, names);
    if (!tone) return;
    this.store.transaction(() => {
      const { settings, state, at } = this.read();
      if (!settings.moodEnabled || !this.event('mood:'+source)) return;
      const { mood } = this.project(settings, state, at);
      const delta = tone === 'praise' ? settings.praiseGain : -settings.blameLoss;
      this.save(settings, { ...state, mood: clamp(mood + delta, settings.moodFloor), moodAt: at });
    });
  }

  spend(request: string, usage: Usage) {
    const { input, output } = usage;
    const total = input + output;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(total) || input < 0 || output < 0 || total === 0) return;
    this.store.transaction(() => {
      const { settings, state, at } = this.read();
      if (!settings.staminaEnabled || !this.event('stamina:'+request)) return;
      const { stamina } = this.project(settings, state, at);
      this.save(settings, { ...state, stamina: Math.max(0, stamina - total / settings.staminaTokens * 100),
        staminaAt: at, workedAt: at });
    });
  }

  expression() {
    const { settings, state, at } = this.read();
    if (!settings.moodEnabled || settings.moodInfluence === 'off') return '';
    const deviation = this.project(settings, state, at).mood - settings.moodBaseline;
    if (settings.moodInfluence === 'changes' && Math.abs(deviation) < settings.moodThreshold) return '';
    const tone = deviation > 0 ? '轻松愉快' : deviation < 0 ? '稍显低落' : '平和';
    return `肥鱼当前心情${tone}。可轻微调整用词和语气，优先自然地回应当下话题。`;
  }
}

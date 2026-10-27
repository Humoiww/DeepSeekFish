import type { Config } from '../config.js';
import type { Message, Reason } from '../types.js';
import { Ledger, dayKey } from '../budget/ledger.js';

export class SocialGate {
  constructor(private cfg: () => Config, private ledger: Ledger, private random = Math.random) {}
  topic(text: string): string {
    return this.cfg().interests.find(w => text.toLowerCase().includes(w.toLowerCase())) ?? 'general';
  }
  decide(messages: Message[], now = Date.now(), activityMessages = messages): Reason | undefined {
    if (!messages.length) return;
    const c=this.cfg(), last=messages.at(-1)!;
    if (!c.enabled || now-last.at>120000) return;
    if (messages.some(m=>m.mentioned)) return 'mention';
    if (messages.some(m=>c.names.some(n=>m.text.toLowerCase().includes(n.toLowerCase())))) return 'name';
    if (c.autoReply) return 'auto';
    if (!c.autonomous) return;
    const hour=new Date(now+8*3600000).getUTCHours(); const [start,end]=c.quietHours;
    if (start!==end && (start<end ? hour>=start&&hour<end : hour>=start||hour<end)) return;
    const prev=Number(this.ledger.store.getMeta('lastSpoke:'+last.group)??0);
    if (now-prev<c.cooldownMs || this.ledger.value('interjection','g:'+last.group,dayKey(now))>=c.dailyInterjections) return;
    const recent=activityMessages.filter(m=>now-m.at<=90000);
    if (recent.length<2) return; // no idle timer/API polling; observe actual activity first
    const topic=this.topic(last.text);
    const same=recent.filter(m=>this.topic(m.text)===topic);
    if (same.length<2) return; // avoid replying to a topic that has just changed
    const chance=c.probability*c.activity;
    if (topic!=='general' && this.random()<chance) return 'interest';
    if (/[?？]|为什么|居然|笑死/.test(last.text) && this.random()<chance/2) return 'opportunity';
    if (this.random()<chance/20) return 'random';
  }
  record(group: string): void { this.ledger.store.setMeta('lastSpoke:'+group,String(Date.now())); }
}

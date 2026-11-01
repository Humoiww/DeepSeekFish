import type { Message } from '../types.js';

/** Local event filter only: no model, network, image decoding or history scan. */
export function groupTrigger(message:Pick<Message,'mentioned'|'text'>,keywords:string[]):'mention'|'name'|undefined{
  if(message.mentioned)return 'mention';
  const text=message.text.toLowerCase();
  if(keywords.some(word=>word.trim()&&text.includes(word.trim().toLowerCase())))return 'name';
}

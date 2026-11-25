import type {ChargeReceipt} from './budget/pricing.js';
import type {ApiProvider} from './config.js';
export interface QQAttachment {
  kind:'file'|'video'|'audio'|'image'; position:number; name?:string; size?:number;
  fileId?:string; mediaKey?:string; busId?:number; url?:string;
}
export interface Message {
  id: string; group: string; user: string; text: string; at: number;
  mentioned: boolean; bot?: boolean; event: 'mention' | 'ordinary';
  // Names observed on this message, not an account key or an authorization role.
  sender?: {nickname?:string;card?:string};
  /** Native ID of the message quoted by this QQ message. */
  quotedMessageId?: string;
  replyTo?: string;
  /** Direct text from the authenticated OneBot event, before conversation formatting. */
  oneBotDirect?: {self:string;text:string};
  // Transport-only download handles; never archive URLs or expose them to models.
  images?: {url?:string;file?:string;stickerHint:boolean}[];
  /** Native attachment handles are consumed by the QQ catalog before archiving. */
  qqAccount?: string;
  attachments?: QQAttachment[];
  forwards?: {id?:string;content?:unknown[];title?:string}[];
}
export type Reason = 'mention' | 'name' | 'auto' | 'interest' | 'opportunity' | 'random';
export interface Usage { input: number; output: number; cachedInput?:number; uncachedInput?:number }
export interface ToolCall {id:string;type:'function';function:{name:string;arguments:string}}
export interface ModelTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export type ModelRoute={provider:ApiProvider;model:string;fallbackFrom?:ApiProvider};
export type ModelReservation={id:string;reservedTokens:number;reservedCny?:number;request?:unknown;route?:ModelRoute};
export interface CompletionOptions {tools?:ModelTool[];toolChoice?:string;requireTool?:boolean;final?:boolean;maxOutputTokens?:number|null;signal?:AbortSignal;onReservation?:(reservation:ModelReservation)=>void;promptChannel?:import('./prompt-record.js').PromptChannel}
export interface ModelResult { text: string; usage: Usage; tool_calls?:ToolCall[];finishReason?:string;responseId?:string;billing?:ChargeReceipt;route?:ModelRoute }
export interface Model {
  readonly kind: string;
  complete(messages: ChatMessage[], maxTokens: number,options?:CompletionOptions): Promise<ModelResult>;
}
export type ChatPart={type:'text';text:string}|{type:'image_url';image_url:{url:string;detail?:'low'|'high'|'auto'}};
export interface ChatMessage { role: 'system' | 'user' | 'assistant'|'tool'; content: string|ChatPart[];tool_calls?:ToolCall[];tool_call_id?:string }
export interface Transport {
  status: string;
  identity?():Promise<{userId:string}>;
  quotedContext?(conversation:string,messageId:string):Promise<{target:Message;before:Message[];after:Message[];source?:'qq_history'|'qq_message'}|undefined>;
  send(message: Message, text: string): Promise<{messageId:string}|void>;
  file(message: Message, path: string): Promise<void>;
  image?(message:Message,original:Buffer):Promise<{messageId?:string}>;
  attachment?(message:Message,original:Buffer,name:string):Promise<{messageId?:string}>;
  imageReceipt?(message:Message,fingerprint:string,since:number):Promise<string|undefined>;
  meme?(message:Message,original:Buffer):Promise<void>;
  stop(): void;
}
export class FishError extends Error {
  constructor(public code: string) { super(code); }
}
export function codeOf(e: unknown): string { return e instanceof FishError ? e.code : 'INTERNAL_ERROR'; }

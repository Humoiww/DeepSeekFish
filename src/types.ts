export interface Message {
  id: string; group: string; user: string; text: string; at: number;
  mentioned: boolean; bot?: boolean; event: 'mention' | 'ordinary';
}
export type Reason = 'mention' | 'name' | 'auto' | 'interest' | 'opportunity' | 'random';
export interface Usage { input: number; output: number }
export interface ToolCall {id:string;type:'function';function:{name:string;arguments:string}}
export interface ModelTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export interface CompletionOptions {tools?:ModelTool[];toolChoice?:string;final?:boolean;signal?:AbortSignal}
export interface ModelResult { text: string; usage: Usage; tool_calls?:ToolCall[];finishReason?:string }
export interface Model {
  readonly kind: string;
  complete(messages: ChatMessage[], maxTokens: number,options?:CompletionOptions): Promise<ModelResult>;
}
export type ChatPart={type:'text';text:string}|{type:'image_url';image_url:{url:string;detail?:'low'|'high'|'auto'}};
export interface ChatMessage { role: 'system' | 'user' | 'assistant'|'tool'; content: string|ChatPart[];tool_calls?:ToolCall[];tool_call_id?:string }
export interface Transport {
  status: string;
  send(message: Message, text: string): Promise<void>;
  file(message: Message, path: string): Promise<void>;
  stop(): void;
}
export class FishError extends Error {
  constructor(public code: string) { super(code); }
}
export function codeOf(e: unknown): string { return e instanceof FishError ? e.code : 'INTERNAL_ERROR'; }

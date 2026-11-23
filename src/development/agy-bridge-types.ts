export const bridgeRoots=['src','assets','docs','tests','third_party','prompts','personas'];
export const maxChanges=250;
export const maxFileBytes=40*1024*1024;
export const maxChangeBytes=64*1024*1024;
export const maxBridgeResponse=90*1024*1024;
export const taskIdPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const conversationPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function allowedBridgePath(name:unknown): name is string {
 if(typeof name!=='string'||[...name].length>250)return false;
 const parts=name.split('/');
 return parts.length>=2&&bridgeRoots.includes(parts[0])&&
  parts.every(part=>!part.startsWith('.')&&/^[\p{L}\p{N}_. @+-]+$/u.test(part))&&
  !(parts[0]==='src'&&parts[1]==='development');
}

export type AgyStage='triage'|'codex'|'review'|'codex_retry'|'verify';
export type AgyMode='development'|'chain_discussion';
export const maxRecordBytes=256*1024;
export const bridgeRecordKinds=['agy','codex','patch'] as const;
export type BridgeRecordKind=typeof bridgeRecordKinds[number];
export const isBridgeRecordKind=(value:unknown):value is BridgeRecordKind=>
 typeof value==='string'&&bridgeRecordKinds.some(kind=>kind===value);
export type BridgeEvent={at?:number;role:string;title:string;text?:string;exitCode?:number};
export type BridgeRecordSummary={kind:BridgeRecordKind;id:string;updatedAt:number;bytes:number;taskId?:string};
export type BridgeRecord={ok:true;record:BridgeRecordSummary;steps:BridgeEvent[];patch?:string;truncated?:boolean};
export type AgyConversation={conversationId:string;updatedAt:number};
export type AgyDelivery={text:string;at:number};
export type AgyStatus={
 ok:true;busy:boolean;activeTaskId?:string;stage?:AgyStage;startedAt?:number;recentEvents?:BridgeEvent[];mainConversation?:AgyConversation;agyBin:string;codexSocket:string;
};
export type AgyCancelRequest={taskId?:string};
export type AgyCancelResult={ok:true;cancelled:boolean;taskId?:string};
export type AgyTurnRequest={
 taskId:string;mode:AgyMode;brief:string;ownerMessage:string;installedRevision:string;
 repairReason?:string;lastDelivery?:AgyDelivery;
};
export type AgyChange={name:string;sha256:string|null;contentBase64:string|null};
export type CodexSpec={
 goal:string;scopeFiles:string[];requirements:string[];invariants:string[];verificationCommands:string[];
};
export type Triage={
 decision:'reply_only'|'need_clarification'|'delegate_codex';replyToFeiyu:string;
 alreadyImplemented?:boolean;codexSpec?:CodexSpec;
};
export type Review={
 verdict:'approve'|'retry_codex'|'escalate_to_owner';retryFeedback?:string;replyToFeiyu:string;
};
export type AgyTurnResult={
 ok:true;taskId:string;outcome:'reply_only'|'need_clarification'|'approved'|'escalated';
 replyToFeiyu:string;conversationId?:string;codexSessionId?:string;codexRetries:number;
 summary:{decision:Triage['decision'];verdict?:Review['verdict'];changedFiles?:string[];
  buildPassed?:boolean;testPassed?:boolean;patchArchive?:string};
 changes:AgyChange[];
};

type Schema={
 type:'object'|'array'|'string'|'boolean'|'integer';additionalProperties?:false;required?:string[];
 properties?:Record<string,Schema>;items?:Schema;enum?:string[];
 minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;
};
const string=(maxLength:number,minLength=1):Schema=>({type:'string',minLength,maxLength});
const enumOf=(...values:string[]):Schema=>({type:'string',enum:values});
const array=(maxItems:number,minItems=0):Schema=>({type:'array',minItems,maxItems,items:string(2000)});
const object=(properties:Record<string,Schema>,required:string[]):Schema=>({type:'object',additionalProperties:false,properties,required});

export const triageSchema=object({
 decision:enumOf('reply_only','need_clarification','delegate_codex'),
 replyToFeiyu:string(4000),
 alreadyImplemented:{type:'boolean'},
 codexSpec:object({goal:string(2000),scopeFiles:array(40),requirements:array(20,1),
  invariants:array(15),verificationCommands:array(6,1)},
 ['goal','scopeFiles','requirements','invariants','verificationCommands']),
},['decision','replyToFeiyu']);

export const reviewSchema=object({
 verdict:enumOf('approve','retry_codex','escalate_to_owner'),
 retryFeedback:string(3000,0),
 replyToFeiyu:string(4000),
},['verdict','replyToFeiyu']);

export const turnSchema=object({
 taskId:string(36),mode:enumOf('development','chain_discussion'),brief:string(8000),ownerMessage:string(8000,0),
 installedRevision:string(64),repairReason:string(8000),lastDelivery:object({text:string(600),at:{type:'integer'}},['text','at']),
},['taskId','mode','brief','ownerMessage','installedRevision']);

export const resetConversationSchema=object({},[]);
export const cancelSchema=object({taskId:string(36)},[]);

export function matchesSchema(schema:Schema,value:unknown): boolean {
 switch(schema.type){
  case 'object': {
   if(value===null||typeof value!=='object'||Array.isArray(value))return false;
   const fields=value as Record<string,unknown>,properties=schema.properties??{};
   return schema.required?.every(key=>Object.hasOwn(fields,key))!==false&&
    Object.entries(fields).every(([key,field])=>Object.hasOwn(properties,key)&&matchesSchema(properties[key],field));
  }
  case 'array':
   return Array.isArray(value)&&value.length>=(schema.minItems??0)&&value.length<=(schema.maxItems??Infinity)&&
    value.every(item=>matchesSchema(schema.items!,item));
  case 'string':
   return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity)&&
    (schema.minLength!==1||!!value.trim())&&(!schema.enum||schema.enum.includes(value));
  case 'integer':
   return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  case 'boolean':
   return typeof value==='boolean';
 }
}

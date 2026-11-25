import {randomUUID} from 'node:crypto';
import {defaults,isProvider,providerCredential,providerIds,providerKeySlots,saveProviderCredential,validConnectionPreset,validateConfig,
 type ApiProvider,type Config,type ConnectionPreset} from '../config.js';
import type {Store} from '../storage/db.js';
import {FishError} from '../types.js';

type Selection=Pick<ConnectionPreset,'provider'|'model'|'maxOutputTokens'|'keySlot'|'disableThinking'>;
type ConnectionState={
 selection?:Selection; previous?:Partial<Record<ApiProvider,Selection>>; presets?:ConnectionPreset[];
 activePresetId?:string|null; usdToCny?:number;
};
const meta='model-connection';
export const defaultOpenCodeModel='glm-5.3-flash';
const selection=(cfg:Config):Selection=>({provider:cfg.provider,model:cfg.model,maxOutputTokens:cfg.maxOutputTokens,
 keySlot:cfg.keySlot??cfg.provider,disableThinking:cfg.disableThinking!==false});
const presetSelection=({provider,model,maxOutputTokens,keySlot,disableThinking}:ConnectionPreset):Selection=>
 ({provider,model,maxOutputTokens,keySlot,disableThinking:disableThinking!==false});
const read=(store:Store):ConnectionState=>JSON.parse(store.getMeta(meta)??'{}');

function project(base:Config,state:ConnectionState){
 const connectionPresets=state.presets??base.connectionPresets??[];
 const activePresetId=state.activePresetId===null?undefined:state.activePresetId??base.activePresetId;
 const active=connectionPresets.find(preset=>preset.id===activePresetId);
 return validateConfig({...base,...state.selection,...(active?presetSelection(active):{}),connectionPresets,activePresetId,
  usdToCny:state.usdToCny??base.usdToCny});
}

export const liveModelConfig=(base:Config,store:Store)=>project(base,read(store));

export class ConnectionProfiles {
 constructor(private root:string,private store:Store,private cfg:()=>Config){}

 private forProvider(current:Config,state:ConnectionState,provider:ApiProvider):Selection {
  if(provider===current.provider)return selection(current);
  const remembered=state.previous?.[provider]??{provider,model:provider==='deepseek'?defaults.model:defaultOpenCodeModel,
   maxOutputTokens:current.maxOutputTokens,keySlot:provider};
  return {...remembered,disableThinking:remembered.disableThinking!==false};
 }

 status(){
  const cfg=this.cfg(),state=read(this.store),presets=cfg.connectionPresets??[];
  return Object.fromEntries(providerIds.map(provider=>{
   const remembered=this.forProvider(cfg,state,provider);
   const slots=[...new Set([provider,remembered.keySlot,...providerKeySlots(this.root,provider),
    ...presets.filter(p=>p.provider===provider).map(p=>p.keySlot)])];
   const keys=Object.fromEntries(slots.map(slot=>[slot,{configured:!!providerCredential(this.root,provider,slot)}]));
   return [provider,{...remembered,configured:keys[remembered.keySlot].configured,keys}];
  })) as Record<ApiProvider,Selection&{configured:boolean;keys:Record<string,{configured:boolean}>}>;
 }

 configure(input:Record<string,unknown>){
  const current=this.cfg(),state=read(this.store);
  const provider=input.provider===undefined?current.provider:input.provider;
  if(!isProvider(provider))throw new FishError('INVALID_PROVIDER');
  const previous=this.forProvider(current,state,provider);
  const draft={...previous,provider,
   model:input.model===undefined?previous.model:input.model,
   maxOutputTokens:input.maxOutputTokens===undefined?previous.maxOutputTokens:input.maxOutputTokens,
   disableThinking:input.disableThinking===undefined?previous.disableThinking:input.disableThinking,
   keySlot:input.keySlot===undefined?previous.keySlot:input.keySlot} as Selection;
  const changed=Object.keys(draft).some(key=>draft[key as keyof Selection]!==selection(current)[key as keyof Selection]);
  const active=input.activePresetId!==undefined?input.activePresetId:changed?null:current.activePresetId;
  if(active!=null&&typeof active!=='string')throw new FishError('INVALID_CONNECTION_PRESET');
  const next:ConnectionState={...state,activePresetId:active as string|null|undefined,
   usdToCny:input.usdToCny===undefined?current.usdToCny:input.usdToCny as number};
  // Validate the draft as well as the selected preset. Empty key updates are no-ops.
  validateConfig({...current,...draft,activePresetId:undefined,usdToCny:next.usdToCny});
  const selected=project(current,{...next,selection:draft});
  if(input.apiKey!==undefined){
   const keyProvider=input.apiKeyProvider===undefined?selected.provider:input.apiKeyProvider;
   if(!isProvider(keyProvider))throw new FishError('INVALID_PROVIDER');
   const keySlot=input.apiKeySlot===undefined?(keyProvider===selected.provider?selected.keySlot??keyProvider:keyProvider):input.apiKeySlot;
   if(typeof keySlot!=='string')throw new FishError('INVALID_KEY_SLOT');
   saveProviderCredential(this.root,keyProvider,keySlot,input.apiKey);
  }
  if(changed||input.provider!==undefined||input.activePresetId!==undefined){
   next.selection=selection(selected);
   next.previous={...state.previous,[current.provider]:selection(current),[selected.provider]:selection(selected)};
  }
  if(changed||['provider','activePresetId','usdToCny'].some(key=>Object.hasOwn(input,key))){
   this.store.setMeta(meta,JSON.stringify(next));
  }
 }

 save(input:Record<string,unknown>){
  if(Object.keys(input).some(k=>!['id','name','provider','model','maxOutputTokens','keySlot','disableThinking','apiKey'].includes(k))){
   throw new FishError('INVALID_CONNECTION_PRESET');
  }
  const current=this.cfg(),state=read(this.store),presets=current.connectionPresets??[];
  const id=input.id??randomUUID();
  const existing=presets.find(preset=>preset.id===input.id);
  if(input.id!==undefined&&!existing)throw new FishError('CONNECTION_PRESET_NOT_FOUND');
  const {apiKey,...fields}=input;
  const preset={...fields,id,name:typeof fields.name==='string'?fields.name.trim():fields.name,
   disableThinking:fields.disableThinking===undefined?existing?.disableThinking??true:fields.disableThinking};
  if(!validConnectionPreset(preset))throw new FishError('INVALID_CONNECTION_PRESET');
  const selected=presetSelection(preset);
  const next:ConnectionState={...state,selection:selected,activePresetId:preset.id,
   presets:[...presets.filter(item=>item.id!==id),preset],
   previous:{...state.previous,[current.provider]:selection(current),[preset.provider]:selected}};
  project(current,next);
  if(apiKey!==undefined)saveProviderCredential(this.root,preset.provider,preset.keySlot,apiKey);
  this.store.setMeta(meta,JSON.stringify(next));
 }

 delete(input:Record<string,unknown>){
  if(Object.keys(input).length!==1||typeof input.id!=='string')throw new FishError('INVALID_CONNECTION_PRESET');
  const current=this.cfg(),state=read(this.store),presets=current.connectionPresets??[];
  if(!presets.some(p=>p.id===input.id))throw new FishError('CONNECTION_PRESET_NOT_FOUND');
  const next={...state,presets:presets.filter(p=>p.id!==input.id),
   activePresetId:current.activePresetId===input.id?null:current.activePresetId??null,selection:selection(current)};
  project(current,next);
  this.store.setMeta(meta,JSON.stringify(next));
 }
}

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Tokenizer } from '@huggingface/tokenizers';
import { projectRoot } from '../config.js';
import { safePath,makeDir } from '../paths.js';
import { FishError,type ModelTool } from '../types.js';
export const KNOWLEDGE_LIMIT=5000;
let tokenizer:Tokenizer|undefined;
export function knowledgeTokens(text:string):number{
  if(!text)return 0;
  if(!tokenizer){
    const root=projectRoot();
    tokenizer=new Tokenizer(JSON.parse(fs.readFileSync(safePath(root,'runtime/tools/tokenizer/tokenizer.json'),'utf8')),JSON.parse(fs.readFileSync(safePath(root,'runtime/tools/tokenizer/tokenizer_config.json'),'utf8')));
  }
  return tokenizer.encode(text,{add_special_tokens:false}).ids.length;
}
interface Line {id:number;text:string}
function snapshot(lines:Line[],version:number){
  const content=lines.map(line=>line.id+'. '+line.text).join('\n'),tokens=knowledgeTokens(content);
  return {version,lines,content,tokens,limit:KNOWLEDGE_LIMIT,remaining:KNOWLEDGE_LIMIT-tokens};
}
function read(db:DatabaseSync){return snapshot(db.prepare('SELECT id,text FROM knowledge ORDER BY id').all() as unknown as Line[],Number((db.prepare('SELECT version FROM knowledge_version').get() as any).version));}
export function knowledgeSnapshot(root:string){
  const file=safePath(root,'runtime/data/knowledge.sqlite');if(!fs.existsSync(file))return snapshot([],0);
  const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000;BEGIN');if(!db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_version'").get())return snapshot([],0);return read(db);}finally{db.close();}
}
export function knowledgePrompt(root:string){const s=knowledgeSnapshot(root);return `知识库（${s.tokens}/${s.limit} token，版本 ${s.version}；按条后台维护；维护操作和用量不作为QQ聊天内容）\n${s.content||'（空）'}`;}
export function updateKnowledge(root:string,args:any){
  if(!args||!Number.isSafeInteger(args.version)||!Array.isArray(args.changes)||Object.keys(args).some(k=>!['version','changes'].includes(k)))throw new FishError('KNOWLEDGE_UPDATE_INVALID');
  makeDir(root,'runtime/data');const file=safePath(root,'runtime/data/knowledge.sqlite'),db=new DatabaseSync(file);
  try{
    fs.chmodSync(file,0o600);db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS knowledge(id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_version(version INTEGER NOT NULL);
      INSERT INTO knowledge_version SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM knowledge_version);`);
    const before=read(db);
    if(args.version!==before.version){db.exec('ROLLBACK');return {ok:false,error:'KNOWLEDGE_CHANGED',message:'知识库已更新，请按当前版本修改。',...before};}
    for(const c of args.changes){
      if(!c||!['add','replace','delete'].includes(c.action)||Object.keys(c).some(k=>!['action','id','text'].includes(k))||
        (c.action!=='delete'&&typeof c.text!=='string')||(c.action!=='add'&&(!Number.isSafeInteger(c.id)||c.id<1)))throw new FishError('KNOWLEDGE_UPDATE_INVALID');
      if(c.action==='add')db.prepare('INSERT INTO knowledge(text) VALUES (?)').run(c.text);
      else if(c.action==='replace'){if(!db.prepare('UPDATE knowledge SET text=? WHERE id=?').run(c.text,c.id).changes)throw new FishError('KNOWLEDGE_LINE_MISSING');}
      else if(!db.prepare('DELETE FROM knowledge WHERE id=?').run(c.id).changes)throw new FishError('KNOWLEDGE_LINE_MISSING');
    }
    db.exec('UPDATE knowledge_version SET version=version+1');const after=read(db);
    if(after.tokens>KNOWLEDGE_LIMIT){db.exec('ROLLBACK');return {ok:false,error:'KNOWLEDGE_TOO_LONG',message:'太长了，删几条或精简后再更新。',attemptedTokens:after.tokens,...before};}
    db.exec('COMMIT');return {ok:true,visibility:'background',next:'继续原来的聊天话题，不播报知识库维护。',...after};
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
export const knowledgeTools:ModelTool[]=[
  {type:'function',function:{name:'get_knowledge',description:'读取自己的知识库和当前 token 数。',parameters:{type:'object',properties:{},additionalProperties:false}}},
  {type:'function',function:{name:'update_knowledge',description:'后台按条添加、替换或删除知识，自主决定内容与取舍；仅总长不得超过5000 token。结果用于后续思考，不发给聊天对象。',parameters:{type:'object',properties:{version:{type:'integer'},changes:{type:'array',items:{type:'object',properties:{action:{type:'string',enum:['add','replace','delete']},id:{type:'integer',description:'替换或删除的条目ID'},text:{type:'string',description:'添加或替换的内容'}},required:['action'],additionalProperties:false}}},required:['version','changes'],additionalProperties:false}}},
];

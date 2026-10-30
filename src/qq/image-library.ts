import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { safePath } from '../paths.js';
import { Store } from '../storage/db.js';
import { FishError } from '../types.js';
import { dayStart } from '../memory/journal.js';
import { resolveCharacterReference } from '../image/character-reference.js';
import { readReference,type SelectedReference } from '../image/references.js';

export type ImageSource='all'|'character'|'avatar'|'qzone'|'generated';
export interface LibraryImage {id:string;source:Exclude<ImageSource,'all'>;label:string;postId?:string;position?:number;observedAt?:number;path:string}
export class QQImageLibrary{
  constructor(private root:string,private broker:Store){}
  private entries(conversation:string,user:string):LibraryImage[]{
    const images:LibraryImage[]=[];
    try{images.push({id:'character',source:'character',label:'鲸酱本人原设定图',path:resolveCharacterReference(this.root)});}catch{}
    for(const folder of ['assets/character','runtime/character']){
      const dir=safePath(this.root,folder);if(!fs.existsSync(dir))continue;
      for(const name of fs.readdirSync(dir).slice(0,40)){
        if(!/\.(?:png|jpe?g|gif|webp)$/i.test(name)||name==='whalechan-reference.png')continue;
        const relative=folder+'/'+name;
        images.push({id:'asset-'+createHash('sha256').update(relative).digest('hex').slice(0,20),source:'character',label:name,path:safePath(this.root,relative)});
      }
    }
    let db:DatabaseSync|undefined;
    try{
      const file=safePath(this.root,'runtime/data/fish.sqlite');if(fs.existsSync(file))db=new DatabaseSync(file,{readOnly:true});
      db?.exec('PRAGMA busy_timeout=2000');
      for(const [table,kind] of [['qzone_observations','qzone'],['person_observations','avatar']] as const){
        if(!db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
        const rows=db.prepare('SELECT id,observed,data FROM '+table+' WHERE conversation=? AND person=? AND observed>=? ORDER BY observed DESC,rowid DESC LIMIT 30').all(conversation,user,dayStart()-86400000) as {id:string;observed:number;data:string}[];
        const seen=new Set<string>();
        for(const row of rows){
          const data=JSON.parse(row.data);
          const append=(id:string,label:string,relative:unknown,extra:Partial<LibraryImage>={})=>{
            if(typeof relative!=='string'||!relative.startsWith('runtime/memory/people/'+user+'/')||seen.has(id))return;
            seen.add(id);images.push({id,source:kind,label,observedAt:row.observed,path:safePath(this.root,relative),...extra});
          };
          if(kind==='avatar')append('avatar-'+row.id,'对方 QQ 头像（不是空间动态）',data.avatar);
          else for(const post of data.posts??[])for(const [i,m] of (post.media??[]).entries()){
            if(m.status!=='downloaded')continue;
            append('qzone-'+post.id+'-'+i,'空间第'+post.position+'条'+(m.kind==='video_cover'?'视频封面':'配图')+'：'+String(post.text??'').slice(0,90),m.path,{postId:post.id,position:post.position});
          }
        }
      }
    }finally{db?.close();}
    const rows=this.broker.db.prepare("SELECT image_id,message_id FROM qq_image_requests WHERE conversation=? AND state='completed' ORDER BY rowid DESC LIMIT 40").all(conversation) as {image_id:string;message_id:string}[];
    for(const row of rows)images.push({id:'generated-'+row.image_id,source:'generated',label:'这段 QQ 对话中已生成的图片',path:safePath(this.root,'runtime/outputs/'+row.image_id+'/image.png')});
    return images.filter(image=>{try{const st=fs.lstatSync(image.path);return st.isFile()&&st.nlink===1&&st.size>=12&&st.size<=10485760;}catch{return false;}});
  }
  list(conversation:string,user:string,source:ImageSource='all',offset=0){
    if(!['all','character','avatar','qzone','generated'].includes(source)||!Number.isInteger(offset)||offset<0||offset>1000)throw new FishError('IMAGE_CATALOG_QUERY_INVALID');
    const all=this.entries(conversation,user).filter(i=>source==='all'||i.source===source),page=all.slice(offset,offset+12);
    return {canAttachOriginals:true,images:page.map(({path,...image})=>image),total:all.length,nextOffset:offset+12<all.length?offset+12:null};
  }
  select(conversation:string,user:string,ids:unknown):SelectedReference[]{
    if(!Array.isArray(ids)||ids.length>3||ids.some(id=>typeof id!=='string'||id.length>180)||new Set(ids).size!==ids.length)throw new FishError('IMAGE_REFERENCE_IDS_INVALID');
    if(!ids.length)return [];
    const entries=this.entries(conversation,user);
    return ids.map(id=>{const found=entries.find(i=>i.id===id);if(!found)throw new FishError('IMAGE_REFERENCE_NOT_AVAILABLE');return {id:found.id,label:found.label,path:found.path};});
  }
  view(conversation:string,user:string,ids:unknown){
    const selected=this.select(conversation,user,ids);let budget=12582912;
    return {images:selected.map(item=>{
      const {bytes,mime}=readReference(this.root,item.path.slice(this.root.length+1));budget-=bytes.length;
      if(budget<0)throw new FishError('IMAGE_REFERENCE_LIMIT');
      return {id:item.id,label:item.label,mime,data:bytes.toString('base64')};
    })};
  }
}

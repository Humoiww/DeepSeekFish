import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConfig,validateConfig,conversationAllowed } from '../config.js';
import { Store } from '../storage/db.js';
import { Ledger } from '../budget/ledger.js';
import { makeDir } from '../paths.js';
import { FishError,codeOf } from '../types.js';
import { readQQSettings } from './settings.js';
import { qqResources } from './resources.js';
import { qqBrokerSocket } from './image-client.js';
import { validateImagePlan,imageFields } from '../web/images.js';
import { runCodexImage,type ImageRunner } from '../image/codex-smoke.js';
import { isCharacterPortrait } from '../image/character-reference.js';
import { CodexQuotaMonitor } from '../codex/quota.js';
import { CodexRateLimitError } from '../codex/rate-limit.js';
import { QQImageLibrary } from './image-library.js';

/** Only the trusted QQ process can reach this private socket. No shell, paths,
 * login data, quota resets or ordinary Codex tasks are accepted. */
export async function startQQImageBroker(root:string,store:Store,quota:CodexQuotaMonitor,mock=false,runner?:ImageRunner){
  const cfg=()=>validateConfig({...loadConfig(root),...JSON.parse(store.getMeta('settings')??'{}'),...readQQSettings(root),codex:false});
  const ledger=new Ledger(store,cfg),socket=qqBrokerSocket(root),active=new Set<Promise<void>>(),controllers=new Set<AbortController>();
  store.db.exec('CREATE TABLE IF NOT EXISTS qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT,PRIMARY KEY(conversation,message_id))');
  const library=new QQImageLibrary(root,store);
  makeDir(root,'runtime/broker');
  if(fs.existsSync(socket)){const st=fs.lstatSync(socket);if(!st.isSocket()||st.uid!==process.getuid?.())throw new FishError('QQ_BROKER_PATH_OCCUPIED');fs.unlinkSync(socket);}
  let closing=false;
  const server=createServer((req,res)=>{
    const controller=new AbortController();controllers.add(controller);
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnected);
    const work=(async()=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      try{
        if(closing||req.method!=='POST'||req.url!=='/')throw new FishError('QQ_BROKER_REQUEST_INVALID');
        let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>16384)throw new FishError('BODY_LIMIT');}
        let body:any;try{body=JSON.parse(text);}catch{throw new FishError('INVALID_JSON');}
        const c=cfg();
        if(!body||Object.keys(body).some(k=>!['op','conversation','user','messageId','request','plan','referenceIds','source','offset'].includes(k))||
          typeof body.conversation!=='string'||typeof body.user!=='string'||!/^[1-9]\d{0,19}$/.test(body.user)||!c.enabled||!conversationAllowed(c,body.conversation)||
          (body.conversation.startsWith('private:')?body.conversation!=='private:'+body.user:!c.admins.includes(body.user)&&!c.groups.includes(body.conversation)))throw new FishError('QQ_BROKER_TARGET_DENIED');
        if(body.op==='status'){
          await quota.refresh(true);const account=quota.status();
          res.end(JSON.stringify({...qqResources(c,ledger,body.conversation,body.user),gpt:{blocksImages:false,decision:account.decision,reason:account.reason,remainingPercent:account.remaining,updatedAt:account.updatedAt,remainingImages:null}}));return;
        }
        if(body.op==='list'){res.end(JSON.stringify(library.list(body.conversation,body.user,body.source,body.offset)));return;}
        if(body.op==='view'){res.end(JSON.stringify(library.view(body.conversation,body.user,body.referenceIds)));return;}
        if(body.op!=='image'||!c.images)throw new FishError('IMAGE_DISABLED');
        if(typeof body.messageId!=='string'||!body.messageId.trim()||body.messageId.length>200||typeof body.request!=='string'||body.request.length>2000||!body.request.trim())throw new FishError('INVALID_QQ_IMAGE_REQUEST');
        const existing=()=>store.db.prepare('SELECT state,image_id AS imageId,error FROM qq_image_requests WHERE conversation=? AND message_id=?').get(body.conversation,body.messageId);
        const previous=existing();
        if(previous){res.end(JSON.stringify({...previous,alreadyRequested:true,resources:qqResources(c,ledger,body.conversation,body.user)}));return;}
        const plan=validateImagePlan(body.plan);
        const selected=library.select(body.conversation,body.user,body.referenceIds??[]);
        const claimed=store.db.prepare('INSERT OR IGNORE INTO qq_image_requests VALUES (?,?,?,?,?)').run(body.conversation,body.messageId,'claimed','','').changes;
        if(!claimed){res.end(JSON.stringify({...existing(),alreadyRequested:true,resources:qqResources(c,ledger,body.conversation,body.user)}));return;}
        try{
          const before=await quota.beforeImage();
          const prompt='用户这次想画：'+body.request+'\n'+Object.entries(imageFields).map(([k,label])=>label+'：'+plan[k as keyof typeof plan]).join('\n');
          const character=isCharacterPortrait(body.request)||selected.some(i=>i.id==='character');
          const result=await runCodexImage(root,prompt,{cfg:c,ledger,group:body.conversation,signal:controller.signal,mock,character,references:selected.filter(i=>i.id!=='character'),runner});
          if(result.error==='CODEX_RATE_LIMITED')quota.limited(new CodexRateLimitError(result.retryAt));
          await quota.afterImage(result.id,before);
          if(!result.ok||result.manifest?.length!==1)throw new FishError(result.error??'CODEX_IMAGE_GENERATION_FAILED');
          store.db.prepare("UPDATE qq_image_requests SET state='completed',image_id=? WHERE conversation=? AND message_id=?").run(result.id,body.conversation,body.messageId);
          store.audit('qq-image',body.conversation,result.id);
          res.end(JSON.stringify({imageId:result.id,manifest:result.manifest[0],mock,references:selected.map(({path,...image})=>image),characterReference:character,resources:qqResources(c,ledger,body.conversation,body.user)}));
        }catch(e){store.db.prepare("UPDATE qq_image_requests SET state='failed',error=? WHERE conversation=? AND message_id=?").run(codeOf(e),body.conversation,body.messageId);throw e;}
      }catch(e){if(!res.destroyed){res.statusCode=400;res.end(JSON.stringify({error:codeOf(e)}));}}
      finally{res.off('close',disconnected);controllers.delete(controller);}
    })();active.add(work);void work.finally(()=>active.delete(work));
  });
  server.requestTimeout=300000;server.headersTimeout=5000;server.listen(socket);await once(server,'listening');fs.chmodSync(socket,0o600);
  return {socket,async close(){closing=true;for(const c of controllers)c.abort();await Promise.allSettled(active);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(socket,{force:true});}};
}

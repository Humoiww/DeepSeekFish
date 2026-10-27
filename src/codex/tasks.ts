import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { makeDir } from '../paths.js';
import { Store, redact } from '../storage/db.js';
import { Ledger } from '../budget/ledger.js';
import { FishError, codeOf, type Message } from '../types.js';
import type { TaskRunner } from './runner.js';
import { collectArtifacts } from './artifacts.js';

export interface Task { id:string;grp:string;usr:string;request:string;brief:string;state:string;created:number;started:number|null;result:string|null;manifest:string|null;reservation:string|null;source:string }
export class Tasks {
  private active?:{id:string;abort:AbortController;done:Promise<void>};
  onComplete?: (task:Task)=>Promise<void>;
  constructor(private root:string,public store:Store,private ledger:Ledger,private cfg:()=>Config,private runner:TaskRunner){}
  recover():void {
    // No automatic replays after a crash and no refund of unknown usage.
    this.store.db.exec("UPDATE tasks SET state='failed',result='PROCESS_RESTART_REQUIRES_REVIEW' WHERE state='running'");
    this.store.db.exec("UPDATE reservations SET state='unknown' WHERE state='held'");
  }
  enqueue(message:Message,request:string,brief:string):Task{
    if(!this.cfg().codex)throw new FishError('CODEX_DISABLED');
    if(!this.cfg().admins.includes(message.user))throw new FishError('ADMIN_REQUIRED');
    if(!request.trim()||request.length>1500||!brief.trim()||brief.length>1500)throw new FishError('INVALID_TASK_BRIEF');
    const pending=Number((this.store.db.prepare("SELECT count(*) AS n FROM tasks WHERE state='waiting'").get() as any).n);
    if(pending>=20)throw new FishError('TASK_QUEUE_FULL');
    const id=randomUUID();
    this.store.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,message.group,message.user,redact(request),redact(brief),'waiting',Date.now(),null,null,null,null,JSON.stringify({...message,text:''}));
    return this.get(id);
  }
  get(id:string):Task{
    const row=this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task;
    if(!row)throw new FishError('TASK_NOT_FOUND');return row;
  }
  list():Task[]{return this.store.db.prepare('SELECT * FROM tasks ORDER BY created DESC LIMIT 50').all() as unknown as Task[];}
  approve(id:string):void{
    const task=this.get(id),c=this.cfg();
    if(!c.enabled||!c.codex||!c.admins.includes(task.usr)||!c.groups.includes(task.grp))throw new FishError('TASK_ACCESS_REVOKED');
    if(task.state!=='waiting'||Date.now()-task.created>86400000)throw new FishError('TASK_NOT_WAITING');
    if(this.active)throw new FishError('CODEX_BUSY');
    const reservation=this.ledger.reserve('codex',task.grp,task.usr,0,0,c.codexTimeoutMs+5000);
    const claimed=this.store.db.prepare("UPDATE tasks SET state='running',started=?,reservation=? WHERE id=? AND state='waiting'").run(Date.now(),reservation,id).changes;
    if(!claimed){this.ledger.settle(reservation,undefined,0);throw new FishError('TASK_NOT_WAITING');}
    const abort=new AbortController();
    const done=this.execute(task,reservation,abort).finally(()=>{this.active=undefined;});
    this.active={id,abort,done};void done.catch(()=>{});
  }
  private async execute(task:Task,reservation:string,abort:AbortController):Promise<void>{
    const c=this.cfg(),start=performance.now();let timeout=false,terminationUnconfirmed=false;
    const timer=setTimeout(()=>{timeout=true;abort.abort();},c.codexTimeoutMs);
    try{
      const cwd=makeDir(this.root,'runtime/workspace/'+task.id);
      const result=await this.runner.run(cwd,task.brief,abort.signal);
      abort.signal.throwIfAborted();
      const manifest=collectArtifacts(this.root,task.id,c.maxFiles,c.maxArtifactBytes);
      this.store.db.prepare("UPDATE tasks SET state='succeeded',result=?,manifest=? WHERE id=?").run(redact(result).slice(0,12000),JSON.stringify(manifest),task.id);
    }catch(e){
      terminationUnconfirmed=codeOf(e)==='CODEX_PROCESS_NOT_TERMINATED';
      const state=timeout?'timed_out':abort.signal.aborted?'cancelled':'failed';
      this.store.db.prepare('UPDATE tasks SET state=?,result=? WHERE id=?').run(state,codeOf(e),task.id);
      this.store.audit('task-error',task.grp,codeOf(e));
    }finally{
      clearTimeout(timer);if(!terminationUnconfirmed)this.ledger.settle(reservation,undefined,performance.now()-start);
    }
    try{await this.onComplete?.(this.get(task.id));}catch(e){this.store.audit('delivery-error',task.grp,codeOf(e));}
  }
  cancel(id:string,group?:string):void{
    const t=this.get(id);if(group&&t.grp!==group)throw new FishError('TASK_GROUP_MISMATCH');
    if(t.state==='waiting'){this.store.db.prepare("UPDATE tasks SET state='cancelled',result='CANCELLED_LOCALLY' WHERE id=? AND state='waiting'").run(id);return;}
    if(this.active?.id===id)this.active.abort.abort();else throw new FishError('TASK_NOT_RUNNING');
  }
  async idle():Promise<void>{await this.active?.done;}
  async stop():Promise<void>{this.active?.abort.abort();await this.idle();}
}

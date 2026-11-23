import {diagnosticSafe} from '../diagnostics.js';
import {makeDir,writePrivateAtomic} from '../paths.js';
import type {Job,Jobs} from './jobs.js';

export const developmentActivityFolder='runtime/data/development-activity';

function observation(value:unknown){
 if(value===undefined)return;
 const safe=diagnosticSafe(value),text=JSON.stringify(safe);
 return text.length<=4000?safe:text.slice(0,4000)+'…（已截断）';
}

export function developmentActivityRecord(job:Job){
 const requests=job.requests.length>6?[job.requests[0],...job.requests.slice(-5)]:job.requests;
 return diagnosticSafe({
  id:job.id,created:job.created,updated:job.modified,phase:job.phase,
  backend:job.backend,agyStage:job.agyStage,codexRetries:job.codexRetries,agySummary:job.agySummary,
  goal:job.goal.slice(0,4000),criteria:job.criteria.slice(0,20),reason:job.reason,report:job.report,
  requests:requests.map(request=>({at:request.at,text:request.text.slice(0,8000),
   brief:request.intent&&request.intent.action!=='cancel'?request.intent.brief:undefined})),
  codex:{thread:job.thread,turn:job.turn,selection:job.codexSelection,activity:job.codexActivity,
   rounds:job.round,response:job.codexText,retryAt:job.codexRetryAt,approvals:job.codexApprovals?.slice(-30)},
  trials:job.trials.slice(-8).map(trial=>({kind:trial.kind,revision:trial.revision,passed:trial.passed,reason:trial.reason,
   entry:trial.input.entry,input:trial.input.text,expected:trial.input.expected,observed:observation(trial.observed)})),
  candidate:job.candidate,deployment:job.deployment,
 });
}

/** Publish read-only views for WebUI. Authority and workspaces stay in the supervisor. */
export function publishDevelopmentActivity(root:string,jobs:Jobs){
 const pending=jobs.activityPending();
 if(!pending.length)return;
 makeDir(root,developmentActivityFolder);
 for(const {id,body} of pending){
  if(!/^[a-f0-9-]{36}$/.test(id))continue;
  writePrivateAtomic(root,`${developmentActivityFolder}/${id}.json`,JSON.stringify(developmentActivityRecord(JSON.parse(body))));
  jobs.activityWritten(id,body);
 }
}

import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../src/storage/db.js';
import { Ledger } from '../src/budget/ledger.js';
const store=new Store(workerData.root),ledger=new Ledger(store,()=>workerData.config);
parentPort!.postMessage('ready');
parentPort!.once('message',()=>{
  let accepted=0;
  for(let i=0;i<10;i++){try{ledger.reserve('model','g','admin',10,10);accepted++;}catch{}}
  store.close();parentPort!.postMessage(accepted);
});

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { noLinks } from '../paths.js';
import { FishError } from '../types.js';
import type { Artifact } from './artifacts.js';
export function verifyArtifact(p:string,a:Artifact,max:number):void{
  noLinks(p);const s=fs.lstatSync(p);
  if(!s.isFile()||s.nlink!==1||s.size!==a.bytes||s.size>max||createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==a.sha256)throw new FishError('ARTIFACT_CHANGED');
}

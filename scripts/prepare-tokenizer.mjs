import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dir=path.join(root,'runtime/tools/tokenizer');
const source={model:'deepseek-ai/DeepSeek-V4.1-Flash-1017',revision:'1bae0e1088993b9b82de08f59de5be5a34e42170'};
fs.mkdirSync(dir,{recursive:true});
const names=['tokenizer.json','tokenizer_config.json','LICENSE'];
if(fs.existsSync(path.join(dir,'source.json'))&&JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir,'source.json'),'utf8')))===JSON.stringify(source)&&names.every(name=>fs.existsSync(path.join(dir,name))))process.exit(0);
for(const name of names){
 const response=await fetch(`https://huggingface.co/${source.model}/resolve/${source.revision}/${name}`,{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('Tokenizer download failed: '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>12000000)throw Error('Tokenizer file too large');
 fs.writeFileSync(path.join(dir,name+'.tmp'),bytes);fs.renameSync(path.join(dir,name+'.tmp'),path.join(dir,name));
}
fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify(source,null,2)+'\n');
console.log('Prepared official DeepSeek tokenizer (no model weights).');

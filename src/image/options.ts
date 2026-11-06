import {FishError} from '../types.js';
/** Native Codex image_gen.imagegen GIF options, not a conversion recipe. */
export type GifOptions={frame_count?:number;frame_duration_ms?:number};
export const gifParameters={type:'object',description:'原生GIF；空对象采用提供方默认帧数和时长。省略则由画面要求选择静图/动图。',properties:{frame_count:{type:'integer',minimum:2,maximum:16},frame_duration_ms:{type:'integer',minimum:20,maximum:2000}},additionalProperties:false};
export function validateGif(value:unknown):GifOptions{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new FishError('INVALID_GIF_OPTIONS');
 const input=value as Record<string,unknown>;
 if(Object.keys(input).some(k=>!['frame_count','frame_duration_ms'].includes(k)))throw new FishError('INVALID_GIF_OPTIONS');
 for(const [key,min,max] of [['frame_count',2,16],['frame_duration_ms',20,2000]] as const){const n=input[key];if(n!==undefined&&(!Number.isSafeInteger(n)||(n as number)<min||(n as number)>max))throw new FishError('INVALID_GIF_OPTIONS');}
 return {...input} as GifOptions;
}

import {Parser} from 'htmlparser2';
import {htmlContent,safeLink,timestamp,type SocialPage,type SocialPost} from './social-common.js';
/** Atom/RSS is data, not executable XML. No DTD/entity loading or HTML execution. */
export function parseFeed(xml:string,url:string,fetchedAt=new Date().toISOString()):SocialPage|undefined{
 type Node={name:string;attrs:Record<string,string>;text:string;children:Node[]};
 const root:Node={name:'root',attrs:{},text:'',children:[]},stack=[root];let count=0,overflow=false;
 const p=new Parser({onopentag(name,attrs){count++;if(stack.length>80||count>30000){overflow=true;return;}const n:Node={name:name.toLowerCase(),attrs,text:'',children:[]};stack.at(-1)!.children.push(n);stack.push(n);},ontext(text){if(!overflow&&stack.at(-1)!.text.length<200000)stack.at(-1)!.text+=text;},onclosetag(){if(!overflow&&stack.length>1)stack.pop();}},{xmlMode:true,decodeEntities:true});p.end(xml);if(overflow)return;
 const feed=root.children.find(n=>['feed','rss','rdf:rdf'].includes(n.name));if(!feed)return;
 const channel=feed.children.find(n=>n.name==='channel')??feed,children=(n:Node,name:string)=>n.children.filter(c=>c.name===name),value=(n:Node,name:string)=>children(n,name)[0]?.text.trim()??'';
 const entries=channel.children.filter(n=>n.name==='entry'||n.name==='item');
 const posts:SocialPost[]=entries.map(n=>{
  const link=children(n,'link').find(c=>!c.attrs.rel||c.attrs.rel==='alternate');
  const target=safeLink(link?.attrs.href??link?.text,url),author=children(n,'author')[0],id=value(n,'id')||value(n,'guid')||target||'';
  const body=htmlContent(value(n,'content')||value(n,'content:encoded')||value(n,'description')||value(n,'summary'),target??url);
  for(const media of [...children(n,'media:content'),...children(n,'media:thumbnail'),...children(n,'enclosure')]){
   const image=safeLink(media.attrs.url,target??url);if(image&&(media.name==='media:thumbnail'||/^image\//.test(media.attrs.type??'')))body.images.push({url:image,kind:media.name==='media:thumbnail'?'post_preview':'post_image',label:media.attrs.title??''});
  }
  return {id,url:target,author:{name:author?(value(author,'name')||author.text):value(n,'dc:creator'),url:author?safeLink(value(author,'uri'),url):null},publishedAt:timestamp(value(n,'published')||value(n,'pubdate')||value(n,'dc:date')),updatedAt:timestamp(value(n,'updated')),title:value(n,'title').slice(0,240),text:[value(n,'title'),body.text].filter(Boolean).filter((t,i,a)=>a.indexOf(t)===i).join('\n'),images:body.images.map(i=>({...i,postId:id})),links:body.links.slice(0,25),kind:id.startsWith('t1_')?'comment':'post'};
 });
 const next=children(channel,'link').find(n=>n.attrs.rel==='next'),nextPage=safeLink(next?.attrs.href,url);
 return {url,sourceUrl:url,provider:'RSS/Atom',coverage:'feed_entries_only',title:value(channel,'title'),status:posts.length?'content':'empty',fetchedAt,latestVerified:false,posts,links:nextPage?[{url:nextPage,label:'下一页'}]:[],nextPage,unavailable:[],notice:'只包含此订阅页实际返回的条目，不等于全部帖子或完整评论树。'};
}

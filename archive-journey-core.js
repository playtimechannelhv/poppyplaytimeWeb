(function(root,factory){
if(typeof module==='object'&&module.exports)module.exports=factory();else root.PoppyArchiveJourneyCore=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';
const KEY='poppy_archive_journey_v1',GUEST_KEY='poppy_archive_journey_guest_v1',SPEEDS=[0.5,1,1.5,2];
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function normalizeState(input,articleCount,blockCount,wordCount){
 const i=input||{},articles=Math.max(1,Number(articleCount)||1),article=clamp(Math.trunc(Number(i.article)||0),0,articles-1),blocks=Math.max(1,Number(blockCount)||1),block=clamp(Math.trunc(Number(i.block)||0),0,blocks-1),words=Math.max(1,Number(wordCount)||1),word=clamp(Math.trunc(Number(i.word)||0),0,words-1),speed=SPEEDS.includes(Number(i.speed))?Number(i.speed):1;
 return {article,block,word,speed,completed:!!i.completed};
}
function nextPosition(article,block,word,metrics){
 const list=metrics||[],m=list[article]||{wordCounts:[]},count=m.wordCounts.length,words=Math.max(1,m.wordCounts[block]||1);
 if(word+1<words)return {article,block,word:word+1,completed:false};
 if(block+1<count)return {article,block:block+1,word:0,completed:false};
 if(article+1<list.length)return {article:article+1,block:0,word:0,completed:false};
 return {article:Math.max(0,list.length-1),block:Math.max(0,count-1),word:Math.max(0,words-1),completed:true};
}
function createProgressStore(o){
 o=o||{};const storage=o.storage||null,fetchImpl=o.fetchImpl||((typeof fetch==='function')?fetch:null),getAuthToken=o.getAuthToken||(()=>''),settingsUrl=o.settingsUrl||'',key=o.key||KEY,guestKey=o.guestKey||GUEST_KEY;
 const readGuest=()=>{if(!storage)return null;try{const r=storage.getItem(guestKey);return r?JSON.parse(r):null;}catch(_){return null;}};
 const writeGuest=v=>{if(!storage)return;try{storage.setItem(guestKey,JSON.stringify(v));}catch(_){}};
 const clearGuest=()=>{if(!storage)return;try{storage.removeItem(guestKey);}catch(_){}};
 async function load(){
  const token=String(getAuthToken()||'').trim();if(!token)return readGuest();
  if(!fetchImpl||!settingsUrl)throw new Error('authenticated_storage_unavailable');
  const res=await fetchImpl(settingsUrl,{method:'GET',headers:{Authorization:'Bearer '+token},cache:'no-store'});if(!res.ok)throw new Error('settings_get_failed');
  const data=await res.json();if(!data||data.success!==true)throw new Error('settings_get_failed');const raw=data.settings&&data.settings[key];if(!raw)return null;
  try{return typeof raw==='string'?JSON.parse(raw):raw;}catch(_){return null;}
 }
 async function save(value,options){
  const token=String(getAuthToken()||'').trim();if(!token){writeGuest(value);return {mode:'guest'};}
  if(!fetchImpl||!settingsUrl)throw new Error('authenticated_storage_unavailable');
  const res=await fetchImpl(settingsUrl,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({key,value:JSON.stringify(value)}),keepalive:!!(options&&options.keepalive)});
  if(!res.ok)throw new Error('settings_put_failed');const data=await res.json();if(!data||data.success!==true)throw new Error('settings_put_failed');return {mode:'d1'};
 }
 return {load,save,clearGuest,readGuest,KEY:key,GUEST_KEY:guestKey};
}
return {KEY,GUEST_KEY,SPEEDS,normalizeState,nextPosition,createProgressStore};
});
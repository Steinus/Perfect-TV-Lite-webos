'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),zlib=require('zlib'),Module=require('module');
var tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ptl-cache-test-'));
process.env.PERFECT_TV_LITE_CACHE_DIR=tmp;
var handlers={},old=Module._load;
Module._load=function(n,parent,isMain){
 if(n==='webos-service')return function(){this.register=function(action,callback){handlers[action]=callback;};};
 return old.apply(this,arguments);
};
var serviceFile=path.join(__dirname,'../service/service.js');
function loadService(){delete require.cache[require.resolve(serviceFile)];Module._load=function(n,parent,isMain){if(n==='webos-service')return function(){this.register=function(a,c){handlers[a]=c;};};return old.apply(this,arguments);};require(serviceFile);Module._load=old;}
loadService();Module._load=old;
function query(name,payload){return new Promise(function(resolve,reject){
 var t=setTimeout(function(){reject(new Error('Timeout '+name));},12000);
 handlers[name]({payload:payload||{},respond:function(result){clearTimeout(t);resolve(result);}});
});}
function pad(n){return ('0'+n).slice(-2);}
function tvDate(v){var d=new Date(v);return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+' +0000';}
var now=Date.now(),epgText=['<?xml version="1.0"?><tv>',
 '<channel id="tv.yosso"><display-name>Yosso TV</display-name></channel>',
 '<channel id="other"><display-name>Other</display-name></channel>',
 '<programme channel="tv.yosso" start="'+tvDate(now-1200000)+'" stop="'+tvDate(now+2400000)+'"><title>Дневной эфир</title><desc>Подробное описание</desc></programme>',
 '<programme channel="tv.yosso" start="'+tvDate(now+2400000)+'" stop="'+tvDate(now+6000000)+'"><title>Вечерний эфир</title></programme>',
 '</tv>'].join('\n');
var epgGzip=zlib.gzipSync(Buffer.from(epgText,'utf8'));
var m3uText='#EXTM3U\n#EXTINF:-1 tvg-id="tv.yosso" group-title="Yosso",Yosso TV\nhttp://127.0.0.1/test.m3u8\n';
var hits={m3u:0,epg:0,conditional:0};
var httpServer=http.createServer(function(req,res){
 if(req.url==='/playlist.m3u'){
   hits.m3u++;res.writeHead(200,{'Content-Type':'audio/x-mpegurl'});res.end(m3uText);return;
 }
 hits.epg++;
 if(req.headers['if-none-match']==='"epg-1"'){
  hits.conditional++;res.writeHead(304,{'ETag':'"epg-1"'});res.end();return;
 }
 res.writeHead(200,{'ETag':'"epg-1"','Last-Modified':'Sat, 14 Nov 2026 11:01:14 GMT','Content-Type':'application/xml','Content-Encoding':'gzip'});
 for(var i=0;i<epgGzip.length;i+=17)res.write(epgGzip.slice(i,i+17));res.end();
});
(async function(){
 await new Promise(function(r){httpServer.listen(0,'127.0.0.1',r);});
 var root='http://127.0.0.1:'+httpServer.address().port;
 var pUrl=root+'/playlist.m3u', eUrl=root+'/epg.xml';
 var channels=[['tv.yosso','Yosso TV HD','Yosso TV']];
 try{
  var first=await query('getText',{url:pUrl,playlist:true});
  assert(first.returnValue&&first.text===m3uText&&first.cacheSaved,JSON.stringify(first));
  assert.equal(hits.m3u,1);
  var second=await query('getText',{url:pUrl,playlist:true});
  assert(second.cached&&second.text===m3uText,'playlist must load from disk');
  assert.equal(hits.m3u,1,'unexpected M3U HTTP fetch on launch');
  var firstEpg=await query('getEpg',{url:eUrl,channels:channels});
  assert(firstEpg.returnValue&&firstEpg.stats.cacheSaved,JSON.stringify(firstEpg));
  assert.equal(firstEpg.items[0][1][0],'Дневной эфир');
  assert.equal(hits.epg,1);
  var guide=await query('getGuide',{index:0});
  assert.equal(guide.rows.length,2);assert.equal(guide.rows[0][3],'Подробное описание');
  var stored=await query('getCachedEpg',{url:eUrl,channels:channels});
  assert(stored.found&&stored.fresh&&stored.items[0][1][0]==='Дневной эфир',JSON.stringify(stored));
  assert.equal(hits.epg,1,'EPG must not be fetched on cache restore');
  var noMatch=await query('getCachedEpg',{url:eUrl,channels:[['different','Some Channel','Some Channel']]});
  assert(!noMatch.found,'changed playlist must invalidate EPG mapping');
  // Emulate Node JS service restart (webOS destroys the service when TV closes).
  loadService();
  var afterRestart=await query('getCachedEpg',{url:eUrl,channels:channels});
  assert(afterRestart.found&&afterRestart.fresh&&afterRestart.items[0][1][0]==='Дневной эфир',JSON.stringify(afterRestart));
  var guideAfterRestart=await query('getGuide',{index:0});
  assert.equal(guideAfterRestart.rows[0][3],'Подробное описание');
  assert.equal(hits.epg,1,'No fetch after service restart');
  // Emulate 24h passed; only HTTP conditional GET, not a full XML re-download.
  var metaPath=path.join(tmp,fs.readdirSync(tmp).filter(function(f){return /^epg-[a-f0-9]+-meta\.json$/.test(f);})[0]);
  var meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
  meta.checkedAt=Date.now()-86400001;
  fs.writeFileSync(metaPath,JSON.stringify(meta));
  var stale=await query('getCachedEpg',{url:eUrl,channels:channels});
  assert(stale.found&&!stale.fresh,'should mark 24-hour cache stale');
  var notModified=await query('getEpg',{url:eUrl,channels:channels});
  assert(notModified.returnValue&&notModified.stats.notModified,JSON.stringify(notModified));
  assert.equal(hits.conditional,1,'expected ETag conditional response');
  var refreshed=await query('getCachedEpg',{url:eUrl,channels:channels});
  assert(refreshed.fresh,'304 should renew 24-hour checkedAt');
  // A second playlist must not evict the first one from persistent storage.
  var pUrl2=root+'/playlist2.m3u';
  var third=await query('getText',{url:pUrl2,playlist:true});
  assert(third.returnValue&&third.cacheSaved,'second playlist should save');
  var firstAgain=await query('getText',{url:pUrl,playlist:true});
  assert(firstAgain.cached&&firstAgain.text===m3uText,'first profile should still be cached');
  var epg2=await query('getEpg',{url:eUrl,channels:[['different','Other TV','Other TV']]});
  assert(epg2.returnValue&&epg2.stats.cacheSaved,'second guide signature must be independently saved');
  var firstGuide=await query('getCachedEpg',{url:eUrl,channels:channels});
  assert(firstGuide.found,'first profile EPG must survive second profile');
  var manual=await query('getText',{url:pUrl,playlist:true,force:true});
  assert(manual.returnValue&&!manual.cached);
  assert.equal(hits.m3u,2,'manual refresh should fetch M3U');
  var manualEpg=await query('getEpg',{url:eUrl,channels:channels,force:true});
  assert(manualEpg.returnValue&&manualEpg.stats.cacheSaved,'manual EPG must download and refresh cache');
  var files=fs.readdirSync(tmp).map(function(f){return [f,fs.statSync(path.join(tmp,f)).size];});
  console.log('PASS: persistent M3U, boot EPG, per-channel guide, 24-hour TTL, HTTP 304, forced refresh');
  console.log('requests',hits,'files',files);
 }finally{httpServer.close();}
})().catch(function(e){console.error(e.stack||e);process.exitCode=1;httpServer.close();});

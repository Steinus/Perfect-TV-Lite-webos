'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),zlib=require('zlib'),Module=require('module'),cp=require('child_process');
var tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ptv036-test-'));
process.env.PERFECT_TV_LITE_CACHE_DIR=tmp;
var handlers={},original=Module._load,server=null;
Module._load=function(name,parent,isMain){
 if(name==='webos-service')return function(){this.register=function(action,handler){handlers[action]=handler;};};
 return original.apply(this,arguments);
};
require(path.join(__dirname,'../service/service.js'));
Module._load=original;
function call(action,payload){return new Promise(function(resolve,reject){
 var timer=setTimeout(function(){reject(new Error('timeout '+action));},9000);
 handlers[action]({payload:payload||{},respond:function(result){clearTimeout(timer);resolve(result);}});
});}
var userAgents=[],requests=0;
var body='#EXTM3U\n#EXTINF:-1 group-title="Kino",Test channel\nhttp://example.test/play.m3u8\n';
var zipped=zlib.gzipSync(Buffer.from(body));
function route(req,res){
 requests++;userAgents.push(req.headers['user-agent']);
 if(req.url.indexOf('/redirect')===0){res.writeHead(302,{'Location':'/file?token=TOP_SECRET'});res.end();return;}
 if(req.url.indexOf('/compressed')===0){res.writeHead(200,{'Content-Type':'audio/x-mpegurl','Content-Encoding':'gzip'});res.end(zipped);return;}
 if(req.url.indexOf('/rawgz')===0){res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end(zipped);return;}
 if(req.url.indexOf('/denied')===0){res.writeHead(403);res.end('forbidden');return;}
 res.writeHead(200,{'Content-Type':'audio/x-mpegurl'});res.end(body);
}
(async function(){
 server=http.createServer(route);await new Promise(function(r){server.listen(0,'127.0.0.1',r);});
 var root='http://127.0.0.1:'+server.address().port;
 try{
  var ping=await call('ping',{});assert.equal(ping.serviceVersion,'0.3.7');
  // The URL is passed to curl over stdin, not in the process list.
  var realSpawn=cp.spawn, seen=[];
  cp.spawn=function(command,args,options){seen.push({command:command,args:args});return realSpawn.apply(this,arguments);};
  var first=await call('getText',{url:root+'/redirect?token=TOP_SECRET',playlist:true});
  cp.spawn=realSpawn;
  assert(first.returnValue&&first.text===body&&first.transport==='curl'&&first.cacheSaved,JSON.stringify(first));
  assert.equal(seen.length,1);assert(!seen[0].args.join(' ').includes('TOP_SECRET'));
  var oldRequests=requests;
  var cached=await call('getText',{url:root+'/redirect?token=TOP_SECRET',playlist:true});
  assert(cached.returnValue&&cached.cached&&cached.text===body);assert.equal(requests,oldRequests);
  var compressed=await call('getText',{url:root+'/compressed'});assert.equal(compressed.text,body);
  var rawzip=await call('getText',{url:root+'/rawgz'});assert.equal(rawzip.text,body);
  assert(userAgents.every(function(x){return x==='PerfecktTV';}),'UA changed');
  // Curl launch failure must retain the original Node transport.
  cp.spawn=function(){throw new Error('mock curl unavailable');};
  var fallback=await call('getText',{url:root+'/file?token=private'});
  cp.spawn=realSpawn;
  assert.equal(fallback.transport,'node');assert.equal(fallback.text,body);
  var denied=await call('getText',{url:root+'/denied'});
  assert(!denied.returnValue&&/403/.test(denied.errorText),JSON.stringify(denied));
  assert(!denied.errorText.includes('TOP_SECRET')&&!denied.errorText.includes('private'));
  console.log('PASS: curl M3U, redirects, gzip, raw gzip, token private, Node fallback, HTTP error, persistent cache.');
 }finally{cp.spawn=cp.spawn||original;server.close();}
})().catch(function(err){console.error(err.stack||err);process.exitCode=1;if(server)server.close();});

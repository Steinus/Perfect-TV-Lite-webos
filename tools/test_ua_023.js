'use strict';
var assert=require('assert'), http=require('http'), path=require('path'), Module=require('module');
var handlers={},original=Module._load,seen=[];
Module._load=function(name,parent,isMain){
  if(name==='webos-service') return function(){this.register=function(method,cb){handlers[method]=cb;};};
  return original.apply(this,arguments);
};
require(path.resolve(__dirname,'../service/service.js'));
Module._load=original;
function call(action,payload){return new Promise(function(resolve,reject){
  var t=setTimeout(function(){reject(new Error('timeout '+action));},10000);
  handlers[action]({payload:payload,respond:function(reply){clearTimeout(t);resolve(reply);}});
});}
var server=http.createServer(function(req,res){
  seen.push({path:req.url,ua:req.headers['user-agent']});
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/playlist.m3u'});res.end();return;}
  if(req.url==='/playlist.m3u'){res.writeHead(200,{'Content-Type':'audio/x-mpegurl'});res.end('#EXTM3U\n#EXTINF:-1,Test\nhttp://example.test/live.m3u8\n');return;}
  if(req.url==='/epg.xml') {res.writeHead(200,{'Content-Type':'application/xml'});res.end('<?xml version="1.0"?><tv><channel id="a"><display-name>Test</display-name></channel></tv>');return;}
  if(req.url==='/master.m3u8') {res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nstream.m3u8\n');return;}
  res.writeHead(404);res.end();
});
(async function(){
  await new Promise(function(resolve){server.listen(0,'127.0.0.1',resolve);});
  var root='http://127.0.0.1:'+server.address().port;
  try{
    var ping=await call('ping',{});
    assert.equal(ping.serviceVersion,'0.3.7');assert.equal(ping.userAgent,'PerfecktTV');
    var list=await call('getText',{url:root+'/redirect'});assert(list.returnValue,list.errorText);
    var epg=await call('getEpg',{url:root+'/epg.xml',channels:[['a','Test','Test']]});assert(epg.returnValue,epg.errorText);
    var hls=await call('getHlsInfo',{url:root+'/master.m3u8'});assert(hls.returnValue,hls.errorText);
    assert.equal(seen.length,4,'expected redirect + M3U + EPG + HLS requests');
    seen.forEach(function(item){assert.equal(item.ua,'PerfecktTV','User-Agent on '+item.path);});
    console.log('PASS: Exact PerfecktTV UA on M3U + redirects, XMLTV and HLS metadata; ping reports UA.');
  }finally{server.close();}
})().catch(function(err){console.error(err);process.exitCode=1;server.close();});

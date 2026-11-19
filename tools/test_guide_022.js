'use strict';
var assert=require('assert'),http=require('http'),zlib=require('zlib'),path=require('path'),Module=require('module');
var handlers={},old=Module._load;
Module._load=function(name,parent,main){
  if(name==='webos-service')return function(){this.register=function(method,fun){handlers[method]=fun;};};
  return old.apply(this,arguments);
};
require(path.join(__dirname,'../service/service.js'));
Module._load=old;
function ts(ms){var d=new Date(ms);function zz(x){return ('0'+x).slice(-2);}
  return d.getUTCFullYear()+zz(d.getUTCMonth()+1)+zz(d.getUTCDate())+zz(d.getUTCHours())+zz(d.getUTCMinutes())+zz(d.getUTCSeconds())+' +0000';}
function request(action,payload){return new Promise(function(ok,fail){
  var timeout=setTimeout(function(){fail(new Error(action+' timeout'));},10000);
  handlers[action]({payload:payload,respond:function(data){clearTimeout(timeout);ok(data);}});
});}
var now=Date.now(),start=now-1200000,end=now+1200000;
var xml=['<?xml version="1.0"?><tv>',
  '<channel id="main.1"><display-name lang="ru">Первый канал</display-name></channel>',
  '<channel id="other.2"><display-name>Другой</display-name></channel>',
  '<programme channel="main.1" start="'+ts(now-86400000)+'" stop="'+ts(now-82800000)+'"><title>Вчера</title><desc>Archive description from XMLTV</desc></programme>',
  '<programme channel="main.1" start="'+ts(start)+'" stop="'+ts(end)+'"><title lang="ru">Новости</title><desc lang="ru">Новости с описанием программы.</desc></programme>',
  '<programme channel="main.1" start="'+ts(end)+'" stop="'+ts(end+3600000)+'"><title>Следующая передача</title><desc>Завтра</desc></programme>',
  '<programme channel="other.2" start="'+ts(start)+'" stop="'+ts(end)+'"><title>Другой канал</title></programme>',
  '</tv>'].join('\n');
var server=http.createServer(function(req,res){
  if(req.url==='/tv.m3u8') {res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4300000,RESOLUTION=1920x1080\n720.m3u8\n');return;}
  var data=zlib.gzipSync(Buffer.from(xml,'utf8'));
  res.writeHead(200,{'Content-Type':'application/octet-stream'});
  for(var i=0;i<data.length;i+=17)res.write(data.slice(i,i+17));res.end();
});
(async function(){
  await new Promise(function(done){server.listen(0,'127.0.0.1',done);});
  var url='http://127.0.0.1:'+server.address().port;
  try{
    var channels=[['wrong.id','Первый канал HD orig','Первый канал HD'],['other.2','Другой','Другой'],['nomatch','Пустой','Пустой']];
    var epg=await request('getEpg',{url:url+'/epg.xml.gz',channels:channels});
    assert(epg.returnValue,JSON.stringify(epg));
    assert.equal(epg.stats.matched,2);
    assert.equal(epg.stats.guideEntries,4);
    var guide=await request('getGuide',{index:0});
    assert(guide.returnValue);assert.equal(guide.rows.length,3);assert.equal(guide.rows[0][3],'Archive description from XMLTV');
    assert.equal(guide.rows[1][0],'Новости');assert.equal(guide.rows[1][3],'Новости с описанием программы.');
    var second=await request('getGuide',{index:1});assert(second.returnValue&&second.rows.length===1);
    var missing=await request('getGuide',{index:2});assert(missing.returnValue&&missing.rows.length===0);
    var bad=await request('getGuide',{index:900});assert(!bad.returnValue);
    var hls=await request('getHlsInfo',{url:url+'/tv.m3u8'});
    assert(hls.returnValue,JSON.stringify(hls));assert.equal(hls.bps,4300000);assert.equal(hls.resolution,'1920×1080');
    console.log('PASS: single gzip stream, full per-channel guide, now description, empty channel, HLS metadata');
    console.log('Guide cached in-memory:',epg.stats.guideEntries,'entries; XML peak buffer:',epg.stats.peakXmlBuffer,'characters');
  }finally{server.close();}
})().catch(function(err){console.error(err);process.exitCode=1;server.close();});

'use strict';
var assert=require('assert');
var http=require('http');
var zlib=require('zlib');
var path=require('path');
var Module=require('module');
var handlers={};
var original=Module._load;
Module._load=function(name,parent,isMain){
  if(name==='webos-service')return function(){this.register=function(action,callback){handlers[action]=callback;};};
  return original.apply(this,arguments);
};
require(path.join(__dirname,'../service/service.js'));
Module._load=original;
function z(n){return n<10?'0'+n:''+n;}
function xmlDate(d){return d.getUTCFullYear()+z(d.getUTCMonth()+1)+z(d.getUTCDate())+z(d.getUTCHours())+z(d.getUTCMinutes())+z(d.getUTCSeconds())+' +0000';}
var now=Date.now();
var current=xmlDate(new Date(now-900000)),stop=xmlDate(new Date(now+2700000));
var nextStart=stop,nextStop=xmlDate(new Date(now+6300000));
var xml='<?xml version="1.0" encoding="UTF-8"?><tv>\n'+
  '<channel id="tv.one"><display-name lang="ru">Первый канал</display-name></channel>\n'+
  '<channel id="tv.two"><display-name>Россия 24</display-name></channel>\n'+
  '<programme start="'+current+'" stop="'+stop+'" channel="tv.one"><title lang="ru">Новости &amp; культура</title></programme>\n'+
  '<programme start="'+nextStart+'" stop="'+nextStop+'" channel="tv.one"><title>Вечер</title></programme>\n'+
  '<programme start="'+current+'" stop="'+stop+'" channel="tv.two"><title>Сегодня</title></programme>\n'+
  // Provide thousands of old entries to verify streaming discards older programmes.
  Array(3000).join('<programme start="20200101000000 +0000" stop="20200101001000 +0000" channel="old"><title>Old show</title></programme>\n')+
  '</tv>';
var zipped=zlib.gzipSync(Buffer.from(xml,'utf8'));
var server=http.createServer(function(req,res){
  if(req.url==='/redirect'){res.writeHead(302,{location:'/guide.xml.gz'});res.end();return;}
  if(req.url==='/error'){res.writeHead(500);res.end('broken');return;}
  var zip=req.url.indexOf('.gz')>=0;
  res.writeHead(200,{'Content-Type':'application/octet-stream'});
  var bytes=zip?zipped:Buffer.from(xml,'utf8');
  for(var i=0;i<bytes.length;i+=173)res.write(bytes.slice(i,i+173));
  res.end();
});
function request(method,payload){return new Promise(function(resolve,reject){
  var timer=setTimeout(function(){reject(new Error('Service timeout'));},10000);
  handlers[method]({payload:payload,respond:function(result){clearTimeout(timer);resolve(result);}});
});}
(async function(){
  await new Promise(function(r){server.listen(0,'127.0.0.1',r);});
  var root='http://127.0.0.1:'+server.address().port;
  var ch=[['unknown-id','Первый канал HD','Первый канал'],['tv.two','Россия 24','Россия 24']];
  try{
    var ping=await request('ping',{});assert(ping.epgStreaming);
    var epg=await request('getEpg',{url:root+'/redirect',channels:ch});
    assert(epg.returnValue,JSON.stringify(epg));
    assert.equal(epg.items.length,2);
    assert.equal(epg.items[0][1][0],'Новости & культура');
    assert.equal(epg.items[0][2][0],'Вечер');
    assert.equal(epg.stats.matched,2);
    console.log('gzip auto-detect, redirect, alias match:',epg.stats,'current',epg.items[0][1][0]);
    var plain=await request('getEpg',{url:root+'/guide.xml',channels:ch});
    assert(plain.returnValue&&plain.items.length===2);
    var response=await request('getText',{url:root+'/guide.xml.gz'});
    assert(response.returnValue&&response.text.indexOf('Россия 24')>=0);
    var error=await request('getEpg',{url:root+'/error',channels:ch});
    assert(!error.returnValue && error.errorText.indexOf('HTTP 500')>=0);
    console.log('plain XML, gz text fetch, HTTP error handling: passed');
  } finally{server.close();}
})().catch(function(err){console.error(err);process.exitCode=1;server.close();});

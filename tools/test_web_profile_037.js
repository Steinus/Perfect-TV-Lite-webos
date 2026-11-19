'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),Module=require('module');
var dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptv037-profiles-'));
process.env.PERFECT_TV_LITE_CACHE_DIR=dir;
var handlers={},original=Module._load;
Module._load=function(name,p,m){if(name==='webos-service')return function(){this.register=function(action,fn){handlers[action]=fn;};};return original.apply(this,arguments);};
require(path.resolve(__dirname,'../service/service.js'));Module._load=original;
function call(action,payload){return new Promise(function(resolve){handlers[action]({payload:payload||{},respond:resolve});});}
function req(method,pathname,payload,headers){return new Promise(function(resolve,reject){
  var body=payload||'',opts={hostname:'127.0.0.1',port:8098,path:pathname,method:method,headers:headers||{}};
  var request=http.request(opts,function(res){var chunks=[];res.on('data',function(c){chunks.push(c);});res.on('end',function(){var s=Buffer.concat(chunks).toString();var json=null;try{json=JSON.parse(s);}catch(e){}resolve({status:res.statusCode,body:s,json:json,headers:res.headers});});});
  request.on('error',reject);request.end(body);
});}
function post(endpoint,token,payload){var body=JSON.stringify(payload);return req('POST',endpoint+'?t='+token,body,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});}
(async function(){
  try{
    var start=await call('startConfig',{playlists:[{id:'profile-old',url:'https://example.test/a.m3u?token=SECRET',title:'Yosso',epg:'https://example.test/guide.xml.gz',source:'url'}],activePlaylistId:'profile-old'});
    assert(start.returnValue,JSON.stringify(start));var token=start.url.split('t=')[1];
    var ping=await call('ping');assert.equal(ping.serviceVersion,'0.3.7');
    var page=await req('GET','/?t='+token);assert.equal(page.status,200);assert(page.body.indexOf('Файл M3U')!==-1);assert(page.body.indexOf('Плейлисты')!==-1);
    var noToken=await req('GET','/api/state');assert.equal(noToken.status,403);
    var initial=await req('GET','/api/state?t='+token);assert(initial.json.returnValue);assert.equal(initial.json.playlists.length,1);
    assert.equal(initial.json.playlists[0].title,'Yosso');
    var m3u='#EXTM3U\n#EXTINF:-1 tvg-id="test" group-title="Test",Сканированный канал\nhttps://video.example/stream.m3u8\n';
    var upload=await req('POST','/api/upload?t='+token,Buffer.from(m3u),{'Content-Type':'application/octet-stream','X-PTV-Meta':encodeURIComponent(JSON.stringify({id:'',title:'Из файла',epg:'',activate:true}))});
    assert.equal(upload.status,200,upload.body);var id=upload.json.id;assert(id);
    var s=await req('GET','/api/state?t='+token);assert.equal(s.json.playlists.length,2);assert.equal(s.json.activePlaylistId,id);assert.equal(s.json.playlists[1].source,'file');
    var local=s.json.playlists[1].url;assert(/^ptv-file:\/\/[0-9a-f]{24}$/.test(local));
    var localData=await call('getText',{url:local,playlist:true});assert(localData.returnValue&&localData.imported&&localData.cached,JSON.stringify(localData));assert.equal(localData.text,m3u);
    var files=fs.readdirSync(dir).filter(function(fn){return fn.indexOf('playlist-')===0;});assert.equal(files.length,1);assert(files[0].endsWith('.json.gz'));
    var bad=await req('POST','/api/upload?t='+token,'<html>error</html>',{'Content-Type':'application/octet-stream','X-PTV-Meta':encodeURIComponent(JSON.stringify({title:'Bad'}))});assert.equal(bad.status,400);
    var update=await post('/api/profile',token,{id:id,title:'Из файла - новая версия',source:'file',epg:'http://example.test/epg.xml.gz'});assert.equal(update.status,200,update.body);
    var extra=await post('/api/profile',token,{title:'Ещё IPTV',source:'url',url:'https://other.test/iptv.m3u',epg:'',activate:false});assert.equal(extra.status,200,extra.body);
    s=await req('GET','/api/state?t='+token);assert.equal(s.json.playlists.length,3);
    var change=await call('getConfigChanges',{since:start.revision});assert(change.changed);assert.equal(change.config.playlists.length,3);
    var acknowledged=await call('ackConfigChanges',{revision:change.revision});assert(acknowledged.returnValue);
    change=await call('getConfigChanges',{since:change.revision});assert.equal(change.changed,false);
    var activation=await post('/api/activate',token,{id:'profile-old'});assert.equal(activation.status,200);
    var deletion=await post('/api/delete',token,{id:extra.json.id});assert.equal(deletion.status,200);
    var postDelete=await req('GET','/api/state?t='+token);assert.equal(postDelete.json.playlists.length,2);
    var stopped=await call('stopConfig');assert(stopped.returnValue);
    console.log('PASS 0.3.7: multi-profile web editor, URL add, file import, disk cache, activate, delete, service sync, auth and filename safety');
  }catch(e){console.error('FAIL',e.stack||e);process.exitCode=1;try{await call('stopConfig');}catch(x){}}
})();

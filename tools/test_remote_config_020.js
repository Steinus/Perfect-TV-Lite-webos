'use strict';
var assert=require('assert'),http=require('http'),querystring=require('querystring'),path=require('path'),Module=require('module');
var handlers={},original=Module._load;
Module._load=function(n,p,m){if(n==='webos-service')return function(){this.register=function(action,fn){handlers[action]=fn;};};return original.apply(this,arguments);};
require(path.resolve(__dirname,'../service/service.js'));Module._load=original;
function call(name,payload){return new Promise(function(done){handlers[name]({payload:payload||{},respond:done});});}
function req(method,path,post){return new Promise(function(resolve,reject){
 var data=post?querystring.stringify(post):'',opts={host:'127.0.0.1',port:8098,path:path,method:method,headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(data)}};
 var r=http.request(opts,function(res){var s='';res.on('data',function(c){s+=c;});res.on('end',function(){resolve({code:res.statusCode,location:res.headers.location,body:s});});});r.on('error',reject);r.end(data);
});}
(async function(){
 var result=await call('startConfig',{url:'http://example.test/stream.m3u?secret=PRIVATE',epg:'http://example.test/epg.xml.gz',title:'Yosso'});
 assert(result.returnValue,JSON.stringify(result));assert(result.qrSvg.indexOf('<svg')>=0);assert.equal(result.pin.length,6);
 assert(result.url.includes(':8098/?t='));var token=result.url.split('t=')[1];
 var home=await req('GET','/');assert.equal(home.code,200);assert(home.body.includes('код с экрана'));
 var forbidden=await req('GET','/?t=wrong');assert.equal(forbidden.code,403);
 var invalid=await req('POST','/auth',{pin:'000000'});assert.equal(invalid.code,403);
 var auth=await req('POST','/auth',{pin:result.pin});assert.equal(auth.code,303);assert(auth.location.includes(token));
 var form=await req('GET','/?t='+token);assert.equal(form.code,200);assert(form.body.includes('Плейлисты')); var api=await req('GET','/api/state?t='+token); assert(api.body.includes('PRIVATE')); 
 var save=await req('POST','/save?t='+token,{url:'https://new.example/playlist.m3u',epg:'https://new.example/epg.xml.gz',title:'Новое'});assert.equal(save.code,200);
 var change=await call('getConfigChanges',{since:0});assert(change.changed);assert.equal(change.config.title,'Новое');
 var stopped=await call('stopConfig',{});assert(stopped.returnValue);
 console.log('PASS: web server 8098; QR svg, PIN access, unauthorized 403, config save, Luna update, stop');
})().catch(function(e){console.error(e);process.exitCode=1;try{handlers.stopConfig({payload:{},respond:function(){}})}catch(err){}});

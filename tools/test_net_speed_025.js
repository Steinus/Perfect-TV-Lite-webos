'use strict';
var assert=require('assert'),path=require('path'),Module=require('module'),realFs=require('fs');
var handlers={},original=Module._load;
var procDev='',procRoute='Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 0101A8C0 0003 0 0 0 00000000 0 0 0\n';
function setCounters(rx,tx){
  procDev='Inter-| Receive | Transmit\nface |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n'+
    ' eth0: '+rx+' 1 0 0 0 0 0 0 '+tx+' 1 0 0 0 0 0 0\n'+
    ' lo: 1000 1 0 0 0 0 0 0 1000 1 0 0 0 0 0 0\n';
}
setCounters(100000,300000);
var fakeFs=Object.create(realFs);
fakeFs.readFileSync=function(p){
  if(p==='/proc/net/dev')return procDev;
  if(p==='/proc/net/route')return procRoute;
  return realFs.readFileSync.apply(realFs,arguments);
};
Module._load=function(name,parent,isMain){
  if(name==='webos-service')return function(){this.register=function(action,cb){handlers[action]=cb;};};
  if(name==='fs'&&parent&&String(parent.filename||'').indexOf('/service/service.js')>=0)return fakeFs;
  return original.apply(this,arguments);
};
require(path.join(__dirname,'../service/service.js'));
Module._load=original;
function sample(){var result;handlers.getNetworkSpeed({payload:{},respond:function(x){result=x;}});return result;}
(async function(){
  var a=sample();assert(a.returnValue&&!a.available&&a.iface==='eth0',JSON.stringify(a));
  await new Promise(function(resolve){setTimeout(resolve,300);});
  setCounters(400000,310000);
  var b=sample();
  assert(b.returnValue&&b.available&&b.scope==='whole-tv',JSON.stringify(b));
  assert(b.rxBytesPerSec>900000&&b.rxBytesPerSec<1100000,JSON.stringify(b));
  assert(b.txBytesPerSec>25000&&b.txBytesPerSec<40000,JSON.stringify(b));
  // Counters must never create negative rates when the interface restarts.
  await new Promise(function(resolve){setTimeout(resolve,260);});
  setCounters(100,500);
  var c=sample();assert(c.returnValue&&!c.available,JSON.stringify(c));
  fakeFs.readFileSync=function(p){if(p==='/proc/net/dev')throw new Error('permission denied');return procRoute;};
  var d=sample();assert(!d.returnValue&&!d.available,JSON.stringify(d));
  console.log('PASS: whole-TV network speed measured by counter deltas, reset and access errors handled');
})().catch(function(e){console.error(e);process.exitCode=1;});

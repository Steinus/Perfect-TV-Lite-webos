'use strict';
// Compact IPTV / XMLTV network helper for old LG webOS TVs.
// Heavy XMLTV documents are parsed in the service, never in the TV web view.
var Service = require('webos-service');
var http = require('http');
var https = require('https');
var childProcess = require('child_process');
var zlib = require('zlib');
var stream = require('stream');
var StringDecoder = require('string_decoder').StringDecoder;
var urlLib = require('url');
var crypto=require('crypto');
var os=require('os');
var fs=require('fs');
var querystring=require('querystring');
var QRCode=require('./qr');
var QRLevel=require('./qr/QRErrorCorrectLevel');
var diskCache=require('./cache');
var service = new Service('com.steinus.perfecttvwebos.network');
// UA for every HTTP(S) GET initiated by this Node.js webOS service.
// The native HTML5 video engine has its own transport/UA outside this service.
var HTTP_USER_AGENT = 'PerfecktTV';
var MAX_TEXT = 24 * 1024 * 1024;
var MAX_EPG_WIRE = 384 * 1024 * 1024;
var MAX_EPG_UNCOMPRESSED = 384 * 1024 * 1024;
var activeEpgJob = null;
// System-wide network interface counters: native webOS video traffic is not
// visible to browser JavaScript, so do not claim these numbers are per-channel.
var lastNetSample=null;
function readNetCounters(){
  var rows=fs.readFileSync('/proc/net/dev','utf8').split(/\r?\n/);
  var counters=Object.create(null);
  for(var i=2;i<rows.length;i++){
    var colon=rows[i].indexOf(':');
    if(colon<0)continue;
    var iface=rows[i].slice(0,colon).trim();
    var numbers=rows[i].slice(colon+1).trim().split(/\s+/);
    if(numbers.length<16||iface==='lo')continue;
    var rx=Number(numbers[0]),tx=Number(numbers[8]);
    if(isFinite(rx)&&isFinite(tx)&&rx>=0&&tx>=0)counters[iface]={rx:rx,tx:tx};
  }
  var name='';
  // Prefer the device's actual default-route interface (usually eth0/wlan0).
  // This avoids double-counting bridges or virtual adapters.
  try{
    var routes=fs.readFileSync('/proc/net/route','utf8').split(/\r?\n/);
    var bestMetric=Infinity;
    for(var j=1;j<routes.length;j++){
      var route=routes[j].trim().split(/\s+/);
      if(route.length<8||route[1]!=='00000000'||!counters[route[0]])continue;
      var flags=parseInt(route[3],16),metric=Number(route[6]);
      if((flags&1)&&metric<bestMetric){name=route[0];bestMetric=metric;}
    }
  }catch(e){}
  if(!name){
    var all=os.networkInterfaces();
    for(var dev in all){
      if(!Object.prototype.hasOwnProperty.call(all,dev)||!counters[dev])continue;
      var addresses=all[dev];
      for(var a=0;a<addresses.length;a++)if(!addresses[a].internal&&addresses[a].family==='IPv4'){
        name=dev;break;
      }
      if(name)break;
    }
  }
  if(!name){
    for(var fallback in counters)if(Object.prototype.hasOwnProperty.call(counters,fallback)&&/^(eth|en|wl|wifi|rmnet)/i.test(fallback)){
      name=fallback;break;
    }
  }
  if(!name)throw new Error('Сетевой интерфейс не обнаружен');
  return {iface:name,rx:counters[name].rx,tx:counters[name].tx};
}

var lastEpgJob = null;
// Bounded in-memory EPG guide; nothing written to the TV's storage.
var cachedGuides = null;
var MAX_GUIDE_PER_CHANNEL = 320;
var MAX_GUIDE_TOTAL = 260000;
var MAX_GUIDE_DESC = 1400;
var MAX_GUIDE_BROWSE_DESC = 550;
// Bounded descriptions for selected past/future shows; no XMLTV file on disk.
// JavaScript strings use UTF-16: 12 Mi characters = at most ~24 MiB of text.
var MAX_GUIDE_DESCRIPTION_CHARS = 12 * 1024 * 1024;
var GUIDE_DAYS_PAST = 7;
var GUIDE_DAYS_FUTURE = 8;
var XML_BLOCK_RE = /<(channel|programme)\b/gi;
var ATTR_RE = {
  id: /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  channel: /(?:^|\s)channel\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  start: /(?:^|\s)start\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  stop: /(?:^|\s)stop\s*=\s*(?:"([^"]*)"|'([^']*)')/i
};

// LAN-only, in-memory remote settings editor. It runs only while the TV
// settings dialog is open. A random per-session URL token prevents accidental
// edits by other clients on the same LAN. Never open/forward its port to WAN.
var CONFIG_PORT=8098;
var configServer=null,configToken='',configPin='',configRevision=0,configSaved=null;
var pinAttempts=Object.create(null);
var configPrefs={playlists:[],activePlaylistId:''};
var MAX_UPLOAD_TEXT=12*1024*1024;
var LOCAL_PLAYLIST_RE=/^ptv-file:\/\/[0-9a-f]{24}$/;
function localPlaylistUrl(url){return LOCAL_PLAYLIST_RE.test(String(url||''));}
function safeProfile(value){
  if(!value||typeof value!=='object')return null;
  var source=value.source==='file'?'file':'url';
  var url=String(value.url||'').trim();
  if(source==='file'?!localPlaylistUrl(url):!validUrl(url))return null;
  var epg=String(value.epg||'').trim();
  if(epg&&(!validUrl(epg)||epg.length>4096))return null;
  var id=String(value.id||'');
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return null;
  var title=String(value.title||'Плейлист').trim().slice(0,100)||'Плейлист';
  return {id:id,url:url,epg:epg,title:title,source:source,lastKey:String(value.lastKey||'').slice(0,4096)};
}
function safeProfileSet(raw,active){
  var items=[],found=Object.create(null),list=Array.isArray(raw)?raw:[];
  for(var i=0;i<list.length&&items.length<12;i++){
    var item=safeProfile(list[i]);if(!item||found[item.id])continue;
    found[item.id]=true;items.push(item);
  }
  var selected=String(active||'');
  if(!found[selected])selected=items.length?items[0].id:'';
  return {playlists:items,activePlaylistId:selected};
}
function configPublicState(){
  return {returnValue:true,revision:configRevision,playlists:configPrefs.playlists,
    activePlaylistId:configPrefs.activePlaylistId};
}
function configCommit(){
  configRevision++;
  configSaved=configPublicState();
  var current=configPrefs.playlists.filter(function(p){return p.id===configPrefs.activePlaylistId;})[0];
  if(current){configSaved.url=current.url;configSaved.epg=current.epg;configSaved.title=current.title;}
}
function newConfigId(){return 'profile-'+Date.now()+'-'+crypto.randomBytes(5).toString('hex');}
function configSetProfile(item,activate){
  var existing=-1;
  for(var i=0;i<configPrefs.playlists.length;i++)if(configPrefs.playlists[i].id===item.id){existing=i;break;}
  if(existing<0){if(configPrefs.playlists.length>=12)return false;configPrefs.playlists.push(item);}
  else configPrefs.playlists[existing]=item;
  if(activate||!configPrefs.activePlaylistId)configPrefs.activePlaylistId=item.id;
  configCommit();return true;
}
function lanAddress(){
  var interfaces=os.networkInterfaces(),best='',secondary='';
  for(var iface in interfaces){
    if(!Object.prototype.hasOwnProperty.call(interfaces,iface))continue;
    var records=interfaces[iface];
    for(var i=0;i<records.length;i++){
      var a=records[i];
      if(a.internal || a.family!=='IPv4')continue;
      var ip=a.address;
      if(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip)){
        if(/^(eth|en|wlan|wifi)/i.test(iface))return ip;
        if(!best)best=ip;
      }else if(!secondary)secondary=ip;
    }
  }
  return best||secondary;
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function configAddress(){var ip=lanAddress();return ip?'http://'+ip+':'+CONFIG_PORT+'/?t='+configToken:'';}
function makeQR(value){
  try{
    var qr=new QRCode(-1,QRLevel.M);qr.addData(value);qr.make();
    var n=qr.getModuleCount(),path=[];
    for(var y=0;y<n;y++)for(var x=0;x<n;x++)if(qr.isDark(y,x))path.push('M'+x+' '+y+'h1v1h-1z');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 '+(n+8)+' '+(n+8)+'" width="218" height="218"><rect x="-4" y="-4" width="'+(n+8)+'" height="'+(n+8)+'" fill="#fff"/><path fill="#0a192d" d="'+path.join('')+'"/></svg>';
  }catch(e){return '';}
}
function configReply(message,ok,error){
  var url=configAddress();
  message.respond({returnValue:ok,url:url,qrSvg:url?makeQR(url):'',port:CONFIG_PORT,pin:configPin,revision:configRevision,errorText:error||'',localIP:lanAddress()});
}
function renderConfigPage(){
  // HTML and JS are packaged locally, not fetched from a CDN.
  try{return fs.readFileSync(__dirname+'/config-page.html','utf8');}
  catch(e){return '<!doctype html><meta charset="utf-8"><h2>Веб-редактор недоступен: файл не включён в IPK</h2>';}
}
function sendConfig(res,status,body){
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache',
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
  res.end(body);
}
function sendConfigJSON(res,status,obj){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify(obj));
}
function readConfigRequest(req,max,cb){
  var chunks=[],total=0,oversize=false,ended=false;
  req.on('data',function(part){total+=part.length;if(total>max){oversize=true;return;}chunks.push(part);});
  req.on('end',function(){if(ended)return;ended=true;if(oversize){cb(new Error('Размер запроса превышен'));return;}
    cb(null,Buffer.concat(chunks,total));});
  req.on('error',function(e){if(!ended){ended=true;cb(e);}});
}
function configFindProfile(id){
  for(var i=0;i<configPrefs.playlists.length;i++)if(configPrefs.playlists[i].id===id)return configPrefs.playlists[i];
  return null;
}
function configApiHandler(req,res,path){
  if(path==='/api/state'&&req.method==='GET'){sendConfigJSON(res,200,configPublicState());return;}
  if(req.method!=='POST'){sendConfigJSON(res,405,{returnValue:false,errorText:'Метод не разрешён'});return;}
  if(path==='/api/upload'){
    var meta;
    try{var header=String(req.headers['x-ptv-meta']||'');if(header.length>8192)throw Error('Слишком длинные параметры');meta=JSON.parse(decodeURIComponent(header));}
    catch(e){sendConfigJSON(res,400,{returnValue:false,errorText:'Неверные параметры импорта'});req.resume();return;}
    var edit=meta&&configFindProfile(String(meta.id||''));
    if(!edit&&configPrefs.playlists.length>=12){sendConfigJSON(res,409,{returnValue:false,errorText:'Максимум 12 плейлистов'});req.resume();return;}
    var title=String(meta.title||'').trim().slice(0,100)||'Импортированный M3U';
    var epg=String(meta.epg||'').trim();
    if(epg&&(!validUrl(epg)||epg.length>4096)){sendConfigJSON(res,400,{returnValue:false,errorText:'Неверный EPG URL'});req.resume();return;}
    readConfigRequest(req,MAX_UPLOAD_TEXT,function(error,buffer){
      if(error){sendConfigJSON(res,413,{returnValue:false,errorText:'Файл M3U превышает 12 МБ'});return;}
      var text=buffer.toString('utf8').replace(/^\uFEFF/,'');
      if(!/^\s*#EXTM3U\b/m.test(text)||text.indexOf('#EXTINF')<0){sendConfigJSON(res,400,{returnValue:false,errorText:'В файле нет корректного M3U (#EXTM3U, #EXTINF)'});return;}
      var fileUrl=(edit&&edit.source==='file'&&localPlaylistUrl(edit.url))?edit.url:'ptv-file://'+crypto.randomBytes(12).toString('hex');
      diskCache.writePlaylist(fileUrl,text,function(e,info){
        if(e){sendConfigJSON(res,507,{returnValue:false,errorText:'Не удалось сохранить M3U в кэш: '+String(e.message||e)});return;}
        var id=edit?edit.id:newConfigId();
        if(!configSetProfile({id:id,url:fileUrl,title:title,epg:epg,source:'file',lastKey:edit&&edit.url===fileUrl?edit.lastKey:''},!!meta.activate)){
          sendConfigJSON(res,409,{returnValue:false,errorText:'Максимум 12 плейлистов'});return;
        }
        sendConfigJSON(res,200,{returnValue:true,id:id,cacheBytes:info&&info.bytes||0,revision:configRevision});
      });
    });
    return;
  }
  readConfigRequest(req,12000,function(error,body){
    if(error){sendConfigJSON(res,413,{returnValue:false,errorText:'Превышен размер данных'});return;}
    var data;
    try{data=JSON.parse(body.toString('utf8')||'{}');}catch(e){sendConfigJSON(res,400,{returnValue:false,errorText:'Неверный JSON'});return;}
    var id=String(data.id||''),old=configFindProfile(id);
    if(path==='/api/activate'){
      if(!old){sendConfigJSON(res,404,{returnValue:false,errorText:'Профиль не найден'});return;}
      configPrefs.activePlaylistId=id;configCommit();sendConfigJSON(res,200,{returnValue:true,id:id});return;
    }
    if(path==='/api/delete'){
      if(!old){sendConfigJSON(res,404,{returnValue:false,errorText:'Профиль не найден'});return;}
      if(configPrefs.playlists.length<2){sendConfigJSON(res,409,{returnValue:false,errorText:'Нельзя удалить последний плейлист'});return;}
      configPrefs.playlists=configPrefs.playlists.filter(function(p){return p.id!==id;});
      if(configPrefs.activePlaylistId===id)configPrefs.activePlaylistId=configPrefs.playlists[0].id;
      configCommit();
      if(old.source==='file'&&!configPrefs.playlists.some(function(p){return p.url===old.url;}))diskCache.removePlaylist(old.url,function(){});
      sendConfigJSON(res,200,{returnValue:true,id:id});return;
    }
    if(path==='/api/profile'){
      if(!old&&configPrefs.playlists.length>=12){sendConfigJSON(res,409,{returnValue:false,errorText:'Максимум 12 плейлистов'});return;}
      var source=data.source==='file'?'file':'url';
      var url=source==='file'&&old&&old.source==='file'?old.url:String(data.url||'').trim();
      var entry=safeProfile({id:old?old.id:newConfigId(),url:url,title:data.title,epg:data.epg,source:source,lastKey:old&&old.url===url?old.lastKey:''});
      if(!entry){sendConfigJSON(res,400,{returnValue:false,errorText:'Не указан корректный источник M3U или EPG'});return;}
      configSetProfile(entry,!!data.activate);
      if(old&&old.source==='file'&&old.url!==entry.url&&!configPrefs.playlists.some(function(p){return p.url===old.url;}))diskCache.removePlaylist(old.url,function(){});
      sendConfigJSON(res,200,{returnValue:true,id:entry.id,revision:configRevision});return;
    }
    sendConfigJSON(res,404,{returnValue:false,errorText:'Страница не найдена'});
  });
}
function configHandler(req,res){
  var u=urlLib.parse(req.url,true),token=u.query&&u.query.t;
  if(!token&&u.pathname==='/'&&req.method==='GET'){
    sendConfig(res,200,'<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#171a1e;color:#fff;font:19px Arial;padding:30px;max-width:460px;margin:auto"><h2>Perfect TV Lite</h2><p>Введи код с экрана телевизора.</p><form action="/auth" method="POST"><input name="pin" type="text" inputmode="numeric" maxlength="6" autocomplete="off" style="font-size:24px;padding:13px;width:100%"><button style="font-size:20px;padding:13px;margin-top:12px;width:100%">Открыть плейлисты</button></form></body></html>');return;
  }
  if(u.pathname==='/auth'&&req.method==='POST'){
    var key=String(req.connection&&req.connection.remoteAddress||'local');
    var attempt=pinAttempts[key]||{count:0,time:Date.now()};
    if(Date.now()-attempt.time>60000)attempt={count:0,time:Date.now()};
    pinAttempts[key]=attempt;
    if(attempt.count>=8){sendConfig(res,429,'Слишком много попыток. Повтори через минуту.');return;}
    readConfigRequest(req,1000,function(err,body){
      if(err){sendConfig(res,413,'Слишком длинный запрос');return;}
      var v=querystring.parse(body.toString('utf8'));
      if(String(v.pin||'')!==configPin||!configPin){attempt.count++;sendConfig(res,403,'Неверный код.');return;}
      attempt.count=0;
      res.writeHead(303,{'Location':'/?t='+configToken,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();
    });return;
  }
  if(!configToken||token!==configToken){sendConfig(res,403,'Доступ запрещён. Открой QR-код на телевизоре.');req.resume();return;}
  if(req.method==='GET'&&u.pathname==='/'){sendConfig(res,200,renderConfigPage());return;}
  if(u.pathname.indexOf('/api/')===0){configApiHandler(req,res,u.pathname);return;}
  // Preserve the legacy POST /save for older TV web views.
  if(req.method==='POST'&&u.pathname==='/save'){
    readConfigRequest(req,12000,function(err,body){
      if(err){sendConfig(res,413,'Превышен размер данных');return;}
      var f=querystring.parse(body.toString('utf8'));
      var previous=configFindProfile(configPrefs.activePlaylistId),entry=safeProfile({id:previous?previous.id:newConfigId(),url:f.url,epg:f.epg,title:f.title,source:'url'});
      if(!entry){sendConfig(res,400,'Неправильный URL или EPG');return;}
      if(!configSetProfile(entry,true)){sendConfig(res,409,'Максимум 12 плейлистов');return;}
      sendConfig(res,200,'<!doctype html><meta charset="utf-8"><h2>Сохранено</h2><p>Настройки переданы телевизору.</p>');
    });return;
  }
  sendConfig(res,404,'Страница не найдена');
}
service.register('startConfig',function(message){
  var p=message.payload||{};
  if(Array.isArray(p.playlists))configPrefs=safeProfileSet(p.playlists,p.activePlaylistId);
  else if(p.url){
    var old=configFindProfile(configPrefs.activePlaylistId),entry=safeProfile({id:old?old.id:newConfigId(),url:p.url,epg:p.epg,title:p.title,source:'url'});
    if(entry)configPrefs=safeProfileSet([entry],entry.id);
  }
  if(configServer){configReply(message,true);return;}
  configSaved=null;
  configToken=crypto.randomBytes(16).toString('hex');configPin=('000000'+(crypto.randomBytes(4).readUInt32BE(0)%1000000)).slice(-6);pinAttempts=Object.create(null);
  var instance=http.createServer(configHandler),finished=false;
  instance.on('error',function(err){
    if(configServer===instance)configServer=null;
    configToken='';
    if(!finished){finished=true;message.respond({returnValue:false,errorText:'HTTP-сервер: '+(err.code||err.message)});}
  });
  instance.listen(CONFIG_PORT,'0.0.0.0',function(){
    configServer=instance;
    if(!finished){finished=true;configReply(message,true);}
  });
});
service.register('syncConfig',function(message){
  var p=message.payload||{};
  if(!configServer){message.respond({returnValue:false,errorText:'Веб-редактор закрыт'});return;}
  if(configSaved){message.respond({returnValue:true,revision:configRevision,skipped:true});return;}
  configPrefs=safeProfileSet(p.playlists,p.activePlaylistId);
  message.respond({returnValue:true,revision:configRevision});
});
service.register('ackConfigChanges',function(message){
  var r=Number(message.payload&&message.payload.revision||0);
  if(configSaved&&r===configRevision)configSaved=null;
  message.respond({returnValue:true,revision:configRevision});
});
service.register('getConfigChanges',function(message){
  var since=Number(message.payload&&message.payload.since||0);
  message.respond({returnValue:true,revision:configRevision,changed:!!configSaved&&configRevision>since,
    config:(configSaved&&configRevision>since)?configSaved:null});
});
service.register('stopConfig',function(message){
  configToken='';configPin='';configSaved=null;
  if(configServer){try{configServer.close();}catch(e){}configServer=null;}
  message.respond({returnValue:true});
});

// One lightweight counter read per UI request; no sockets, temporary files or
// continuous background sampler. /proc/net/dev is available on Linux kernels.
service.register('getNetworkSpeed',function(message){
  try{
    var now=Date.now(),sample=readNetCounters();
    var old=lastNetSample;lastNetSample={iface:sample.iface,rx:sample.rx,tx:sample.tx,ms:now};
    var dt=old?(now-old.ms):0;
    var valid=!!(old&&old.iface===sample.iface&&dt>=250&&dt<=30000&&sample.rx>=old.rx&&sample.tx>=old.tx);
    message.respond({returnValue:true,available:valid,scope:'whole-tv',iface:sample.iface,
      rxBytesPerSec:valid?Math.round((sample.rx-old.rx)*1000/dt):null,
      txBytesPerSec:valid?Math.round((sample.tx-old.tx)*1000/dt):null,
      sampleMs:dt});
  }catch(e){lastNetSample=null;message.respond({returnValue:false,available:false,
    errorText:'Сетевые счётчики недоступны: '+(e.code||e.message)});}
});

service.register('ping', function (message) {
  message.respond({returnValue:true, serviceVersion:'0.3.7', epgStreaming:true, userAgent:HTTP_USER_AGENT, playlistTransport:'curl with Node fallback'});
});

// Subscribed web view keeps the JS service and its compact guide cache alive.
// The bus releases this subscription when the TV app closes.
service.register('holdGuide', function (message) {
  message.respond({returnValue:true, subscribed:!!message.isSubscription, ready:!!cachedGuides});
}, function (message) {});


// Reload the compact schedule from disk and derive "now / next" using TV time.
// Never trust a saved "current" item: it becomes stale as soon as a show ends.
var cachedSignature='';
var cachedUrl='';
function entriesFromSaved(guide){
  var now=Date.now(),items=[],map=guide.byIndex||{};
  var keys=Object.keys(map);
  for(var i=0;i<keys.length;i++){
    var id=Number(keys[i]),rows=map[keys[i]],current=null,next=null;
    for(var j=0;j<rows.length;j++){
      var r=rows[j];if(!Array.isArray(r)||r.length<3)continue;
      if(r[1]<=now&&r[2]>now){if(!current||r[1]>current[1])current=r;}
      else if(r[1]>now){if(!next||r[1]<next[1])next=r;}
    }
    if(current||next)items.push([id,current,next]);
  }
  return items;
}
function applySavedEpg(saved,signatureId,url){
  cachedGuides=saved.guideCache;
  cachedSignature=signatureId;cachedUrl=url;
  var meta=saved.meta;
  var stats={};var k;
  for(k in meta.stats)if(Object.prototype.hasOwnProperty.call(meta.stats,k))stats[k]=meta.stats[k];
  stats.transport='кэш EPG';stats.cachedAt=meta.fetchedAt;stats.checkedAt=meta.checkedAt;
  stats.cacheBytes=meta.compressedBytes||0;stats.cacheFresh=Date.now()-meta.checkedAt<diskCache.DAY;
  return {returnValue:true,found:true,fresh:stats.cacheFresh,checkedAt:meta.checkedAt,cacheBytes:stats.cacheBytes,
    items:entriesFromSaved(cachedGuides),stats:stats};
}
service.register('getCachedEpg',function(message){
  var raw=String(message.payload&&message.payload.url||'').trim();
  var requested=message.payload&&message.payload.channels;
  if(!validUrl(raw)||!Array.isArray(requested)||requested.length>12000){message.respond({returnValue:false,errorText:'Некорректный запрос к кэшу EPG'});return;}
  var sign=diskCache.signature(requested);
  if(cachedGuides&&cachedSignature===sign&&cachedUrl===raw){
    // Disk metadata might have been refreshed by an ETag 304 response.
    diskCache.readMeta(function(err,meta){
      if(!err&&meta&&meta.signature===sign&&meta.url===raw){
        message.respond(applySavedEpg({guideCache:cachedGuides,meta:meta},sign,raw));
      }else message.respond({returnValue:true,found:false});
    },raw,sign);
    return;
  }
  diskCache.readEpg(raw,sign,function(err,saved){
    if(err){message.respond({returnValue:true,found:false,errorText:String(err.message||err)});return;}
    if(!saved){message.respond({returnValue:true,found:false});return;}
    message.respond(applySavedEpg(saved,sign,raw));
  });
});
service.register('getEpgNow',function(message){
  if(!cachedGuides){message.respond({returnValue:false,errorText:'EPG ещё не загружен'});return;}
  message.respond({returnValue:true,items:entriesFromSaved(cachedGuides)});
});
service.register('cacheStatus',function(message){
  diskCache.readMeta(function(err,meta){
    message.respond({returnValue:!err,found:!!meta,checkedAt:meta&&meta.checkedAt||0,
      bytes:meta&&meta.compressedBytes||0,source:meta&&meta.url||'',root:diskCache.ROOT});
  });
});
service.register('getGuide', function (message) {
  var index = Number(message.payload && message.payload.index);
  if (!cachedGuides) {message.respond({returnValue:false,errorText:'EPG ещё не загружен в память сервиса'});return;}
  if (!isFinite(index) || index < 0 || Math.floor(index)!==index || index >= cachedGuides.requested) {
    message.respond({returnValue:false,errorText:'Неверный номер канала'});return;
  }
  var rows = cachedGuides.byIndex[index] || [];
  message.respond({returnValue:true, index:index, rows:rows,
    count:rows.length, truncated:!!cachedGuides.truncated,
    cacheTime:cachedGuides.time, memoryOnly:true});
});

service.register('getText', function (message) {
  var payload=message.payload||{};
  var raw=String(payload.url||'').trim(),playlist=payload.playlist===true;
  if(localPlaylistUrl(raw)){
    // Imported files must NEVER be resolved over HTTP. Cache-only operation.
    diskCache.readPlaylist(raw,function(e,cached){
      if(cached){message.respond({returnValue:true,text:cached.text,cached:true,imported:true,cacheSaved:true,updatedAt:cached.updatedAt});return;}
      message.respond({returnValue:false,errorText:'Файл M3U отсутствует в кэше телевизора. Импортируй его ещё раз через веб-редактор.'});
    });return;
  }
  if(!validUrl(raw)) {message.respond({returnValue:false,errorText:'Нужна ссылка HTTP(S) или импортированный файл'});return;}
  function download(){
    // Curl uses the TV's up-to-date TLS implementation. Old webOS Node 0.12
    // can stall at HTTPS handshake while its service still answers ping.
    // If curl is not available, keep the original Node HTTP path.
    fetchPlaylistResilient(raw,function(err,text,engine){
      if(err){message.respond({returnValue:false,errorText:String(err.message||err)});return;}
      if(!playlist){message.respond({returnValue:true,text:text,transport:engine});return;}
      diskCache.writePlaylist(raw,text,function(e,details){
        message.respond({returnValue:true,text:text,transport:engine,cached:false,cacheSaved:!e,
          cacheBytes:details&&details.bytes||0,cacheError:e?String(e.message||e):''});
      });
    });
  }
  if(playlist&&!payload.force){
    diskCache.readPlaylist(raw,function(e,cached){
      if(cached){message.respond({returnValue:true,text:cached.text,cached:true,cacheSaved:true,updatedAt:cached.updatedAt});return;}
      download();
    });
  }else download();
});

// Optional HLS master-playlist metadata. This is an advertised variant
// bandwidth/resolution, NOT a measurement of the currently decoded stream.
service.register('getHlsInfo', function (message) {
  var raw=String(message.payload&&message.payload.url||'').trim();
  if(!validUrl(raw)||!(/\.m3u8(?:[?#]|$)/i).test(raw)) {
    message.respond({returnValue:false,errorText:'Не похоже на URL HLS'});return;
  }
  fetchHlsMaster(raw,0,function(err,data){
    if(err){message.respond({returnValue:false,errorText:String(err.message||err)});return;}
    var re=/#EXT-X-STREAM-INF:([^\r\n]+)/g,m,max=0,resolution='';
    while((m=re.exec(data))!==null){
      var b=/\b(?:AVERAGE-BANDWIDTH|BANDWIDTH)=(\d+)/i.exec(m[1]);
      var r=/\bRESOLUTION=(\d+x\d+)/i.exec(m[1]);
      var n=b?Number(b[1]):0;
      if(n>max){max=n;resolution=r?r[1].replace('x','×'):'';}
    }
    message.respond({returnValue:true,bps:max,resolution:resolution,advertised:true});
  });
});
function fetchHlsMaster(raw,redirects,done){
  if(redirects>4){done(new Error('Слишком много перенаправлений HLS'));return;}
  getRequest(raw,function(err,res){
    if(err){done(err);return;}
    if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){
      var next=urlLib.resolve(raw,res.headers.location);res.resume();
      if(!validUrl(next))done(new Error('Неверный HLS редирект'));
      else fetchHlsMaster(next,redirects+1,done);
      return;
    }
    if(res.statusCode<200||res.statusCode>=300){res.resume();done(new Error('HLS HTTP '+res.statusCode));return;}
    var chunks=[],size=0,finished=false;
    function finish(e,t){if(finished)return;finished=true;done(e,t);}
    res.on('data',function(chunk){
      if(finished)return;
      size+=chunk.length;
      if(size>256*1024){finish(new Error('HLS манифест слишком большой'));res.destroy();return;}
      chunks.push(chunk);
    });
    res.on('end',function(){if(finished)return;
      try{
        var b=Buffer.concat(chunks),enc=String(res.headers['content-encoding']||'').toLowerCase();
        if(enc.indexOf('gzip')>=0)b=zlib.gunzipSync(b);
        else if(enc.indexOf('deflate')>=0)b=zlib.inflateSync(b);
        if(b.length>512*1024)throw new Error('HLS манифест слишком большой');
        finish(null,b.toString('utf8'));
      }catch(e){finish(e);}
    });
    res.on('error',function(e){finish(e);});
  });
}

service.register('getEpg', function (message) {
  var payload=message.payload||{};
  var raw=String(payload.url||'').trim(),requested=payload.channels;
  if(!validUrl(raw)) {message.respond({returnValue:false,errorText:'Нужна ссылка XMLTV HTTP(S)'});return;}
  if(!Array.isArray(requested)||requested.length>12000){message.respond({returnValue:false,errorText:'Некорректный список каналов'});return;}
  if(activeEpgJob){message.respond({returnValue:false,errorText:'EPG уже загружается'});return;}
  var signatureId=diskCache.signature(requested);
  var job={state:'connecting',startedAt:Date.now(),updatedAt:Date.now(),wireBytes:0,bytes:0,totalBytes:0,
    programmes:0,providerChannels:0,peakXmlBuffer:0,encoding:'pending',errorText:'',stop:null};
  activeEpgJob=job;lastEpgJob=job;
  diskCache.readMeta(function(err,meta){
    if(activeEpgJob!==job)return;
    var old=(!err&&meta&&meta.url===raw&&meta.signature===signatureId)?meta:null;
    var conditional=!payload.force&&old?{etag:old.etag,lastModified:old.lastModified}:null;
    fetchEpg(raw,requested,0,job,function(fetchErr,result){
      if(activeEpgJob!==job)return;
      function respond(error,response){
        activeEpgJob=null;job.updatedAt=Date.now();
        job.state=error?'error':'done';job.errorText=error?String(error.message||error):'';job.stop=null;
        if(error)message.respond({returnValue:false,errorText:job.errorText});
        else message.respond(response);
      }
      if(fetchErr){respond(fetchErr);return;}
      if(result&&result.notModified){
        // A 304 is usable only if its original guide file still exists.
        diskCache.readEpg(raw,signatureId,function(err2,saved){
          if(err2||!saved){respond(new Error('Сервер вернул 304, но локальный кэш EPG отсутствует'));return;}
          diskCache.touchEpg(saved.meta,function(err3,newMeta){
            if(err3){respond(err3);return;}
            saved.meta=newMeta;
            var reply=applySavedEpg(saved,signatureId,raw);
            reply.stats.transport='HTTP 304 · локальный EPG';reply.stats.notModified=true;
            respond(null,reply);
          });
        });
        return;
      }
      cachedGuides=result.guideCache;cachedSignature=signatureId;cachedUrl=raw;
      diskCache.writeEpg(raw,signatureId,result,result.validators||{},function(saveErr,written){
        var stats=result.stats||{};
        stats.cacheSaved=!saveErr;stats.cacheBytes=written&&written.compressedBytes||0;
        stats.cachedAt=written&&written.fetchedAt||Date.now();stats.checkedAt=stats.cachedAt;
        if(saveErr)stats.cacheError=String(saveErr.message||saveErr);
        respond(null,{returnValue:true,items:result.items,stats:stats});
      });
    },conditional);
  },raw,signatureId);
});

function epgProgressSnapshot(job) {
  if(!job)return {returnValue:true,running:false,state:'idle'};
  return {
    returnValue:true,running:activeEpgJob===job,state:job.state,
    wireBytes:job.wireBytes,bytes:job.bytes,totalBytes:job.totalBytes,
    programmes:job.programmes,providerChannels:job.providerChannels,
    peakXmlBuffer:job.peakXmlBuffer,encoding:job.encoding,
    startedAt:job.startedAt,updatedAt:job.updatedAt,
    errorText:job.errorText||''
  };
}
service.register('getEpgProgress', function (message) {
  message.respond(epgProgressSnapshot(activeEpgJob||lastEpgJob));
});
service.register('cancelEpg', function (message) {
  if(activeEpgJob && typeof activeEpgJob.stop==='function') {
    activeEpgJob.stop();
    message.respond({returnValue:true,cancelled:true});
  } else message.respond({returnValue:true,cancelled:false});
});

function validUrl(s) {return /^https?:\/\/[^\s]+$/i.test(s);}
// On LG webOS 4.x the packaged JS service uses Node 0.12. Some modern
// HTTPS servers no longer complete a TLS handshake with that old runtime.
// Try the system curl binary first, without exposing the playlist URL in
// command-line arguments (curl reads a config on stdin instead). Keep the
// original Node client as a fallback, so installations without curl still work.
function curlBinary(){
  var paths=['/usr/bin/curl','/bin/curl','/usr/builtin/bin/curl','/usr/local/bin/curl'];
  for(var i=0;i<paths.length;i++){
    try{if(fs.statSync(paths[i]).isFile())return paths[i];}catch(e){}
  }
  return null;
}
function curlError(code){
  if(code===22)return 'HTTP 4xx/5xx от провайдера (curl 22)';
  if(code===28)return 'Истекло время ожидания M3U (curl 28)';
  if(code===60)return 'Ошибка проверки HTTPS-сертификата (curl 60)';
  if(code===6)return 'Не удалось определить DNS-имя (curl 6)';
  if(code===7)return 'Не удалось подключиться к серверу (curl 7)';
  if(code===35)return 'Не удалось установить TLS-соединение (curl 35)';
  return 'curl завершился с кодом '+code;
}
function unpackPlaylist(bytes,encoding){
  if(bytes.length>MAX_TEXT)throw new Error('M3U больше 24 МиБ');
  if(bytes[0]===31&&bytes[1]===139)bytes=zlib.gunzipSync(bytes);
  else if(encoding==='deflate')bytes=zlib.inflateSync(bytes);
  if(bytes.length>MAX_TEXT)throw new Error('Распакованный M3U больше 24 МиБ');
  return bytes.toString('utf8').replace(/^\uFEFF/,'');
}
function fetchTextCurl(raw,done){
  var executable=curlBinary();
  if(!executable){done(new Error('Системный curl не найден'));return;}
  if(raw.length>4096){done(new Error('Слишком длинный URL M3U'));return;}
  var child,completed=false,blocks=[],bytes=0;
  function finish(err,result){
    if(completed)return;
    completed=true;clearTimeout(watchdog);
    if(err&&child)try{child.kill('SIGTERM');}catch(e){}
    done(err||null,result||null);
  }
  // Only safe, constant switches are passed in argv. A signed playlist URL
  // (often containing a token) is fed via stdin; it is never logged.
  try{
    child=childProcess.spawn(executable,[
      '--silent','--show-error','--fail','--location','--max-redirs','5',
      '--compressed','--connect-timeout','10','--max-time','25',
      '--user-agent',HTTP_USER_AGENT,'--config','-'
    ]);
  }catch(e){done(new Error('Не удалось запустить curl: '+e.message));return;}
  var watchdog=setTimeout(function(){finish(new Error('curl не ответил за 28 секунд'));},28000);
  child.on('error',function(e){finish(new Error('Не удалось запустить curl: '+e.message));});
  child.stdout.on('data',function(chunk){
    if(completed)return;
    bytes+=chunk.length;
    if(bytes>MAX_TEXT){finish(new Error('M3U больше 24 МиБ'));return;}
    blocks.push(chunk);
  });
  // Do not include stderr in UI responses; curl can sometimes echo an URL
  // containing a provider token in diagnostics.
  child.stderr.on('data',function(){});
  child.on('close',function(code){
    if(completed)return;
    if(code!==0){finish(new Error(curlError(code)));return;}
    try{finish(null,unpackPlaylist(Buffer.concat(blocks)));}
    catch(e){finish(e);}
  });
  // Curl's --config - reads stdin. Escape quotes/backslashes inside the URL.
  // All other control switches remain fixed in argv.
  var config='url = "'+raw.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"\n';
  child.stdin.on('error',function(){});
  child.stdin.end(config,'utf8');
}
function fetchPlaylistResilient(raw,done){
  var completed=false;
  function finish(err,text,engine){if(completed)return;completed=true;done(err,text,engine);}
  fetchTextCurl(raw,function(curlErr,text){
    if(!curlErr){finish(null,text,'curl');return;}
    // Keep the existing Node path working, but don't let an unresponsive
    // remote host exceed the waiting time in the TV interface.
    var nodeReq=null;
    var timer=setTimeout(function(){
      finish(new Error(String(curlErr.message||curlErr)+'; Node HTTP не ответил за 22 с'));
      if(nodeReq&&typeof nodeReq.abort==='function')try{nodeReq.abort();}catch(e){}
    },22000);
    nodeReq=fetchText(raw,0,function(nodeErr,nodeText){
      if(completed)return;
      clearTimeout(timer);
      if(nodeErr){finish(new Error('curl: '+curlErr.message+'; Node HTTP: '+nodeErr.message));return;}
      finish(null,nodeText,'node');
    },18000);
  });
}
function fetchText(raw, redirects, done, timeoutMs) {
  if (redirects > 5) {done(new Error('Слишком много перенаправлений'));return;}
  var req = getRequest(raw, function (err, res) {
    if (err) {done(err);return;}
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      var next = urlLib.resolve(raw,res.headers.location);res.resume();
      if (!validUrl(next)) {done(new Error('Недопустимый редирект'));return;}
      fetchText(next, redirects+1, done,timeoutMs);return;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {res.resume();done(new Error('HTTP '+res.statusCode));return;}
    var chunks=[], size=0, finished=false;
    function complete(e, data) {if(finished)return;finished=true;done(e,data);}
    res.on('data',function(chunk){
      size+=chunk.length;
      if (size > MAX_TEXT) {complete(new Error('M3U больше 24 МБ'));res.destroy();return;}
      chunks.push(chunk);
    });
    res.on('end',function(){
      if(finished)return;
      try {
        var data=Buffer.concat(chunks),enc=String(res.headers['content-encoding']||'').toLowerCase();
        if(enc.indexOf('gzip')>=0 || data[0]===31&&data[1]===139) data=zlib.gunzipSync(data);
        else if(enc.indexOf('deflate')>=0) data=zlib.inflateSync(data);
        if(data.length>MAX_TEXT) {complete(new Error('Распакованный M3U больше 24 МБ'));return;}
        complete(null,data.toString('utf8').replace(/^\uFEFF/,''));
      } catch(e) {complete(e);}
    });
    res.on('error',function(e){complete(e);});
  },null,timeoutMs);
  return req;
}
function getRequest(raw,cb,extraHeaders,timeoutMs) {
  var target;
  try {target=urlLib.parse(raw);} catch(e) {cb(e);return null;}
  if (!target || (target.protocol!=='https:' && target.protocol!=='http:')) {cb(new Error('Недопустимый протокол'));return null;}
  var completed=false;
  function finish(err,res) {if(completed)return;completed=true;cb(err,res);}
  // Node.js v0.12 on webOS 4 does not support http.get(url, options, callback).
  // It needs http.get(options, callback) and req.setTimeout().
  target.headers={'User-Agent':HTTP_USER_AGENT,
      'Accept':'*/*','Accept-Encoding':'gzip, deflate','Connection':'close'};
  if(extraHeaders){
    if(extraHeaders.etag)target.headers['If-None-Match']=String(extraHeaders.etag);
    if(extraHeaders.lastModified)target.headers['If-Modified-Since']=String(extraHeaders.lastModified);
  }
  var req=(target.protocol==='https:'?https:http).get(target,function(res){finish(null,res);});
  req.setTimeout(timeoutMs||45000,function(){req.abort();finish(new Error('Превышено время ожидания HTTP'));});
  req.on('error',function(err){finish(err);});
  return req;
}
function decodeEntities(s) {
  return String(s||'').replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi,function(m,key){
    var k=key.toLowerCase(),n;
    if(k==='amp')return '&';if(k==='lt')return '<';if(k==='gt')return '>';
    if(k==='quot')return '"';if(k==='apos')return "'";if(k==='nbsp')return ' ';
    if(k.charAt(0)==='#') {
      n=k.charAt(1)==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);
      if(n>0 && n<65536)return String.fromCharCode(n);
    }
    return m;
  });
}
function stripText(s) {
  return decodeEntities(String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').trim();
}
function normalizeName(name) {
  // Remove TV quality and broadcaster suffixes without losing channel numbers.
  var s=stripText(name).toLowerCase().replace(/\u0451/g,'\u0435');
  s=s.replace(/\b(?:fhd|uhd|hd|sd|4k|1080p|720p|hevc|h265|h264|orig|original|iptv|backup)\b/gi,' ');
  s=s.replace(/(?:^|[\s_.\[\]()/+-])(?:\u043e\u0440\u0438\u0433|\u043e\u0440\u0438\u0433\u0438\u043d\u0430\u043b|\u0441\u043d\u0433)(?=$|[\s_.\[\]()/+-])/gi,' ');
  // Do not ignore timeshift markers like +2 or +4: their EPG differs.
  return s.replace(/[^a-z0-9\u0400-\u04ff+]+/gi,'').trim();
}
function addAlias(names,key,id) {
  if(!key)return;
  var list=names[key];if(!list){list=[];names[key]=list;}
  if(list.indexOf(id)<0)list.push(id);
}
function chooseChannel(schedules,keys,aliases,ids) {
  var i,j,k,entry,found=false;
  for(i=0;i<keys.length;i++) {
    if(!keys[i])continue;
    var value=String(keys[i]).trim();
    var byId=ids[value.toLowerCase()]||value;
    if(byId && schedules[byId] && (schedules[byId].current||schedules[byId].next)) {
      return {pair:schedules[byId],method:'id',known:true};
    }
    if(ids[value.toLowerCase()])found=true;
  }
  for(i=0;i<keys.length;i++) {
    k=normalizeName(keys[i]);
    if(!k||!aliases[k])continue;
    found=true;
    var list=aliases[k];
    for(j=0;j<list.length;j++) {
      entry=schedules[list[j]];
      if(entry && (entry.current||entry.next)) {
        return {pair:entry,method:'name',known:true};
      }
    }
  }
  return {pair:null,method:'none',known:found};
}
function attr(open, key) {
  var pattern=ATTR_RE[key];
  var m=pattern?pattern.exec(open):null;
  return m?decodeEntities(m[1]===undefined?m[2]:m[1]):'';
}

function xmlTime(t) {
  var m=/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\s*([+-])(\d\d)(\d\d))?/.exec(t||'');
  if(!m)return 0;
  var value=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
  if(m[7])value-=(m[7]==='+'?1:-1)*((+m[8])*60+(+m[9]))*60000;
  return value;
}

// One HTTP request. No file on disk, HTTP Range, browser XML, or retained XMLTV.
// Incoming chunks flow through zlib and StringDecoder into this parser.
function XmltvStream(job) {
  this.job=job;
  this.pending='';
  this.ids=Object.create(null);
  this.names=Object.create(null);
  this.schedules=Object.create(null);
  this.guides=Object.create(null);
  this.wanted=Object.create(null);
  this.reqIds=Object.create(null);
  this.reqNames=Object.create(null);
  this.guideEntries=0;
  this.guideTruncated=false;
  this.guideDescriptionChars=0;
  this.guideDescriptionCount=0;
  this.guideDescriptionUsage=Object.create(null);
  this.guideDescriptionLimit=9000;
  this.providerSample=[];
  this.now=Date.now();
  this.minGuide=this.now-GUIDE_DAYS_PAST*86400000;
  this.maxGuide=this.now+GUIDE_DAYS_FUTURE*86400000;
  this.maxFuture=this.now+36*60*60*1000;
}
XmltvStream.prototype.setRequested=function(requested) {
  // Budget is divided fairly between provider channels instead of retaining
  // every long description in RAM. Near-current shows take priority.
  this.guideDescriptionLimit=Math.max(2500,Math.min(16000,
    Math.floor(MAX_GUIDE_DESCRIPTION_CHARS/Math.max(1,requested.length))));
  for(var i=0;i<requested.length;i++){
    var row=requested[i];if(!row||!Array.isArray(row))continue;
    var theId=String(row[0]||'').toLowerCase().trim();
    if(theId)this.reqIds[theId]=1;
    var a=normalizeName(row[1]),b=normalizeName(row[2]);
    if(a)this.reqNames[a]=1;
    if(b)this.reqNames[b]=1;
  }
};
XmltvStream.prototype.offerGuideDescription=function(key,guide,item,desc,begin,end){
  if(!desc)return;
  // Preserve a useful excerpt for historical shows, not a 220 MB XML tree.
  var candidate=desc.slice(0,MAX_GUIDE_BROWSE_DESC),cost=candidate.length;
  var limit=this.guideDescriptionLimit;
  if(cost>limit){candidate=candidate.slice(0,limit);cost=candidate.length;}
  var usage=this.guideDescriptionUsage[key]||0;
  var near=function(row,now){
    return row[1]>now?row[1]-now:(row[2]<now?now-row[2]:0);
  };
  var distance=near(item,this.now);
  // Evict less relevant descriptions *on this channel* when full, keeping
  // the programme titles/times and recent details intact.
  while(usage+cost>limit){
    var worst=-1,worstDistance=distance;
    for(var i=0;i<guide.length;i++){
      var other=guide[i];
      if(other===item||!other[3])continue;
      var d=near(other,this.now);
      if(d>worstDistance){worstDistance=d;worst=i;}
    }
    if(worst<0)return;
    var freed=guide[worst][3].length;
    guide[worst].length=3;
    usage-=freed;this.guideDescriptionChars-=freed;this.guideDescriptionCount--;
  }
  if(this.guideDescriptionChars+cost>MAX_GUIDE_DESCRIPTION_CHARS)return;
  item[3]=candidate;
  this.guideDescriptionUsage[key]=usage+cost;
  this.guideDescriptionChars+=cost;this.guideDescriptionCount++;
};
XmltvStream.prototype.record=function(kind,block) {
  var at=block.indexOf('>');if(at<0)return;
  var head=block.slice(0,at+1),key,re,m;
  if(kind==='channel') {
    this.job.providerChannels++;
    key=attr(head,'id');if(!key)return;
    this.ids[key.toLowerCase()]=key;
    addAlias(this.names,normalizeName(key),key);
    var wanted=!!(this.reqIds[key.toLowerCase()] || this.reqNames[normalizeName(key)]);
    re=/<display-name\b[^>]*>([\s\S]*?)<\/display-name\s*>/gi;
    while((m=re.exec(block))!==null) {
      var norm=normalizeName(m[1]);
      addAlias(this.names,norm,key);
      if(this.reqNames[norm])wanted=true;
      if(this.providerSample.length<5)this.providerSample.push([key.slice(0,65),stripText(m[1]).slice(0,70)]);
    }
    if(wanted)this.wanted[key]=true;
    return;
  }
  this.job.programmes++;
  key=attr(head,'channel');if(!key)return;
  if(!this.wanted[key] && !this.reqIds[key.toLowerCase()])return;
  var begin=xmlTime(attr(head,'start')),end=xmlTime(attr(head,'stop'));
  if(!begin||!end||end<=this.minGuide||begin>this.maxGuide)return;
  var title=/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(block);
  var name=title?stripText(title[1]).slice(0,160):'Без названия';
  var isCurrent=(begin<=this.now && end>this.now);
  var isNearNext=(begin>this.now && begin<this.now+3*3600000);
  var descMatch=/<desc\b[^>]*>([\s\S]*?)<\/desc\s*>/i.exec(block);
  var desc=descMatch?stripText(descMatch[1]).slice(0,MAX_GUIDE_DESC):'';
  var item=[name,begin,end];
  var guide=this.guides[key];
  if(!guide){guide=[];this.guides[key]=guide;}
  if(guide.length<MAX_GUIDE_PER_CHANNEL && this.guideEntries<MAX_GUIDE_TOTAL){
    guide.push(item);this.guideEntries++;
    this.offerGuideDescription(key,guide,item,desc,begin,end);
  }else this.guideTruncated=true;
  if(end<=this.now||begin>this.maxFuture)return;
  var pair=this.schedules[key];
  if(!pair){pair={current:null,next:null};this.schedules[key]=pair;}
  if(isCurrent && (!pair.current||begin>pair.current[1]))pair.current=desc?[name,begin,end,desc]:[name,begin,end];
  else if(begin>this.now && (!pair.next||begin<pair.next[1]))pair.next=desc?[name,begin,end,desc]:[name,begin,end];
};
XmltvStream.prototype.push=function(text) {
  if(!text)return;
  var body=this.pending+text;
  if(body.length>this.job.peakXmlBuffer)this.job.peakXmlBuffer=body.length;
  var lowered=body.toLowerCase(),m,openEnd,closeAt,closing,kind;
  var remainderAt=-1;
  XML_BLOCK_RE.lastIndex=0;
  while((m=XML_BLOCK_RE.exec(body))!==null) {
    kind=m[1].toLowerCase();
    openEnd=body.indexOf('>',XML_BLOCK_RE.lastIndex);
    if(openEnd<0){remainderAt=m.index;break;}
    closing='</'+kind+'>';
    closeAt=lowered.indexOf(closing,openEnd+1);
    if(closeAt<0){remainderAt=m.index;break;}
    this.record(kind,body.slice(m.index,closeAt+closing.length));
    XML_BLOCK_RE.lastIndex=closeAt+closing.length;
  }
  // XML tag start can be split between two zlib chunks: retain a short tail.
  this.pending=remainderAt<0?body.slice(-24):body.slice(remainderAt);
  if(this.pending.length>2*1024*1024)throw new Error('XMLTV: элемент превышает 2 МиБ');
};
XmltvStream.prototype.finish=function(requested) {
  if(!this.job.providerChannels&&!this.job.programmes)throw new Error('XMLTV не распознан: 0 каналов и 0 передач');
  var items=[],matched=0,byId=0,byName=0,recognized=0,missingProgramme=0;
  for(var i=0;i<requested.length;i++) {
    var row=requested[i];if(!row||!Array.isArray(row))continue;
    var tvgId=String(row[0]||''),name=String(row[1]||''),tvgName=String(row[2]||'');
    var idMatch=chooseChannel(this.schedules,[tvgId],this.names,this.ids);
    var nameMatch=idMatch.pair?{pair:null,known:false}:chooseChannel(this.schedules,[tvgName,name],this.names,this.ids);
    var chosen=idMatch.pair?idMatch:nameMatch,isKnown=idMatch.known||nameMatch.known;
    if(isKnown)recognized++;
    if(chosen.pair) {
      items.push([i,chosen.pair.current,chosen.pair.next]);matched++;
      if(chosen.method==='id')byId++;else byName++;
    } else if(isKnown)missingProgramme++;
  }
  // Aliases are only resolved once after streaming; one provider guide can
  // be used by multiple HD/orig variants without duplicating the data.
  var byIndex=Object.create(null);
  for(var k=0;k<requested.length;k++){
    var rr=requested[k];if(!rr||!Array.isArray(rr))continue;
    var keys=[String(rr[0]||''),String(rr[2]||''),String(rr[1]||'')];
    var provider='';
    for(var j=0;j<keys.length&&!provider;j++){
      var raw=keys[j].toLowerCase().trim();
      if(raw&&this.ids[raw]&&this.guides[this.ids[raw]])provider=this.ids[raw];
    }
    for(var j=0;j<keys.length&&!provider;j++){
      var norm=normalizeName(keys[j]);var aliases=this.names[norm];
      if(aliases)for(var a=0;a<aliases.length;a++){
        if(this.guides[aliases[a]]){provider=aliases[a];break;}
      }
    }
    if(provider){
      var guide=this.guides[provider];
      // XMLTV is not guaranteed to be ordered by broadcast start time.
      guide.sort(function(x,y){return x[1]-y[1];});
      byIndex[k]=guide;
    }
  }
  var requestedSample=[];
  for(var r=0;r<requested.length&&requestedSample.length<4;r++) {
    var s=requested[r];if(s&&Array.isArray(s))requestedSample.push([String(s[0]||'').slice(0,60),String(s[1]||'').slice(0,70)]);
  }
  return {items:items,stats:{matched:matched,requested:requested.length,byId:byId,byName:byName,
    recognized:recognized,missingProgramme:missingProgramme,
    programmes:this.job.programmes,providerChannels:this.job.providerChannels,
    activeSchedules:Object.keys(this.schedules).length,
    samples:this.providerSample,requestedSample:requestedSample,
    peakXmlBuffer:this.job.peakXmlBuffer,
    guideEntries:this.guideEntries,guideTruncated:this.guideTruncated,
    guideDescriptionChars:this.guideDescriptionChars,guideDescriptionCount:this.guideDescriptionCount,
    guideDescriptionLimit:this.guideDescriptionLimit,
    bytes:this.job.bytes,wireBytes:this.job.wireBytes,encoding:this.job.encoding,transport:'HTTP stream'},
    guideCache:{byIndex:byIndex,requested:requested.length,truncated:this.guideTruncated,time:Date.now()}};
};

function fetchEpg(raw,requested,redirects,job,done,conditional) {
  if(redirects>5){done(new Error('Слишком много перенаправлений XMLTV'));return;}
  var completed=false,req=null,res=null,unzip=null,decoder=new StringDecoder('utf8');
  var parser=new XmltvStream(job),sourceFinished=false,firstData=null;
  parser.setRequested(requested);
  function complete(err,result) {
    if(completed)return;
    completed=true;
    if(err){
      if(req)try{req.abort();}catch(e){}
      if(res&&res.destroy)try{res.destroy();}catch(e){}
      if(unzip&&unzip.destroy)try{unzip.destroy();}catch(e){}
    }
    done(err,result);
  }
  job.stop=function(){complete(new Error('Загрузка EPG отменена'));};
  req=getRequest(raw,function(err,response) {
    if(completed)return;
    if(err){complete(err);return;}
    res=response;
    var status=res.statusCode||0;
    if(status>=300&&status<400&&res.headers.location) {
      var next=urlLib.resolve(raw,res.headers.location);
      if(!validUrl(next)){res.resume();complete(new Error('Недопустимый редирект EPG'));return;}
      res.resume();
      // The redirect does not download a body; use one actual XMLTV response.
      completed=true;
      fetchEpg(next,requested,redirects+1,job,done,conditional);
      return;
    }
    if(status===304){res.resume();complete(null,{notModified:true});return;}
    if(status<200||status>=300){res.resume();complete(new Error('EPG HTTP '+status));return;}
    job.state='streaming';job.updatedAt=Date.now();
    job.totalBytes=parseInt(res.headers['content-length'],10)||0;
    var declaredEncoding=String(res.headers['content-encoding']||'').toLowerCase();
    function buildDecoder(firstChunk){
      var gzip=declaredEncoding.indexOf('gzip')>=0 || (firstChunk.length>=2&&firstChunk[0]===31&&firstChunk[1]===139);
      var deflate=!gzip&&declaredEncoding.indexOf('deflate')>=0;
      unzip=gzip?zlib.createGunzip():deflate?zlib.createInflate():new stream.PassThrough();
      job.encoding=gzip?'gzip':deflate?'deflate':'xml';
      unzip.on('data',function(data){
        if(completed)return;
        job.bytes+=data.length;
        job.updatedAt=Date.now();
        if(job.bytes>MAX_EPG_UNCOMPRESSED){complete(new Error('Распакованный XMLTV больше 384 МиБ'));return;}
        try{parser.push(decoder.write(data));}catch(e){complete(e);}
      });
      unzip.on('error',function(e){complete(new Error('Ошибка GZIP/XMLTV: '+e.message));});
      unzip.on('end',function(){
        if(completed)return;
        job.state='finishing';
        try {
          parser.push(decoder.end());
          var result=parser.finish(requested);
          result.validators={etag:String(res.headers.etag||''),lastModified:String(res.headers['last-modified']||'')};
          complete(null,result);
        }catch(e){complete(e);}
      });
    }
    function pushInput(buf){
      if(completed)return;
      if(!unzip){
        // In practice TCP chunks are larger, but gzip magic may be split.
        firstData=firstData?Buffer.concat([firstData,buf]):buf;
        if(firstData.length<2&&declaredEncoding.indexOf('gzip')<0&&declaredEncoding.indexOf('deflate')<0)return;
        buf=firstData;firstData=null;
        buildDecoder(buf);
      }
      if(!unzip.write(buf)){
        res.pause();
        unzip.once('drain',function(){if(!completed)res.resume();});
      }
    }
    res.on('data',function(chunk){
      if(completed)return;
      job.wireBytes+=chunk.length;
      job.updatedAt=Date.now();
      if(job.wireBytes>MAX_EPG_WIRE){complete(new Error('EPG больше 384 МиБ по сети'));return;}
      pushInput(chunk);
    });
    res.on('end',function(){
      if(completed)return;
      sourceFinished=true;
      if(!unzip){complete(new Error('Пустой ответ EPG'));return;}
      job.state='finishing';unzip.end();
    });
    res.on('error',function(e){complete(e);});
    res.on('close',function(){
      if(!completed&&!sourceFinished)complete(new Error('EPG: сетевое соединение прервано'));
    });
  },conditional);
}

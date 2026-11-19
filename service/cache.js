/* Perfect TV Lite persistent cache, Node.js 0.12/ES5 compatible.
 * Never stores the source XMLTV. gzip NDJSON keeps per-channel EPG compact.
 * Files live outside the IPK and are atomically replaced after a successful write.
 */
'use strict';
var fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
var StringDecoder=require('string_decoder').StringDecoder;
var ROOT=process.env.PERFECT_TV_LITE_CACHE_DIR || '/media/internal/perfect-tv-lite-data';
var PLAYLIST=path.join(ROOT,'playlist.json.gz');
var EPG_DATA=path.join(ROOT,'epg.ndjson.gz');
var EPG_META=path.join(ROOT,'epg-meta.json');
var MAX_PLAYLIST_GZIP=2*1024*1024;
var MAX_EPG_GZIP=14*1024*1024;
var MAX_EPG_UNPACKED=90*1024*1024;
var MAX_CHANNEL_LINE=3*1024*1024;
var DAY=86400000;
var seq=0;
function keyOf(s){return crypto.createHash('sha1').update(String(s),'utf8').digest('hex').slice(0,24);}
function playlistPath(url){return path.join(ROOT,'playlist-'+keyOf(url)+'.json.gz');}
function epgPaths(url,signatureId){var key=keyOf(url+'\n'+signatureId);return {meta:path.join(ROOT,'epg-'+key+'-meta.json'),data:path.join(ROOT,'epg-'+key+'.ndjson.gz')};}
function signature(channels){return crypto.createHash('sha1').update(JSON.stringify(channels||[]),'utf8').digest('hex');}
function mkdir(callback){fs.mkdir(ROOT,448,function(e){callback(!e||e.code==='EEXIST'?null:e);});}
function failText(e){return String(e&&e.message||e||'Ошибка кэша');}
function tempName(name){return name+'.tmp-'+process.pid+'-'+(++seq);}
function writeAtomic(name,data,cb){
  mkdir(function(e){if(e)return cb(e);
    var tmp=tempName(name);
    fs.writeFile(tmp,data,{mode:384},function(err){if(err)return cb(err);
      fs.rename(tmp,name,function(err2){if(err2)fs.unlink(tmp,function(){});cb(err2||null);});
    });
  });
}
function readMetaFile(filename,cb){fs.readFile(filename,'utf8',function(err,body){
  if(err)return cb(null,null);
  try{var obj=JSON.parse(body);cb(null,obj&&obj.version===1?obj:null);}catch(e){cb(null,null);}
});}
// Optional source identifies the profile without changing the legacy cache.
function readMeta(cb,url,signatureId){
  if(!url||!signatureId){readMetaFile(EPG_META,cb);return;}
  var paths=epgPaths(url,signatureId);
  readMetaFile(paths.meta,function(e,meta){
    if(meta&&meta.url===url&&meta.signature===signatureId){meta._source='profile';cb(null,meta);return;}
    readMetaFile(EPG_META,function(legacyErr,legacy){
      if(legacy&&legacy.url===url&&legacy.signature===signatureId){legacy._source='legacy';cb(null,legacy);return;}
      cb(null,null);
    });
  });
}
function readPlaylistFile(filename,url,cb){
  fs.readFile(filename,function(err,bytes){
    if(err)return cb(null,null);
    if(bytes.length>MAX_PLAYLIST_GZIP)return cb(new Error('Кэш M3U превышает лимит'));
    zlib.gunzip(bytes,function(e,decoded){
      if(e)return cb(e);
      if(decoded.length>24*1024*1024)return cb(new Error('Кэш M3U слишком велик'));
      try{var v=JSON.parse(decoded.toString('utf8'));cb(null,v&&v.version===1&&v.url===url&&typeof v.text==='string'?v:null);}
      catch(e){cb(e);}
    });
  });
}
function readPlaylist(url,cb){
  readPlaylistFile(playlistPath(url),url,function(e,result){
    if(result){cb(null,result);return;}
    // An existing 0.2.7-0.2.9 playlist cache is still usable after upgrade.
    readPlaylistFile(PLAYLIST,url,cb);
  });
}
function writePlaylist(url,text,cb){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>24*1024*1024)return cb(new Error('Размер M3U не поддерживается'));
  var contents=JSON.stringify({version:1,url:url,text:text,updatedAt:Date.now()});
  zlib.gzip(new Buffer(contents,'utf8'),{level:5},function(err,bytes){
    if(err)return cb(err);
    if(bytes.length>MAX_PLAYLIST_GZIP)return cb(new Error('Кэш M3U после сжатия слишком большой'));
    writeAtomic(playlistPath(url),bytes,function(e){cb(e||null,{bytes:bytes.length});});
  });
}
function removePlaylist(url,cb){
  fs.unlink(playlistPath(url),function(err){
    if(cb)cb(err&&err.code!=='ENOENT'?err:null);
  });
}
function readEpg(url,signatureId,cb){
  readMeta(function(err,meta){
    if(err)return cb(err);
    if(!meta||meta.url!==url||meta.signature!==signatureId)return cb(null,null);
    var done=false,bytes=0,pending='',byIndex=Object.create(null),decoder=new StringDecoder('utf8');
    var source=fs.createReadStream(meta._source==='legacy'?EPG_DATA:epgPaths(url,signatureId).data);
    var gunzip=zlib.createGunzip();
    function finish(e,r){if(done)return;done=true;
      if(e){try{source.destroy();}catch(_){}try{gunzip.destroy();}catch(_){}}
      cb(e||null,r||null);
    }
    source.on('error',function(e){finish(e);});
    gunzip.on('error',function(e){finish(e);});
    gunzip.on('data',function(chunk){
      if(done)return;
      bytes+=chunk.length;
      if(bytes>MAX_EPG_UNPACKED)return finish(new Error('Размер кэша EPG превышен'));
      pending+=decoder.write(chunk);
      var nl;
      while((nl=pending.indexOf('\n'))>=0){
        var line=pending.slice(0,nl);pending=pending.slice(nl+1);
        if(!line)continue;
        try{
          var row=JSON.parse(line);
          if(!row||typeof row.i!=='number'||!Array.isArray(row.r)||row.r.length>500)throw new Error('Неверная запись кэша EPG');
          byIndex[row.i]=row.r;
        }catch(e){finish(e);return;}
      }
      if(pending.length>MAX_CHANNEL_LINE)return finish(new Error('Слишком длинная запись кэша'));
    });
    gunzip.on('end',function(){
      if(done)return;
      if(pending.trim())return finish(new Error('Повреждён кэш EPG: неполная строка'));
      finish(null,{meta:meta,guideCache:{byIndex:byIndex,requested:meta.requested||0,truncated:!!meta.guideTruncated,time:meta.fetchedAt},bytes:bytes});
    });
    source.pipe(gunzip);
  },url,signatureId);
}
function writeEpg(url,signatureId,result,validators,cb){
  var cache=result&&result.guideCache;
  if(!cache||!cache.byIndex)return cb(new Error('Нет расписания для кэширования'));
  var when=Date.now();
  var meta={version:1,url:url,signature:signatureId,fetchedAt:when,checkedAt:when,
    etag:validators&&validators.etag||'',lastModified:validators&&validators.lastModified||'',
    requested:cache.requested||0,guideTruncated:!!cache.truncated,stats:result.stats||{}};
  mkdir(function(e){
    if(e)return cb(e);
    var paths=epgPaths(url,signatureId),tmp=tempName(paths.data),output=fs.createWriteStream(tmp,{mode:384});
    var gzip=zlib.createGzip({level:4});
    var ended=false,size=0,keys=Object.keys(cache.byIndex),index=0;
    function fail(e){if(ended)return;ended=true;
      try{gzip.unpipe(output);gzip.destroy();output.destroy();}catch(_){}
      fs.unlink(tmp,function(){});cb(e||new Error('Сохранение EPG отменено'));
    }
    output.on('error',fail);gzip.on('error',fail);
    output.on('data',function(){});
    // compressed bytes should be bounded even when a source lists many shows
    gzip.on('data',function(chunk){size+=chunk.length;if(size>MAX_EPG_GZIP)fail(new Error('Сжатый кэш EPG больше 14 МиБ'));});
    output.on('finish',function(){
      if(ended)return;ended=true;
      fs.rename(tmp,paths.data,function(err){
        if(err){fs.unlink(tmp,function(){});return cb(err);}
        meta.compressedBytes=size;
        writeAtomic(paths.meta,JSON.stringify(meta),function(e){cb(e||null,meta);});
      });
    });
    gzip.pipe(output);
    function step(){
      if(ended)return;
      var count=0;
      while(index<keys.length && count++<12){
        var id=keys[index++];
        // One channel at a time: never stringify all 260000 entries at once.
        var line=JSON.stringify({i:Number(id),r:cache.byIndex[id]})+'\n';
        if(Buffer.byteLength(line,'utf8')>MAX_CHANNEL_LINE)return fail(new Error('Строка кэша EPG больше 3 МиБ'));
        if(!gzip.write(line,'utf8')){gzip.once('drain',step);return;}
      }
      if(index>=keys.length)gzip.end();else setImmediate(step);
    }
    step();
  });
}
function touchEpg(meta,cb){
  if(!meta||meta.version!==1)return cb(new Error('Нет метаданных EPG'));
  var filename=meta._source==='legacy'?EPG_META:epgPaths(meta.url,meta.signature).meta;
  meta.checkedAt=Date.now();
  var copy={};for(var k in meta)if(k!=='_source'&&Object.prototype.hasOwnProperty.call(meta,k))copy[k]=meta[k];
  writeAtomic(filename,JSON.stringify(copy),function(e){cb(e||null,meta);});
}
function readStatus(cb){readMeta(function(err,meta){cb(err,meta);});}
module.exports={ROOT:ROOT,DAY:DAY,signature:signature,readPlaylist:readPlaylist,writePlaylist:writePlaylist,removePlaylist:removePlaylist,
  readEpg:readEpg,writeEpg:writeEpg,readMeta:readMeta,touchEpg:touchEpg,readStatus:readStatus};

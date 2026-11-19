'use strict';
var assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');
var root=fs.mkdtempSync(path.join(os.tmpdir(),'ptl-legacy-test-'));
process.env.PERFECT_TV_LITE_CACHE_DIR=root;
var cache=require('../service/cache.js');
var playlist='http://example.test/old.m3u',epg='http://example.test/guide.xml';
var text='#EXTM3U\n#EXTINF:-1,Old Channel\nhttp://example.test/stream.m3u8\n';
var channels=[['test','Old Channel','Old Channel']],signature=cache.signature(channels);
var now=Date.now();
// Original release 0.2.7 file naming: verify the new build reads it unchanged.
fs.writeFileSync(path.join(root,'playlist.json.gz'),zlib.gzipSync(Buffer.from(JSON.stringify({version:1,url:playlist,text:text,updatedAt:now}))));
var legacyGuide={version:1,url:epg,signature:signature,fetchedAt:now,checkedAt:now,requested:1,guideTruncated:false,compressedBytes:90,stats:{}};
fs.writeFileSync(path.join(root,'epg-meta.json'),JSON.stringify(legacyGuide));
fs.writeFileSync(path.join(root,'epg.ndjson.gz'),zlib.gzipSync(Buffer.from(JSON.stringify({i:0,r:[['Сегодня',now-1000,now+3600000,'Описание']]})+'\n')));
cache.readPlaylist(playlist,function(err,result){
 assert(!err&&result&&result.text===text,'Legacy M3U should be restored from original file');
 cache.readEpg(epg,signature,function(err,saved){
  assert(!err&&saved&&saved.guideCache.byIndex[0][0][0]==='Сегодня','Legacy EPG should be restored intact');
  cache.touchEpg(saved.meta,function(err){
   assert(!err,'Legacy EPG 304 timestamp should be updated');
   assert(fs.existsSync(path.join(root,'epg.ndjson.gz')),'Original EPG file not to be removed');
   console.log('PASS: 0.2.7 legacy playlist + EPG cache restored without downloads, 304 touch supported');
  });
 });
});

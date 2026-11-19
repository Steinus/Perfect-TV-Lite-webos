'use strict';
var fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
var tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ptl-stress-'));
process.env.PERFECT_TV_LITE_CACHE_DIR=tmp;
var cache=require('../service/cache');
var result={guideCache:{byIndex:{},requested:1350,truncated:false},stats:{guideEntries:0,programmes:444176,providerChannels:2522}};
var start=Date.now()-86400000,channels=1350,rowsPer=160;
for(var i=0;i<channels;i++){
  var rows=[];
  for(var j=0;j<rowsPer;j++){
    var item=['Передача '+i+' '+j+' Художественный фильм и приключения',start+j*1800000,start+(j+1)*1800000];
    if(j%5===0)item.push('Описание передачи о приключениях и событиях с интересными фактами на телеканале '+i+'. Зрителей ждут увлекательные сюжеты и новости.');
    rows.push(item);
  }
  result.guideCache.byIndex[i]=rows;result.stats.guideEntries+=rows.length;
}
console.log('building',result.stats.guideEntries,'compact programme records');
var started=Date.now();
cache.writeEpg('http://epg.example/guide.xml','test-signature',result,{etag:'"test"'},function(err,meta){
  if(err)throw err;
  var took=Date.now()-started;
  assert(meta.compressedBytes>0&&meta.compressedBytes<=14*1024*1024);
  cache.readEpg('http://epg.example/guide.xml','test-signature',function(e,saved){
    if(e)throw e;
    assert(saved&&saved.guideCache&&saved.guideCache.byIndex[0].length===160);
    assert.equal(saved.guideCache.byIndex[1349][159][0],result.guideCache.byIndex[1349][159][0]);
    console.log('PASS: 216k records compressed',meta.compressedBytes,'bytes, stored ms',took,'total ms',Date.now()-started);
  });
});

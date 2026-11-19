#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, time
root=Path(__file__).resolve().parents[1]/'app'
now=int(time.time()*1000)
url='http://example.test/playlist.m3u'
eurl='http://example.test/epg.xml.gz'
media='http://example.test/stream.m3u8'
m3u='#EXTM3U\n#EXTINF:-1 tvg-id="tv1" group-title="Yosso",Yosso TV\n'+media+'\n'
initial={'perfecttv.webos.preview.v1':json.dumps({'playlist':{'url':url,'epg':eurl,'title':'Yosso'},'last':0,'lastKey':media,'lastUrl':url,'favorites':{}},ensure_ascii=False)}
mock='''
window.calls=[];
window.__FAKEM3U__=__M3U__;
window.__GUIDE_ROWS__=__ROWS__;
window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
 var method=uri.split('/').pop(),p=JSON.parse(payload||'{}');window.calls.push({method:method,payload:p});
 var result={returnValue:true};
 if(method==='getText')result={returnValue:true,text:window.__FAKEM3U__,cached:!p.force};
 if(method==='getCachedEpg')result={returnValue:true,found:true,fresh:true,checkedAt:Date.now(),items:[[0,window.__GUIDE_ROWS__[0][1],window.__GUIDE_ROWS__[0][2]]],stats:{matched:1,requested:1,transport:'кэш EPG',cacheBytes:120000,checkedAt:Date.now()}};
 if(method==='getEpg')result={returnValue:true,items:[[0,window.__GUIDE_ROWS__[0][1],window.__GUIDE_ROWS__[0][2]]],stats:{matched:1,requested:1,transport:'HTTP stream',cacheSaved:true,cacheBytes:120000,checkedAt:Date.now()}};
 if(method==='getGuide')result={returnValue:true,rows:window.__GUIDE_ROWS__[p.index]||[]};
 if(method==='ping')result={returnValue:true,serviceVersion:'0.2.7',epgStreaming:true};
 if(method==='getEpgProgress')result={returnValue:true,running:false};
 if(method==='getNetworkSpeed')result={returnValue:true,available:true,rxBytesPerSec:400000,txBytesPerSec:1000};
 if(method==='getHlsInfo')result={returnValue:true,bps:5000000,resolution:'1920×1080'};
 if(method==='startConfig')result={returnValue:true,url:'http://192.168.1.10:8098/?t=fake',pin:'123456',qrSvg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>',revision:0};
 if(method==='getConfigChanges')result={returnValue:true,revision:0,changed:false};
 var self=this;setTimeout(function(){self.onservicecallback(JSON.stringify(result));},8);
};};
HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
HTMLMediaElement.prototype.pause=function(){};
HTMLMediaElement.prototype.load=function(){};
'''.replace('__M3U__',json.dumps(m3u,ensure_ascii=False)).replace('__ROWS__',json.dumps({'0':[
['Вчера',now-86400000,now-82000000,'вчера'],['Сейчас в эфире',now-500000,now+900000,'Описание передачи'],['Далее',now+900000,now+4500000,'следующая']]},ensure_ascii=False))
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1920,'height':1080})
    errors=[]
    page.on('pageerror',lambda err:errors.append(str(err)))
    html=(root/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
    page.set_content(html)
    page.add_style_tag(content=(root/'styles.css').read_text())
    page.evaluate('Object.defineProperty(window,"localStorage",{value:{_map:'+json.dumps(initial,ensure_ascii=False)+',setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true});')
    page.evaluate(mock)
    page.add_script_tag(content=(root/'app.js').read_text())
    page.wait_for_timeout(450)
    assert page.locator('#playerName').inner_text().startswith('1.'),'last channel should resume'
    assert page.locator('#epgStatus').inner_text().find('кэш EPG')>=0,'should show cached guide'
    calls=page.evaluate('window.calls')
    assert any(x['method']=='getText' and x['payload'].get('playlist')==True and x['payload'].get('force')==False for x in calls),calls
    assert any(x['method']=='getCachedEpg' for x in calls),calls
    assert not any(x['method']=='getEpg' for x in calls),'fresh cache must not trigger network EPG'
    page.keyboard.press('ArrowDown')
    assert page.locator('#playerTimeline').is_visible(), 'online progress should remain available'
    assert 'Сейчас в эфире' in page.locator('#playerEpg').inner_text()
    page.keyboard.press('Escape')
    page.keyboard.press('ArrowLeft')
    page.keyboard.press('ArrowLeft')
    page.wait_for_timeout(120)
    page.locator('.quick-group-item.quick-group-settings').last.click()
    page.wait_for_timeout(320)
    assert any(x['method']=='getText' and x['payload'].get('force')==True for x in page.evaluate('window.calls')), 'manual M3U refresh must force network'
    page.locator('#settingsButton').click()
    page.wait_for_timeout(130)
    page.locator('#refreshEpg').click()
    page.wait_for_timeout(350)
    assert any(x['method']=='getEpg' and x['payload'].get('force')==True for x in page.evaluate('window.calls')), 'manual EPG refresh must force network'
    assert not errors,errors
    print('PASS: cache-first M3U on boot, cached EPG, last channel, manual forced M3U/EPG, online progress')
    browser.close()

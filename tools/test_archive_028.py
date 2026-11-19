#!/usr/bin/env python3
"""Archive seek, play/pause, EPG and web settings regression with the new 0.2.8 overlay controls."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import time,json
r=Path(__file__).resolve().parents[1]/'app'
now=int(time.time()*1000)
rows=[['Прошедшая передача',now-7200000,now-3600000,'Описание прошедшей передачи'],['Сейчас',now-600000,now+1800000,'Описание текущей передачи'],['Далее',now+1800000,now+5400000,'Описание следующей передачи']]
m3u='#EXTM3U\n#EXTINF:-1 tvg-id="arch" group-title="YOSSO TV" catchup="shift" catchup-days="3",Yosso TV\nhttp://127.0.0.1:65511/arch.m3u8\n'
mock='''
window.calls=[];window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
 var method=uri.split('/').pop(),p=JSON.parse(payload||'{}');window.calls.push({method:method,payload:p});var result={returnValue:true};
 if(method==='getText')result={returnValue:true,text:window.__M3U__};
 if(method==='getCachedEpg')result={returnValue:true,found:true,fresh:true,checkedAt:Date.now(),items:[[0,window.__ROWS__[1],window.__ROWS__[2]]],stats:{matched:1,requested:1,transport:'кэш EPG',cacheBytes:120000,checkedAt:Date.now()}};
 if(method==='getGuide')result={returnValue:true,rows:window.__ROWS__};
 if(method==='ping')result={returnValue:true,serviceVersion:'0.2.8',epgStreaming:true};
 if(method==='getNetworkSpeed')result={returnValue:true,available:true,rxBytesPerSec:200000,txBytesPerSec:3000};
 if(method==='getHlsInfo')result={returnValue:true,bps:3000000,resolution:'1920x1080'};
 if(method==='startConfig')result={returnValue:true,url:'http://192.168.1.10:8098/?t=fake',pin:'123456',qrSvg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>',revision:0};
 if(method==='getConfigChanges')result={returnValue:true,revision:0,changed:false};
 var self=this;setTimeout(function(){self.onservicecallback(JSON.stringify(result));},10);
};};
window.__mediaLoads=0;window.__seekAssignments=0;window.__paused=false;
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get:function(){return 0},set:function(x){window.__seekAssignments++;}});
Object.defineProperty(HTMLMediaElement.prototype,'paused',{configurable:true,get:function(){return window.__paused;}});
HTMLMediaElement.prototype.play=function(){window.__paused=false;return Promise.resolve();};
HTMLMediaElement.prototype.pause=function(){window.__paused=true;};
HTMLMediaElement.prototype.load=function(){window.__mediaLoads++;};
'''
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1920,'height':1080})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  html=(r/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
  page.set_content(html);page.add_style_tag(content=(r/'styles.css').read_text());
  saved={'perfecttv.webos.preview.v1':json.dumps({'playlist':{'url':'http://example/playlist.m3u','epg':'http://example/epg.gz','title':'Yosso'},'last':0,'lastKey':'http://127.0.0.1:65511/arch.m3u8','lastUrl':'http://example/playlist.m3u','favorites':{}},ensure_ascii=False)}
  page.evaluate('''data => Object.defineProperty(window,'localStorage',{value:{_map:data,setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true})''',saved)
  page.evaluate('window.__M3U__='+json.dumps(m3u,ensure_ascii=False)+';window.__ROWS__='+json.dumps(rows,ensure_ascii=False)+';'+mock)
  page.add_script_tag(content=(r/'app.js').read_text());page.wait_for_timeout(540)
  assert page.locator('#playerName').inner_text().startswith('1.')
  assert page.locator('#epgStatus').inner_text().find('кэш EPG')>=0
  page.keyboard.press('ArrowRight');page.wait_for_timeout(260)
  assert page.locator('#guidePanel').is_visible()
  page.locator('.guide-row').first.click();page.wait_for_timeout(180)
  assert page.locator('#playerMode').inner_text()=='АРХИВ'
  old_url=page.locator('#video source').get_attribute('src')
  assert 'utc=' in old_url
  page.keyboard.press('ArrowUp');assert page.locator('#archiveSeek').is_visible()
  page.keyboard.press('ArrowRight');page.keyboard.press('ArrowRight')
  assert page.locator('#video source').get_attribute('src')==old_url
  page.wait_for_timeout(1120)
  new_url=page.locator('#video source').get_attribute('src')
  assert new_url != old_url
  assert page.evaluate('window.__seekAssignments')==0
  page.keyboard.press('ArrowDown');page.keyboard.press('Enter')
  assert page.locator('#archivePlayLabel').inner_text()=='Воспроизвести'
  page.keyboard.press('Enter');assert page.locator('#archivePlayLabel').inner_text()=='Пауза'
  page.keyboard.press('ArrowRight');page.keyboard.press('Enter')
  assert page.locator('#playerMode').inner_text()=='ПРЯМОЙ ЭФИР'
  # settings accessible even when quick left channel list hides old settings buttons
  page.keyboard.press('ArrowLeft');page.keyboard.press('ArrowLeft')
  assert page.locator('.quick-group-settings').count()==2
  page.locator('.quick-group-settings').first.click();page.wait_for_timeout(120)
  assert page.locator('#settingsModal').is_visible()
  assert page.locator('#remoteAddress').inner_text().startswith('http://192.168.1.10:8098/')
  assert not errors,errors
  print('PASS: archive seek one URL after 1s, pause/play, return live, LAN editor reachable from group menu')
  browser.close()

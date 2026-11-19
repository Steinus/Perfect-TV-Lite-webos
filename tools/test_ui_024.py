#!/usr/bin/env python3
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread
from playwright.sync_api import sync_playwright
import json, time, re
root=Path(__file__).resolve().parents[1]/'app'
now=int(time.time()*1000)
rows=[['Вчера',now-7200000,now-4800000,'Прошлая программа'],['Сейчас в эфире',now-600000,now+800000,'Описание сейчас'],['Далее',now+800000,now+3400000,'Потом']]
channels=[('Yosso TV VHS','Yosso TV','shift'),('Yosso TV Kids','Yosso TV','append'),('Первый канал','Россия (RU)','shift'),('Yosso TV Grand','Yosso TV','shift'),('Россия 1','Россия (RU)','shift')]
channels+= [('Тест '+str(i),'Большая группа','shift') for i in range(150)]
m3u='#EXTM3U\n'
for i,(name,group,mode) in enumerate(channels):
    source=' catchup-source="?utc={utc}&duration={duration}"' if mode=='append' else ''
    m3u+=f'#EXTINF:-1 tvg-id="channel{i}" group-title="{group}" catchup="{mode}" catchup-days="3"{source},{name}\nhttp://127.0.0.1:65511/channel{i}.m3u8\n'
mock='''
window.__remoteRevision=0;window.__remoteConfig=null;
window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
var method=uri.split('/').pop(),obj=JSON.parse(payload||'{}'),result={returnValue:true};
if(method==='getText')result={returnValue:true,text:window.__FAKEM3U__};
if(method==='ping')result={returnValue:true,serviceVersion:'0.2.0',epgStreaming:true};
if(method==='getEpg'){
  var now=Date.now();result={returnValue:true,items:[[0,['Сейчас в эфире',now-600000,now+800000,'Описание сейчас'],['Далее',now+800000,now+3400000,'Потом']]],stats:{transport:'HTTP stream',providerChannels:155,programmes:500,guideEntries:150,byId:1,byName:0}};
}
if(method==='getGuide')result={returnValue:true,rows:window.__GUIDE_ROWS__[obj.index]||[]};
if(method==='getEpgProgress')result={returnValue:true,running:false};
if(method==='getHlsInfo')result={returnValue:true,bps:3200000,resolution:'1920×1080'};
if(method==='startConfig')result={returnValue:true,url:'http://192.168.1.105:8098/?t=testing',pin:'123456',qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="218" height="218"></svg>',revision:0};
if(method==='getConfigChanges')result={returnValue:true,revision:window.__remoteRevision,changed:!!window.__remoteConfig&&window.__remoteRevision>obj.since,config:window.__remoteConfig};
var self=this;setTimeout(function(){self.onservicecallback(JSON.stringify(result));},20);
};};
window.__seekAssignments=0;window.__fakePaused=false;window.__mediaLoads=0;
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get:function(){return 0},set:function(x){window.__seekAssignments++;}});
Object.defineProperty(HTMLMediaElement.prototype,'paused',{configurable:true,get:function(){return window.__fakePaused;}});
HTMLMediaElement.prototype.play=function(){window.__fakePaused=false;return Promise.resolve();};
HTMLMediaElement.prototype.pause=function(){window.__fakePaused=true;};
HTMLMediaElement.prototype.load=function(){window.__mediaLoads++;};
'''
script='window.__FAKEM3U__='+json.dumps(m3u,ensure_ascii=False)+';window.__GUIDE_ROWS__='+json.dumps({str(i):rows for i in range(len(channels))},ensure_ascii=False)+';'+mock

class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(root)))
Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1920,'height':1080})

  page=context.new_page()
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  html=(root/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
  def load_page(saved=None):
    page.set_content(html)
    page.add_style_tag(content=(root/'styles.css').read_text())
    page.evaluate('Object.defineProperty(window,"localStorage",{value:{_map:'+json.dumps(saved or {},ensure_ascii=False)+',setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true});')
    page.evaluate(script)
    page.add_script_tag(content=(root/'app.js').read_text())
  load_page()
  page.wait_for_timeout(320)
  assert page.locator('#settingsModal').is_visible()
  assert page.locator('#remoteAddress').inner_text()=='http://192.168.1.105:8098/'
  assert '123456' in page.locator('#remotePin').inner_text()
  page.locator('#playlistUrl').fill('https://provider.example/m3u')
  page.locator('#epgUrl').fill('http://epg.example/epg.xml.gz')
  page.locator('#playlistTitle').fill('Yosso')
  page.locator('#saveSettings').click()
  page.wait_for_timeout(680)
  assert page.locator('#channelCount').inner_text()==str(len(channels))
  page.locator('[data-channel="1"]').click()
  page.wait_for_timeout(110)
  assert page.locator('#playerName').inner_text().startswith('1.')
  # Play overlay; OK opens full sidebar with filter tabs, selected group, collapsed groups
  page.keyboard.press('Enter');page.wait_for_timeout(170)
  assert page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
  # Sidebar while playing must use the exact same translucent backdrop as the info overlay.
  glass=page.evaluate("() => ({info:getComputedStyle(document.getElementById('playerInfo')).backgroundImage,side:getComputedStyle(document.getElementById('sidebar')).backgroundImage,cls:document.getElementById('sidebar').className})")
  assert 'playing-overlay' in glass['cls'] and glass['side']==glass['info'],glass
  assert page.locator('#sidebarHeadingText').inner_text()=='Телеканалы'
  assert page.locator('#modeGroups').is_visible()
  assert not page.locator('#groups').is_visible()
  assert page.locator('.channel-item').count()==3
  page.locator('#modeGroups').click();page.wait_for_timeout(80)
  assert page.locator('#groups').is_visible(), 'groups must open at first click'
  page.locator('#modeGroups').click();page.wait_for_timeout(80)
  assert not page.locator('#groups').is_visible(), 'groups must collapse at second click'
  page.screenshot(path='/mnt/data/perfect-tv-lite-024/test-sidebar.png')
  page.keyboard.press('Escape')
  assert not page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
  # Wide OSD with archive info
  page.keyboard.press('ArrowDown');assert page.locator('#playerInfo').is_visible()
  page.screenshot(path='/mnt/data/perfect-tv-lite-024/test-player.png')
  page.keyboard.press('Escape');assert not page.locator('#playerInfo').is_visible()
  # Guide allows archive on past show
  page.keyboard.press('ArrowRight');page.wait_for_timeout(430)
  assert page.locator('#guidePanel').is_visible()
  # Both full-screen and side-by-side guides use the OSD glass style. Selected
  # programme band must not be an opaque block over the moving picture.
  glass=page.evaluate("() => ({info:getComputedStyle(document.getElementById('playerInfo')).backgroundImage,guide:getComputedStyle(document.getElementById('guidePanel')).backgroundImage,selected:getComputedStyle(document.querySelector('.guide-selected')).backgroundColor})")
  assert glass['guide']==glass['info'],glass
  assert glass['selected'].startswith('rgba(') and '0.55' in glass['selected'],glass
  assert page.locator('.guide-row').count()==3
  assert page.locator('.archive-available').count()>=1
  # The detail panel follows D-pad focus up and down; past descriptions matter.
  page.keyboard.press('ArrowUp')
  assert page.evaluate("document.activeElement.getAttribute('data-guide-index')")=='0'
  assert page.evaluate("document.getElementById('guideSelectedDesc').textContent===window.__GUIDE_ROWS__['0'][0][3]")
  page.keyboard.press('ArrowDown')
  assert page.evaluate("document.getElementById('guideSelectedDesc').textContent===window.__GUIDE_ROWS__['0'][1][3]")
  page.locator('.guide-row').first.click();page.wait_for_timeout(160)
  assert page.locator('#playerMode').inner_text()=='АРХИВ'
  src=page.locator('#video source').first.get_attribute('src')
  assert 'utc=' in src and 'lutc=' in src,src
  assert not page.locator('#guidePanel').is_visible()
  page.keyboard.press('ArrowUp');assert page.locator('#archiveSeek').is_visible()
  assert page.locator('#archiveSeekTitle').inner_text()=='Вчера'
  assert page.locator('#archiveSeekDescription').inner_text()=='Прошлая программа'
  assert page.locator('#archiveSeekTrack').evaluate('(e)=>e===document.activeElement')
  assert page.locator('#archiveSeekTotal').inner_text()!='—','archive duration must be visible'
  assert page.locator('#archiveSeekProgrammeTime').inner_text().find('–')>=0
  initial_url=page.locator('#video source').get_attribute('src')
  initial_loads=page.evaluate('window.__mediaLoads')
  page.keyboard.press('ArrowRight');page.keyboard.press('ArrowRight');page.keyboard.press('ArrowRight')
  assert page.locator('#video source').get_attribute('src')==initial_url,'preview must not seek immediately'
  assert page.locator('#archiveSeekStatus').inner_text().find('1 секунду')>=0
  assert page.locator('#archiveSeekTrack').get_attribute('aria-valuenow')!='0' 
  page.wait_for_timeout(400)
  assert page.locator('#video source').get_attribute('src')==initial_url,'must wait until 1s idle'
  page.wait_for_timeout(780)
  new_url=page.locator('#video source').get_attribute('src')
  assert new_url!=initial_url,'seek should request a new archive timestamp'
  assert 'utc=' in new_url
  assert page.evaluate('window.__seekAssignments')==0,'native currentTime assignment must not be used'
  assert page.evaluate('window.__mediaLoads')==initial_loads+2,'one source reinitialization'
  page.screenshot(path='/mnt/data/perfect-tv-lite-024/test-archive-controls.png')
  # Play/Pause: D-pad down selects action, Enter pauses, then resumes.
  page.keyboard.press('ArrowDown')
  assert page.locator('#archivePlayPause').evaluate('(e)=>e===document.activeElement')
  page.keyboard.press('Enter')
  assert page.locator('#archivePlayLabel').inner_text()=='Воспроизвести'
  page.keyboard.press('Enter')
  assert page.locator('#archivePlayLabel').inner_text()=='Пауза'
  # Cancel pending timeline preview with BACK; source should not be changed.
  page.keyboard.press('ArrowUp');page.keyboard.press('ArrowLeft')
  url_before_back=page.locator('#video source').get_attribute('src')
  page.keyboard.press('Escape')
  assert not page.locator('#archiveSeek').is_visible()
  page.wait_for_timeout(1200)
  assert page.locator('#video source').get_attribute('src')==url_before_back
  # Re-open, choose live button, and return without stopping the app.
  page.keyboard.press('ArrowUp')
  page.keyboard.press('ArrowDown')
  page.keyboard.press('ArrowRight')
  assert page.locator('#archiveLiveButton').evaluate('(e)=>e===document.activeElement')
  page.keyboard.press('Enter')
  assert page.locator('#playerMode').inner_text()=='ПРЯМОЙ ЭФИР'
  assert not page.locator('#archiveSeek').is_visible()
  # Open archive again for existing Back and OSD regression checks.
  page.keyboard.press('ArrowRight');page.wait_for_timeout(320)
  page.locator('.guide-row').first.click();page.wait_for_timeout(160)
  page.keyboard.press('ArrowUp');assert page.locator('#archiveSeek').is_visible()
  page.keyboard.press('Escape');assert not page.locator('#archiveSeek').is_visible()
  page.keyboard.press('ArrowDown');assert page.locator('#playerInfo').is_visible()
  page.keyboard.press('Escape')
  page.screenshot(path='/mnt/data/perfect-tv-lite-024/test-archive.png')
  # Channel auto-resume on reboot
  stored=page.evaluate('localStorage._map')
  load_page(stored);page.wait_for_timeout(700)
  assert page.locator('#playerName').inner_text().startswith('1.'), 'last channel did not resume'
  assert not page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
  # List virtualization + anchored focus
  page.keyboard.press('Enter');page.wait_for_timeout(180)
  page.locator('#modeAll').click();page.wait_for_timeout(60)
  # Full remote-only favorite flow: right to star, OK toggles, left back.
  page.locator('[data-channel="1"]').focus()
  page.keyboard.press('ArrowRight')
  assert page.evaluate("document.activeElement.classList.contains('favorite-toggle')"), 'star unreachable by remote'
  assert page.locator('.favorite-toggle[data-favorite-channel="1"]').get_attribute('aria-pressed')=='false'
  page.keyboard.press('Enter')
  assert page.locator('.favorite-toggle[data-favorite-channel="1"]').get_attribute('aria-pressed')=='true'
  assert page.evaluate("JSON.parse(localStorage.getItem('perfecttv.webos.preview.v1')).favorites['http://127.0.0.1:65511/channel0.m3u8']") is True
  page.screenshot(path='/mnt/data/perfect-tv-lite-024/test-favorites.png')
  page.keyboard.press('ArrowLeft')
  assert page.evaluate("document.activeElement.getAttribute('data-channel')")=='1'
  page.keyboard.press('ArrowRight')
  page.keyboard.press('Enter')
  assert page.locator('.favorite-toggle[data-favorite-channel="1"]').get_attribute('aria-pressed')=='false'
  # Red key is still supported as an optional shortcut.
  page.keyboard.press('ArrowLeft')
  page.keyboard.press('r')
  assert page.locator('.favorite-toggle[data-favorite-channel="1"]').get_attribute('aria-pressed')=='true'
  # Favorite view allows removing an item by remote and recovers focus.
  page.locator('#modeFav').focus();page.keyboard.press('Enter')
  assert page.locator('.channel-item').count()==1
  page.locator('[data-channel="1"]').focus();page.keyboard.press('ArrowRight')
  page.keyboard.press('Enter')
  assert page.locator('.channel-item').count()==0
  assert page.evaluate("document.activeElement.id")=='modeFav'
  page.locator('#modeAll').focus();page.keyboard.press('Enter')
  assert page.locator('.channel-item').count()>1
  page.locator('[data-channel="1"]').focus()
  for _ in range(19):page.keyboard.press('ArrowDown')
  page.wait_for_timeout(120)
  index=page.evaluate("document.activeElement.getAttribute('data-visible-index')")
  assert index=='19', f'focus skip when scrolling: {index}'
  st=page.locator('#channels').evaluate('(x)=>x.scrollTop')
  assert st>0, 'scroll should track focus'
  item=page.locator('[data-visible-index="19"]').bounding_box()
  box=page.locator('#channels').bounding_box()
  assert item['y']+item['height'] <= box['y']+box['height']+12, (item,box)
  assert not errors,'JS errors: '+str(errors)
  print('PASS 0.2.3: debounce URL seek, no native seeks, play/pause, live button, Back cancel, UI regression')
  browser.close()
server.shutdown()

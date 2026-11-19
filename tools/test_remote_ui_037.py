#!/usr/bin/env python3
"""Regression: multiple profiles from web editor, imported file boot/cache, TV UI."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]/'app'
m3u='#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="Импорт",Канал из файла\nhttps://stream.example/live/one.m3u8\n'
fileurl='ptv-file://'+'a'*24
remote={'playlists':[{'id':'profile-old','url':'https://example.org/old.m3u','title':'Обычный URL','epg':'','source':'url','lastKey':''}, {'id':'profile-import','url':fileurl,'title':'Мой импорт','epg':'','source':'file','lastKey':''}],'activePlaylistId':'profile-import'}
script='''
window.__fileText=FILETEXT;
window.__remoteConfig=REMOTECONFIG;
window.__remoteRevision=1;
window.__getTextUrls=[];
window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
 var method=uri.split('/').pop(),obj=JSON.parse(payload||'{}'),answer={returnValue:true};
 if(method==='getText'){window.__getTextUrls.push(obj.url);answer={returnValue:true,text:window.__fileText,cached:true,imported:true};}
 if(method==='ping')answer={returnValue:true,serviceVersion:'0.3.7',epgStreaming:true};
 if(method==='startConfig')answer={returnValue:true,url:'http://192.168.1.105:8098/?t=xx',pin:'123456',qrSvg:'<svg></svg>',revision:0};
 if(method==='getConfigChanges')answer={returnValue:true,revision:1,changed:obj.since<1,config:window.__remoteConfig};
 if(method==='getCachedEpg')answer={returnValue:true,found:false};
 if(method==='getEpgProgress')answer={returnValue:true,running:false};
 var self=this;setTimeout(function(){self.onservicecallback(JSON.stringify(answer));},10);
 };};
 HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
 HTMLMediaElement.prototype.pause=function(){};
 HTMLMediaElement.prototype.load=function(){};
'''.replace('FILETEXT',json.dumps(m3u,ensure_ascii=False)).replace('REMOTECONFIG',json.dumps(remote,ensure_ascii=False))
html=(root/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1920,'height':1080})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def load(storage=None):
  page.set_content(html);page.add_style_tag(content=(root/'styles.css').read_text())
  page.evaluate('''(data)=>{Object.defineProperty(window,'localStorage',{value:{_map:data||{},setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true});}''',storage or {})
  page.evaluate(script);page.add_script_tag(content=(root/'app.js').read_text())
 load()
 assert page.locator('#settingsModal').is_visible()
 assert page.locator('#playlistFileInfo').is_visible()
 page.wait_for_timeout(2800)
 assert page.locator('#channelCount').inner_text()=='1',page.locator('#channelCount').inner_text()
 assert 'Мой импорт' in page.locator('#playlistProfiles').inner_text()
 assert 'Обычный URL' in page.locator('#playlistProfiles').inner_text()
 assert page.locator('#playlistUrl').input_value()==''
 assert 'из файла' in page.locator('#playlistFileNote').inner_text()
 assert page.locator('#settingsModal').is_visible(), 'Web import should not close TV settings'
 stored=page.evaluate('localStorage._map')
 state=json.loads(stored['perfecttv.webos.preview.v1'])
 assert len(state['playlists'])==2,state['playlists']
 assert state['activePlaylistId']=='profile-import'
 assert state['playlists'][1]['source']=='file'
 assert page.evaluate('window.__getTextUrls')==[fileurl]
 page.locator('#playlistTitle').fill('Мой импорт исправлен')
 page.locator('#saveSettings').click()
 page.wait_for_timeout(200)
 assert 'Мой импорт исправлен' in page.locator('#playlistProfiles').inner_text()
 stored=page.evaluate('localStorage._map')
 load(stored);page.wait_for_timeout(300)
 assert page.locator('#channelCount').inner_text()=='1'
 assert page.evaluate('window.__getTextUrls')==[fileurl]
 assert not errors,errors
 page.screenshot(path='/mnt/data/PerfectTVLite037-TV-playlists.png')
 browser.close()
 print('PASS 0.3.7: web profiles -> TV, file source restore, no HTTP, cache on reboot, metadata edit, settings stay open')

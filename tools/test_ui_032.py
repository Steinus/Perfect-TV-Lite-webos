#!/usr/bin/env python3
"""Focused controller/EPG regression for Perfect TV Lite 0.3.2."""
from pathlib import Path
import json,time
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]/'app'
now=int(time.time()*1000)
channels=[('Yosso TV Grand','YOSSO TV'),('Yosso TV VHS','YOSSO TV'),('Yosso TV Kids','YOSSO TV'),('Yosso TV NEW Кино','YOSSO TV'),('Yosso TV Мелодрама','YOSSO TV'),('Россия 1','Россия (RU)'),('Первый канал','Россия (RU)')]
m3u='#EXTM3U\n'
for i,(name,group) in enumerate(channels):
    m3u+=f'#EXTINF:-1 tvg-id="ch{i}" group-title="{group}" catchup="shift" catchup-days="3",{name}\nhttp://127.0.0.1:65511/chan{i}.m3u8\n'
rows=[]
for i in range(len(channels)):
    # 6 days, every four hours, so the date selector is populated
    allrows=[]
    for j in range(-18,24):
        st=now+j*3600000
        allrows.append([('Моана (2026)' if i==3 and j==0 else 'Передача '+str(i+1)+' / '+str(j)), st, st+3600000,'Краткое описание '+str(j)])
    if i==2:
        for r in allrows:r[3]='Длинное описание для проверки фиксированного окна. '+('Космический корабль терпит бедствие на неизвестной планете. ' * 17)+'КОНЕЦ ОПИСАНИЯ'
    rows.append(allrows)
mock='''
window.__remoteRevision=0;window.__remoteConfig=null;
window.__requests={getText:0,getCachedEpg:0,getEpg:0,getGuide:0};
window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
var method=uri.split('/').pop(),obj=JSON.parse(payload||'{}'),result={returnValue:true};
if(window.__requests[method]!==undefined)window.__requests[method]++;
if(method==='getText')result={returnValue:true,text:obj.url.indexOf('second')>=0?window.__FAKEM3U2__:window.__FAKEM3U__,cached:obj.url.indexOf('second')<0};
if(method==='getCachedEpg')result={returnValue:true,found:false};
if(method==='ping')result={returnValue:true,serviceVersion:'0.3.2',epgStreaming:true};
if(method==='getEpg'){
  var rows=window.__GUIDE_ROWS__;result={returnValue:true,items:rows.map(function(x,i){var now=Date.now(),c=x.find(function(r){return r[1]<=now&&r[2]>now})||x[0],n=x.find(function(r){return r[1]>now})||x[0];return [i,c,n]}),stats:{transport:'HTTP stream',providerChannels:7,programmes:294,guideEntries:294,byId:7,byName:0}};
}
if(method==='getGuide')result={returnValue:true,rows:window.__GUIDE_ROWS__[obj.index]||[]};
if(method==='getEpgProgress')result={returnValue:true,running:false};
if(method==='getNetworkSpeed')result={returnValue:true,available:true,scope:'whole-tv',rxBytesPerSec:287500,txBytesPerSec:46250};
if(method==='getHlsInfo')result={returnValue:true,bps:3200000,resolution:'1920×1080'};
if(method==='startConfig')result={returnValue:true,url:'http://192.168.1.105:8098/?t=testing',pin:'123456',qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="218" height="218"></svg>',revision:0};
if(method==='getConfigChanges')result={returnValue:true,revision:window.__remoteRevision,changed:false};
var self=this;setTimeout(function(){self.onservicecallback(JSON.stringify(result));},15);
};};
window.__seekAssignments=0;window.__fakePaused=false;window.__mediaLoads=0;
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get:function(){return 0},set:function(x){window.__seekAssignments++;}});
Object.defineProperty(HTMLMediaElement.prototype,'paused',{configurable:true,get:function(){return window.__fakePaused;}});
HTMLMediaElement.prototype.play=function(){window.__fakePaused=false;return Promise.resolve();};
HTMLMediaElement.prototype.pause=function(){window.__fakePaused=true;};
HTMLMediaElement.prototype.load=function(){window.__mediaLoads++;};
'''
preload='window.__FAKEM3U__='+json.dumps(m3u,ensure_ascii=False)+';window.__FAKEM3U2__='+json.dumps('#EXTM3U\n#EXTINF:-1 tvg-id="second" group-title="Другие",Канал Второго Плейлиста\nhttp://127.0.0.1:65511/other.m3u8\n',ensure_ascii=False)+';window.__GUIDE_ROWS__='+json.dumps(rows,ensure_ascii=False)+';'+mock
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1920,'height':1080})
    page.set_default_timeout(4000)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    html=(root/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
    def load_page(storage=None):
        page.set_content(html)
        page.add_style_tag(content=(root/'styles.css').read_text())
        page.evaluate('''(data)=>{Object.defineProperty(window,"localStorage",{value:{_map:data||{},setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true});}''',storage or {})
        page.evaluate(preload)
        page.add_script_tag(content=(root/'app.js').read_text())
    def key(k):page.keyboard.press(k);page.wait_for_timeout(55)
    load_page();page.wait_for_timeout(240)
    assert page.locator('#settingsModal').is_visible()
    assert page.locator('#settingsTabPlaylists').is_visible()
    page.locator('#playlistUrl').fill('https://provider.example/playlist.m3u')
    page.locator('#epgUrl').fill('https://epg.example/guide.xml.gz')
    page.locator('#playlistTitle').fill('Yosso')
    page.locator('#saveSettings').click();page.wait_for_timeout(650)
    assert page.locator('#channelCount').inner_text()=='7'
    page.locator('[data-channel="1"]').click();page.wait_for_timeout(120)
    assert not page.locator('#sidebar').evaluate("e=>e.classList.contains('open')")
    # New video hotkeys: left previous, right next, P+ and P- unchanged.
    key('ArrowRight')
    assert page.locator('#playerName').inner_text().startswith('2.')
    assert page.locator('#playerInfo').is_visible(), 'Zap must open channel information without Down'
    assert page.locator('#zapCarousel').is_visible(), 'Zap must open the horizontal carousel'
    assert page.locator('.zap-channel-card').count()==5
    assert page.locator('.zap-channel-card.is-current').count()==1
    assert 'Yosso TV VHS' in page.locator('.zap-channel-card.is-current').inner_text()
    assert page.locator('.zap-channel-card').nth(1).get_attribute('class').find('is-current')<0
    assert 'Yosso TV VHS' in page.locator('#playerName').inner_text()
    assert page.locator('#topline').is_visible(), 'Clock must be visible during zap'
    page.wait_for_timeout(50)
    page.evaluate('''() => {document.getElementById('toast').classList.add('hidden');document.getElementById('video').style.background='radial-gradient(ellipse at 72% 30%,#24435c 0%,#14243d 47%,#050d16 95%)';}''')
    page.screenshot(path='/mnt/data/PerfectTVLite032-zapping.png')
    # Regression: different EPG description lengths never move the carousel.
    def panel_geometry():
        return page.evaluate('''() => {
          var p=document.getElementById('playerInfo').getBoundingClientRect();
          var c=document.getElementById('zapCarousel').getBoundingClientRect();
          var cards=document.querySelector('.zap-channel-card').getBoundingClientRect();
          return {top:p.top,height:p.height,carouselTop:c.top,cardHeight:cards.height};
        }''')
    short=panel_geometry()
    key('ArrowRight')  # 3 = deliberately long EPG description
    long=panel_geometry()
    for k in short:
        assert abs(short[k]-long[k])<1,(k,short,long)
    limits=page.evaluate('''() => {
        var d=document.getElementById('playerDescription').getBoundingClientRect();
        var t=document.getElementById('playerTimeline').getBoundingClientRect();
        return {descBottom:d.bottom, timelineTop:t.top};
    }''')
    assert limits['descBottom'] < limits['timelineTop']-2, limits
    assert '…' in page.locator('#playerDescription').inner_text()
    assert len(page.locator('#playerDescription').inner_text())<=177
    page.screenshot(path='/mnt/data/PerfectTVLite032-zapping-long.png')
    key('ArrowDown')
    assert not page.locator('#zapCarousel').is_visible()
    assert page.locator('#playerDescription').inner_text().endswith('КОНЕЦ ОПИСАНИЯ')
    key('ArrowLeft')  # channel 2 and zap mode again
    key('ArrowLeft')
    assert page.locator('#playerName').inner_text().startswith('1.')
    assert 'Yosso TV Grand' in page.locator('.zap-channel-card.is-current').inner_text()
    key('PageUp')
    assert page.locator('#playerName').inner_text().startswith('2.')
    assert 'Yosso TV VHS' in page.locator('.zap-channel-card.is-current').inner_text()
    # The first DOWN after a zap switches to the usual info without carousel;
    # the next DOWN opens favorites, TV grid and history.
    key('ArrowDown');assert page.locator('#playerInfo').is_visible();assert not page.locator('#zapCarousel').is_visible()
    key('ArrowDown');assert page.locator('#recentPanel').is_visible()
    assert page.locator('#recentFavorite').is_visible() and page.locator('#recentGuide').is_visible()
    page.screenshot(path='/mnt/data/PerfectTVLite032-down-history.png')
    key('Escape');assert not page.locator('#recentPanel').is_visible()
    key('ArrowUp');page.wait_for_timeout(250)
    assert page.locator('#guidePanel').is_visible(), 'Up opens current channel programme'
    key('Escape');assert not page.locator('#guidePanel').is_visible()
    # OK now opens the quick channel list and accepts nested left navigation.
    key('Enter');assert page.locator('#sidebar').evaluate("e=>e.classList.contains('quick-mode')")
    key('ArrowLeft');assert page.locator('#quickGroupPanel').is_visible()
    key('ArrowLeft');assert page.locator('#quickActionsPanel').is_visible()
    page.locator('#quickActionSettings').focus();key('Enter')
    assert page.locator('#settingsModal').is_visible()
    assert page.locator('#settingsTabFonts').is_visible()
    # Change one exact font category via the remote.
    page.locator('#settingsTabFonts').click()
    assert page.locator('#settingsFontSection').is_visible()
    fontRow=page.locator('.font-control-row').nth(3)
    fontRow.locator('button').last.focus()
    assert fontRow.locator('.font-row-preview').is_visible()
    assert 'Описания' in fontRow.locator('.font-row-preview-caption').inner_text()
    assert fontRow.locator('.font-row-sample').evaluate('e=>getComputedStyle(e).fontSize')=='21px'
    before=page.evaluate("getComputedStyle(document.querySelector('.player-description')).fontSize")
    page.locator('.font-control-row').nth(3).locator('button').last.focus()
    key('Enter');key('Enter')
    after=page.evaluate("getComputedStyle(document.querySelector('.player-description')).fontSize")
    assert after!=before,(before,after)
    assert page.locator('.font-control-row').nth(3).locator('.font-control-value').inner_text()=='23 px'
    assert fontRow.locator('.font-row-sample').evaluate('e=>getComputedStyle(e).fontSize')=='23px'
    page.screenshot(path='/mnt/data/PerfectTVLite032-font-preview.png')
    # Each target gets a different preview, including the channel title sample.
    firstRow=page.locator('.font-control-row').first
    firstRow.locator('button').first.focus()
    assert firstRow.locator('.font-row-preview').is_visible()
    assert not fontRow.locator('.font-row-preview').is_visible()
    assert '316. Yosso TV BEST' in firstRow.locator('.font-row-sample').inner_text()
    # Second playlist is added without removing the first.
    print('step: back playlist section',flush=True);page.locator('#settingsTabPlaylists').click()
    assert page.locator('.profile-item').count()==1
    print('step: add new profile',flush=True);page.locator('#playlistAdd').click()
    assert page.locator('#playlistUrl').input_value()==''
    page.locator('#playlistUrl').fill('https://provider.example/second.m3u')
    page.locator('#epgUrl').fill('')
    page.locator('#playlistTitle').fill('Второй плейлист')
    print('step: saving second profile',flush=True);page.locator('#saveSettings').click();page.wait_for_timeout(520)
    assert page.locator('#channelCount').inner_text()=='1'
    assert page.locator('#sidebar').evaluate("e=>e.classList.contains('open')")
    # Profiles can be switched from their rows after reopening settings.
    print('step: opening settings second',flush=True);page.locator('#settingsButton').click();page.wait_for_timeout(130)
    assert page.locator('.profile-item').count()==2
    assert 'Второй плейлист' in page.locator('.profile-item.current').inner_text()
    page.screenshot(path='/mnt/data/PerfectTVLite032-playlist-settings.png')
    print('step: switching to first',flush=True);page.locator('.profile-item').first.click();page.wait_for_timeout(540)
    assert page.locator('#channelCount').inner_text()=='7'
    assert 'Yosso' in page.locator('#playlistName').inner_text()
    # Font and playlist profile survive restart.
    stored=page.evaluate('localStorage._map')
    payload=json.loads(stored['perfecttv.webos.preview.v1'])
    assert len(payload['playlists'])==2,payload['playlists']
    assert payload['fontSizes']['description']==23,payload['fontSizes']
    print('step: loading saved',flush=True);load_page(stored);page.wait_for_timeout(670)
    assert page.locator('#channelCount').inner_text()=='7'
    assert page.evaluate("getComputedStyle(document.querySelector('.player-description')).fontSize")=='23px'
    # Archived video: Down opens timeline and detailed programme, then can open LIVE info.
    print('step: open archive test',flush=True)
    if page.locator('#sidebar').evaluate("e=>e.classList.contains('open')"):
        page.locator('[data-channel="1"]').click();page.wait_for_timeout(115)
    key('ArrowUp');page.wait_for_timeout(230)
    page.locator('.guide-row.guide-past').first.click();page.wait_for_timeout(120)
    assert page.locator('#playerMode').inner_text()=='АРХИВ'
    key('ArrowDown');assert page.locator('#archiveSeek').is_visible()
    assert page.locator('#archiveSeekDescription').inner_text()!=''
    page.locator('#archiveLiveDetails').focus();key('Enter')
    assert page.locator('#archiveLivePanel').is_visible()
    key('Escape');assert not page.locator('#archiveLivePanel').is_visible()
    key('Enter');assert page.locator('#sidebar').evaluate("e=>e.classList.contains('quick-mode')")
    # No pending seek, playback should be intact.
    assert page.locator('#playerMode').inner_text()=='АРХИВ'
    assert not errors,errors
    print('PASS 0.3.2: live zap carousel, double Down, archive, OK group, multi-playlists, font settings, persistence')
    browser.close()

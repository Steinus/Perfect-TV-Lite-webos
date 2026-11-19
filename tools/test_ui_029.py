#!/usr/bin/env python3
"""Focused controller/EPG regression for Perfect TV Lite 0.2.9."""
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
    rows.append(allrows)
mock='''
window.__remoteRevision=0;window.__remoteConfig=null;
window.__requests={getText:0,getCachedEpg:0,getEpg:0,getGuide:0};
window.PalmServiceBridge=function(){this.onservicecallback=function(){};this.call=function(uri,payload){
var method=uri.split('/').pop(),obj=JSON.parse(payload||'{}'),result={returnValue:true};
if(window.__requests[method]!==undefined)window.__requests[method]++;
if(method==='getText')result={returnValue:true,text:window.__FAKEM3U__};
if(method==='getCachedEpg')result={returnValue:true,found:false};
if(method==='ping')result={returnValue:true,serviceVersion:'0.2.9',epgStreaming:true};
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
preload='window.__FAKEM3U__='+json.dumps(m3u,ensure_ascii=False)+';window.__GUIDE_ROWS__='+json.dumps(rows,ensure_ascii=False)+';'+mock
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1920,'height':1080})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    html=(root/'index.html').read_text().replace('<link rel="stylesheet" href="styles.css" />','').replace('<script src="app.js"></script>','')
    def load_page(storage=None):
        page.set_content(html)
        page.add_style_tag(content=(root/'styles.css').read_text())
        page.evaluate('''(data)=>{Object.defineProperty(window,"localStorage",{value:{_map:data||{},setItem:function(k,v){this._map[k]=v},getItem:function(k){return this._map[k]||null}},configurable:true});}''',storage or {})
        page.evaluate(preload)
        page.add_script_tag(content=(root/'app.js').read_text())
    def key(k):page.keyboard.press(k);page.wait_for_timeout(45)
    load_page();page.wait_for_timeout(300)
    assert page.locator('#settingsModal').is_visible()
    page.locator('#playlistUrl').fill('https://provider.example/playlist.m3u')
    page.locator('#epgUrl').fill('https://epg.example/guide.xml.gz')
    page.locator('#playlistTitle').fill('Yosso')
    page.locator('#saveSettings').click();page.wait_for_timeout(750)
    assert page.locator('#channelCount').inner_text()=='7'
    page.locator('[data-channel="1"]').click();page.wait_for_timeout(120)
    assert not page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
    # Change to channel 4 then channel 2 so history starts with 4.
    key('PageUp');key('PageUp');key('PageUp');key('PageDown');key('PageDown')
    # At live channel LEFT opens compact channel list; guide shown alongside.
    key('ArrowLeft')
    assert page.locator('#sidebar').evaluate('(e)=>e.classList.contains("quick-mode")')
    assert page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
    assert page.locator('.quick-mode .favorite-toggle').first.is_hidden()
    assert page.locator('.channel-meter').count()>0
    assert page.locator('.channel-playing-icon').count()>=1
    assert page.locator('.channel-archive-icon').count()>0
    page.wait_for_timeout(300)
    assert page.locator('#guidePanel').is_visible()
    page.screenshot(path='/mnt/data/PerfectTVLite028-channels.png')
    # LEFT while focused on compact channel opens GROUPS column.
    key('ArrowLeft')
    assert page.locator('#quickGroupPanel').is_visible()
    assert page.locator('.quick-group-item').count()>=3
    page.screenshot(path='/mnt/data/PerfectTVLite028-groups.png')
    # Third LEFT from groups opens the actions menu, without closing channels.
    key('ArrowLeft')
    assert page.locator('#quickActionsPanel').is_visible()
    assert not page.locator('#quickGroupPanel').is_visible()
    page.screenshot(path='/mnt/data/PerfectTVLite029-actions.png')
    assert [t.strip() for t in page.locator('#quickActionsList button').all_inner_texts()]==[
        'Настройки','Обновить M3U','Все каналы','Избранное','Поиск']
    # BACK from actions returns to groups; the first RIGHT returns to channels.
    key('Escape')
    assert not page.locator('#quickActionsPanel').is_visible()
    assert page.locator('#quickGroupPanel').is_visible()
    key('ArrowLeft')
    assert page.locator('#quickActionsPanel').is_visible()
    page.locator('#quickActionAll').focus();key('Enter')
    assert page.locator('#sidebar').evaluate('(e)=>e.classList.contains("quick-mode")')
    assert not page.locator('#quickActionsPanel').is_visible()
    assert page.locator('#channels').locator('.channel-item').count()>=7
    # Favorites from the actions column: no favorites should give empty list
    key('ArrowLeft');key('ArrowLeft')
    assert page.locator('#quickActionsPanel').is_visible()
    page.locator('#quickActionFavorites').focus();key('Enter')
    assert page.locator('#channels .empty-list').is_visible()
    # Search is available from the same column even when favorites is empty.
    key('ArrowLeft');key('ArrowLeft')
    page.locator('#quickActionSearch').focus();key('Enter')
    assert page.locator('#searchBox').is_visible(), 'quick search field must be visible'
    assert page.evaluate("document.activeElement.id")=='searchInput'
    page.locator('#searchInput').fill('Kids');page.wait_for_timeout(230)
    assert page.locator('#channels .channel-item').count()==1
    assert 'Kids' in page.locator('#channels .channel-name').inner_text()
    # Back out of search, then restore the full-list context.
    key('Escape');assert not page.locator('#sidebar').evaluate('(e)=>e.classList.contains("open")')
    key('ArrowLeft');key('ArrowLeft');key('ArrowLeft')
    assert page.locator('#quickActionsPanel').is_visible()
    page.locator('#quickActionAll').click();page.wait_for_timeout(65)
    assert page.locator('#channels .channel-item').count()>=7
    key('ArrowLeft');assert page.locator('#quickGroupPanel').is_visible()
    key('ArrowRight');assert not page.locator('#quickGroupPanel').is_visible()

    # RIGHT focuses the selected channel EPG. Another RIGHT focuses date column.
    key('ArrowRight');page.wait_for_timeout(120)
    assert page.evaluate("document.activeElement.hasAttribute('data-guide-index')"),page.evaluate('document.activeElement.outerHTML')
    key('ArrowRight')
    assert page.evaluate("document.activeElement.classList.contains('guide-day')")
    assert page.locator('.guide-day').count()>=3
    # Date can be changed with up/down; BACK returns to EPG and then channels.
    key('ArrowDown');assert page.evaluate("document.activeElement.classList.contains('guide-day')")
    page.screenshot(path='/mnt/data/PerfectTVLite028-guide.png')
    key('Escape');assert page.evaluate("document.activeElement.hasAttribute('data-guide-index')")
    key('Escape');assert page.evaluate("document.activeElement.hasAttribute('data-channel')")
    key('Escape');assert not page.locator('#sidebar').evaluate("(e)=>e.classList.contains('open')")
    # OK opens recent channels panel, not the previous full group list.
    key('Enter');assert page.locator('#recentPanel').is_visible()
    assert page.locator('#recentFavorite').is_visible()
    assert page.locator('#recentGuide').is_visible()
    assert page.locator('.recent-channel-card').count()>0
    assert page.locator('.recent-channel-card').first.get_attribute('data-recent-index') is not None
    page.screenshot(path='/mnt/data/PerfectTVLite028-recents.png')
    # Favorite toggle from OK panel stays accessible entirely by remote.
    page.locator('#recentFavorite').focus();key('Enter')
    assert 'Убрать' in page.locator('#recentFavorite').inner_text()
    key('Enter');assert 'Добавить' in page.locator('#recentFavorite').inner_text()
    # Telguide action opens multi-channel timeline with time scale.
    page.locator('#recentGuide').focus();key('Enter');page.wait_for_timeout(350)
    assert page.locator('#tvGrid').is_visible()
    assert page.locator('.tv-grid-row').count()>=4
    assert page.locator('.tv-grid-tick').count()==9
    key('ArrowDown');key('ArrowRight')
    assert page.locator('#tvGridDetails').inner_text()!=''
    # Double LEFT (two presses, within 700 ms) opens TV-grid group selector.
    key('ArrowLeft');key('ArrowLeft')
    assert page.locator('#tvGridGroupsPanel').is_visible()
    page.locator('#toast').evaluate('(e)=>e.classList.add("hidden")')
    page.screenshot(path='/mnt/data/PerfectTVLite029-grid-groups.png')
    assert 'YOSSO TV' in page.locator('#tvGridGroup').inner_text()
    # Groups can be selected from the remote without going back to channel list.
    page.locator('#tvGridGroupsList [data-group="Россия (RU)"]').focus();key('Enter')
    assert not page.locator('#tvGridGroupsPanel').is_visible()
    assert page.locator('#tvGridGroup').inner_text()=='Россия (RU)'
    assert page.locator('.tv-grid-row').count()==2
    # Reopen and test BACK returns to the grid instead of recents.
    key('ArrowLeft');key('ArrowLeft')
    assert page.locator('#tvGridGroupsPanel').is_visible()
    key('Escape')
    assert page.locator('#tvGrid').is_visible() and not page.locator('#tvGridGroupsPanel').is_visible()

    page.screenshot(path='/mnt/data/PerfectTVLite028-tvguide.png')
    key('Escape');assert page.locator('#recentPanel').is_visible()
    key('Escape');assert not page.locator('#recentPanel').is_visible()
    # Keep existing full per-channel guide on right.
    key('ArrowRight');page.wait_for_timeout(250)
    assert page.locator('#guidePanel').is_visible()
    assert page.locator('.guide-day').count()>=3
    key('ArrowRight');assert page.evaluate("document.activeElement.classList.contains('guide-day')")
    key('Escape');assert not page.locator('#guidePanel').is_visible()
    # Archive OK must show *live broadcasting* EPG instead of the archived title.
    key('ArrowRight');page.wait_for_timeout(200)
    archive_title=page.locator('.guide-row.guide-past').first.inner_text()
    page.locator('.guide-row.guide-past').first.click();page.wait_for_timeout(140)
    assert page.locator('#playerMode').inner_text()=='АРХИВ'
    archived_url=page.locator('#video source').get_attribute('src')
    assert 'utc=' in archived_url
    key('Enter')
    assert page.locator('#archiveLivePanel').is_visible()
    assert page.locator('#archiveLiveNow').inner_text().startswith('Передача')
    assert page.locator('#archiveLiveNow').inner_text() not in archive_title
    assert page.locator('#archiveLiveGo').is_visible()
    assert page.locator('#archiveLiveNext').inner_text().startswith('Далее:')
    page.locator('#toast').evaluate('(e)=>e.classList.add("hidden")')
    page.screenshot(path='/mnt/data/PerfectTVLite029-archive-live.png')
    key('Escape')
    assert not page.locator('#archiveLivePanel').is_visible()
    assert page.locator('#video source').get_attribute('src')==archived_url
    assert page.locator('#playerMode').inner_text()=='АРХИВ'
    key('ArrowUp')
    assert page.locator('#archiveSeek').is_visible(), 'archive seek must remain available'
    key('Escape')
    key('Enter')
    assert page.locator('#archiveLivePanel').is_visible()
    key('Enter')
    assert not page.locator('#archiveLivePanel').is_visible()
    assert page.locator('#playerMode').inner_text()=='ПРЯМОЙ ЭФИР'
    assert 'utc=' not in page.locator('#video source').get_attribute('src')
    # Verify history survives app restart and cache format unchanged.
    saved=page.evaluate('localStorage._map')
    assert len(json.loads(saved['perfecttv.webos.preview.v1'])['history'])>=1
    load_page(saved);page.wait_for_timeout(600)
    key('Enter')
    assert page.locator('#recentPanel').is_visible()
    assert page.locator('.recent-channel-card').count()>0
    assert not errors,errors
    print('PASS 0.2.9: compact LEFT channels / group focus / programme dates / OK recents / favorite / grid / Back / history persistence')
    print('requests:',page.evaluate('window.__requests'))
    browser.close()

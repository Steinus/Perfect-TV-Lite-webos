#!/usr/bin/env python3
"""Visual/browser UI tests with mocked same-origin API; network endpoints tested separately in Node."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import re
html=Path(__file__).resolve().parents[1].joinpath('service/config-page.html').read_text()
script=re.search(r'<script>([\s\S]*?)</script>',html).group(1)
html=re.sub(r'<script>[\s\S]*?</script>','',html)
mock=r'''
window.__profiles={returnValue:true,revision:0,playlists:[
 {id:'profile-1',url:'https://provider.example/playlist.m3u8',title:'Yosso TV',epg:'https://epg.example/epg.xml',source:'url'},
 {id:'profile-2',url:'https://provider2.example/playlist.m3u8',title:'Второй плейлист',epg:'',source:'url'}],activePlaylistId:'profile-1'};
window.fetch=function(url,opts){
 var u=String(url),request=opts&&opts.body?JSON.parse(opts.body):{};
 var result={returnValue:true};
 if(u.indexOf('/api/state')===0)result=window.__profiles;
 else if(u.indexOf('/api/profile')===0){
    var profile={id:request.id||'profile-'+(window.__profiles.playlists.length+1),url:request.url,title:request.title,epg:request.epg,source:request.source};
    var i=window.__profiles.playlists.findIndex(function(p){return p.id===profile.id;});
    if(i>=0)window.__profiles.playlists[i]=profile;else window.__profiles.playlists.push(profile);
    if(request.activate)window.__profiles.activePlaylistId=profile.id;
    result={returnValue:true,id:profile.id};
 }else if(u.indexOf('/api/activate')===0){window.__profiles.activePlaylistId=request.id;}
 else if(u.indexOf('/api/delete')===0){window.__profiles.playlists=window.__profiles.playlists.filter(function(p){return p.id!==request.id;});}
 return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(result);}});
};
window.XMLHttpRequest=function(){this.upload={};this.status=200;this.responseText='';};
window.XMLHttpRequest.prototype.open=function(){};
window.XMLHttpRequest.prototype.setRequestHeader=function(){};
window.XMLHttpRequest.prototype.send=function(file){
  var profile={id:'profile-'+(window.__profiles.playlists.length+1),url:'ptv-file://aaaaaaaaaaaaaaaaaaaaaaaa',title:'Импортированный файл',epg:'',source:'file'};
  window.__profiles.playlists.push(profile);window.__profiles.activePlaylistId=profile.id;
  this.responseText=JSON.stringify({returnValue:true,id:profile.id});var self=this;
  setTimeout(function(){self.onload();},20);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1600,'height':950},device_scale_factor=1)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content(html)
 page.add_script_tag(content=mock+script)
 page.wait_for_selector('.profile')
 assert page.locator('.profile').count()==2
 page.locator('#addProfile').click()
 page.locator('#title').fill('Импортированный файл')
 page.locator('input[name=source][value=file]').check()
 assert page.locator('#filePanel').is_visible()
 page.locator('#m3uFile').set_input_files({'name':'iptv.m3u','mimeType':'application/x-mpegurl','buffer':b'#EXTM3U\n#EXTINF:-1,Test\nhttps://stream.example/a.m3u8\n'})
 page.locator('#saveProfile').click()
 page.wait_for_function('document.querySelectorAll(".profile").length === 3',timeout=5000)
 assert page.locator('#message').inner_text().startswith('Файл M3U сохранён')
 assert not errors,errors
 page.screenshot(path='/mnt/data/PerfectTVLite037-web-editor.png',full_page=True)
 print('PASS browser 0.3.7: multiple profiles, file picker, add/upload flow, active status, no JS errors')
 browser.close()

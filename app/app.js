/* Perfect TV Lite: clean-room TV IPTV client. No Android APK code/assets included. */
(function () {
  'use strict';
  var APP_ID = 'com.steinus.perfecttvwebos';
  var SERVICE_ID = APP_ID + '.network';
  var STORAGE = 'perfecttv.webos.preview.v1';
  var state = {
    playlist: {url:'', epg:'', title:'',source:'url'}, channels:[], visible:[], current:-1,
    favorites:{}, mode:'all', group:'', search:'', sidebarOpen:true,
    settingsOpen:false, epg:{}, epgLoading:false, hasPlaylist:false,
    selectedVisible:0, windowStart:-1, windowEnd:-1, epgDiagnostics:'', lastGroupFocusIndex:0,
    playbackGuideOpen:false, playbackGroupList:false,groupsExpanded:false,archive:null,archiveSeekOpen:false,archiveSeekTarget:0,archiveSeekPending:false,archiveSeekFocus:"track",
    resumeKey:'',resumeUrl:'',resumeIndex:-1, remoteRevision:0,sidebarFromPlayback:false,
    quickMode:false,quickGroupOpen:false,quickActionsOpen:false,quickGuideFocused:false,selectedGuideRow:0,
    recentOpen:false,tvGridOpen:false,gridGroupsOpen:false,gridGroup:'',archiveLiveOpen:false,
    history:[],gridStart:0,gridIndex:0,gridCursor:0,gridChannels:[],gridPending:{},
    playlists:[],activePlaylistId:'',editingPlaylistId:'',settingsSection:'playlists',fontSizes:{},deleteConfirmId:''
  };
  var el = {};
  var toastTimer = 0, infoTimer = 0, channelNumber = '', numberTimer = 0;
  var pendingBridges=[];
  var epgServiceStarted=false;
  var ROW_HEIGHT=90, OVERSCAN=5, renderScrollTimer=0, searchTimer=0, keyReady=true;
  var guideRequestTimer=0, guideRequestSerial=0, serviceHold=null, streamInfoSerial=0;
  var remotePollTimer=0, remoteStartSerial=0, seekTimer=0, seekCommitTimer=0;
  var netSpeedBridge=null,netSpeedBusy=false,netSpeedWatchdog=0;
  var guideCache={}, guideCacheOrder=[];
  var gridGuideCache={},gridGuideOrder=[],recentFocusIndex=0,gridLeftAt=0,gridLeftOrigin=0;
  var epgRefreshTimer=0, epgRestoreSerial=0, epgLastChecked=0, epgNowBusy=false;
  var weekdays=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  var FONT_OPTIONS=[
    {key:'channel',name:'Названия каналов',value:22,min:17,max:30},
    {key:'program',name:'Передачи в списке',value:20,min:15,max:28},
    {key:'guide',name:'Строки телепрограммы',value:20,min:16,max:30},
    {key:'description',name:'Описания передач',value:21,min:16,max:30},
    {key:'hints',name:'Подсказки кнопок',value:18,min:14,max:25},
    {key:'menus',name:'Меню и группы',value:19,min:16,max:28},
    {key:'title',name:'Название канала в информации',value:36,min:26,max:44},
    {key:'zapName',name:'Название под логотипом при переключении',value:24,min:17,max:38},
    {key:'zapEpg',name:'Сейчас / Далее при переключении',value:25,min:17,max:39},
    {key:'infoEpg',name:'Сейчас / Далее в полной информации',value:24,min:18,max:40},
    {key:'infoLabels',name:'Подписи Сейчас и Далее',value:19,min:15,max:28}
  ];
  var nextProfileNumber=1;

  function id(k){return document.getElementById(k);}
  function show(k){el[k].classList.remove('hidden');}
  function hide(k){el[k].classList.add('hidden');}
  function safeStorageGet(){try{return JSON.parse(localStorage.getItem(STORAGE)||'{}');}catch(e){return {};}}
  function save(){
    // Keep the old 'playlist' field so older IPKs can still read the active profile.
    var active=profileById(state.activePlaylistId);
    if(active){
      active.url=state.playlist.url||'';active.epg=state.playlist.epg||'';active.title=state.playlist.title||'';active.source=state.playlist.source||'url';
      if(state.current>=0&&state.channels[state.current])active.lastKey=state.channels[state.current].key;
    }
    try {localStorage.setItem(STORAGE,JSON.stringify({playlist:state.playlist,playlists:state.playlists,activePlaylistId:state.activePlaylistId,
      fontSizes:state.fontSizes,favorites:state.favorites,last:state.current,lastKey:state.channels[state.current]?state.channels[state.current].key:state.resumeKey,
      lastUrl:state.playlist.url,mode:state.mode,group:state.group,history:state.history.slice(0,20)}));}
    catch(e){toast('Не удалось сохранить настройки: недостаточно памяти.');}
  }
  function profileById(which){
    for(var i=0;i<state.playlists.length;i++)if(state.playlists[i].id===which)return state.playlists[i];
    return null;
  }
  function makeProfile(url,epg,title,lastKey,source){
    var id='profile-'+Date.now()+'-'+(nextProfileNumber++);
    return {id:id,url:url||'',epg:epg||'',title:title||'Плейлист '+(state.playlists.length+1),lastKey:lastKey||'',source:source==='file'?'file':'url'};
  }
  function restoreProfiles(saved){
    var found={},list=[],raw=Array.isArray(saved.playlists)?saved.playlists:[];
    for(var i=0;i<raw.length&&i<30;i++){
      var o=raw[i];if(!o||!o.id||!validPlaylistUrl(o.url)||found[o.id])continue;
      found[o.id]=true;list.push({id:String(o.id),url:String(o.url),epg:String(o.epg||''),title:String(o.title||'Плейлист '+(i+1)),lastKey:String(o.lastKey||''),source:isLocalPlaylistUrl(o.url)?'file':'url'});
    }
    // Migration from 0.2.9 and earlier: never overwrite the existing IPTV profile.
    if(!list.length&&saved.playlist&&normalURL(saved.playlist.url)){
      list.push(makeProfile(saved.playlist.url,saved.playlist.epg,saved.playlist.title,saved.lastKey));
    }
    state.playlists=list;
    var active=profileById(saved.activePlaylistId)||list[0];
    state.activePlaylistId=active?active.id:'';
    state.editingPlaylistId=state.activePlaylistId;
    state.playlist=active?{url:active.url,epg:active.epg,title:active.title,source:active.source||'url'}: {url:'',epg:'',title:'',source:'url'};
  }
  function applyFonts(){
    for(var i=0;i<FONT_OPTIONS.length;i++){
      var opt=FONT_OPTIONS[i],v=Number(state.fontSizes[opt.key]);
      if(!isFinite(v)||v<opt.min||v>opt.max)v=opt.value;
      v=Math.round(v);state.fontSizes[opt.key]=v;
      document.documentElement.style.setProperty('--ptv-font-'+opt.key,v+'px');
    }
  }
  function toast(t, duration){
    clearTimeout(toastTimer);el.toast.textContent=t;show('toast');
    toastTimer=setTimeout(function(){hide('toast');},duration||3400);
  }
  function loading(on, text){
    if(on){el.loadingText.textContent=text||'Загрузка...';show('loading');}
    else{hide('loading');}
  }
  function pad(n){return ('0'+n).slice(-2);}
  function updateClock(){var d=new Date();el.clock.textContent=weekdays[d.getDay()]+' · '+pad(d.getHours())+':'+pad(d.getMinutes());}
  function refreshTopline(){
    var visible=state.current>=0&&(state.sidebarOpen||state.playbackGuideOpen||state.settingsOpen||state.archiveSeekOpen||state.recentOpen||state.tvGridOpen||state.archiveLiveOpen||!el.playerInfo.classList.contains('hidden'));
    el.topline.classList.toggle('clock-only',visible&&(state.sidebarOpen||state.playbackGuideOpen||state.settingsOpen||state.archiveSeekOpen||state.recentOpen||state.tvGridOpen||state.archiveLiveOpen));
    if(visible){updateClock();show('topline');}
    else hide('topline');
  }
  function normalURL(value){
    value=(value||'').trim();
    if(!/^https?:\/\/[^\s]+$/i.test(value)) return '';
    return value;
  }
  function isLocalPlaylistUrl(value){return /^ptv-file:\/\/[0-9a-f]{24}$/.test(String(value||''));}
  function validPlaylistUrl(value){return isLocalPlaylistUrl(value)?String(value):normalURL(value);}
  function baseResolve(url, base){
    try {return new URL(url,base).href;}catch(e){
      var a=document.createElement('a');a.href=base;a.href=url;return a.href||url;
    }
  }

  function transport(url, success, fail, usePlaylistCache, forceNetwork){
    // A packaged JS Service fetches playlist text outside Chromium's CORS sandbox.
    // If the service can't start, we also try a plain HTTP request.
    if(typeof window.PalmServiceBridge==='function') {
      var bridge=new window.PalmServiceBridge();
      pendingBridges.push(bridge);
      var finished=false;
      // Service may use two network transports (system curl and legacy Node).
      // Never expire before its own bounded 25+22 second retry finishes.
      var timer=setTimeout(function(){complete(false,'Сетевой сервис не ответил за 55 секунд');},55000);
      function complete(ok,result,meta){
        if(finished)return;
        finished=true;clearTimeout(timer);
        var p=pendingBridges.indexOf(bridge);if(p>=0)pendingBridges.splice(p,1);
        if(ok){success(result,meta||null);}
        else fail(result); // A CORS-denied browser retry cannot fix service HTTPS errors.
      }
      bridge.onservicecallback=function(json){
        var result;
        try{result=JSON.parse(json);}catch(e){complete(false,'Неверный ответ сетевого сервиса');return;}
        if(result.returnValue===true && typeof result.text==='string') complete(true,result.text,result);
        else complete(false,result.errorText||result.errorCode||result.error||'Сетевой сервис недоступен');
      };
      try{bridge.call('luna://'+SERVICE_ID+'/getText',JSON.stringify({url:url,playlist:!!usePlaylistCache,force:!!forceNetwork}));}
      catch(e){complete(false,e.message||'Ошибка вызова сервиса');}
    } else if(isLocalPlaylistUrl(url))fail('Локальный файл M3U доступен только через webOS-сервис.');
    else browserTransport(url,success,fail);
  }
  function browserTransport(url,success,fail,maxBytes){
    var xhr=new XMLHttpRequest();xhr.open('GET',url,true);xhr.timeout=20000;
    xhr.onload=function(){if(xhr.status>=200&&xhr.status<300||xhr.status===0&&xhr.responseText){success(xhr.responseText);}else fail('HTTP '+xhr.status);};
    xhr.onerror=function(){fail('CORS или сетевая ошибка. Проверь URL, доступ к сети и webOS-сервис.');};
    if(maxBytes){xhr.onprogress=function(e){
      if(e.loaded>maxBytes){xhr.abort();fail('EPG превышает 8 МБ без webOS-сервиса');}
    };}
    xhr.ontimeout=function(){fail('Истекло время ожидания сервера.');};
    try{xhr.send();}catch(e){fail(e.message||'Ошибка загрузки');}
  }
  function checkService(){
    if(typeof window.PalmServiceBridge!=='function'){
      el.serviceStatus.className='statusline bad';
      el.serviceStatus.textContent='Сервис webOS не обнаружен. Для потокового EPG требуется webOS-сервис.';
      return;
    }
    var bridge=new window.PalmServiceBridge();pendingBridges.push(bridge);
    var finished=false,timer=setTimeout(function(){done(false,'не ответил за 8 с');},8000);
    function done(ok,detail){
      if(finished)return;finished=true;clearTimeout(timer);
      var pos=pendingBridges.indexOf(bridge);if(pos>=0)pendingBridges.splice(pos,1);
      el.serviceStatus.className='statusline '+(ok?'ok':'bad');
      el.serviceStatus.textContent=ok?'Сетевой сервис подключён ('+detail+')':'Сетевой сервис: '+detail;
    }
    bridge.onservicecallback=function(txt){
      try{var r=JSON.parse(txt);done(r.returnValue===true,r.returnValue?'v'+(r.serviceVersion||'?')+', потоковый EPG: '+(r.epgStreaming?'да':'нет')+(r.userAgent?', UA: '+r.userAgent:''):(r.errorText||'недоступен'));}
      catch(e){done(false,'некорректный ответ');}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/ping','{}');}catch(e){done(false,e.message||'не запущен');}
  }
  function parseAttributes(line){
    var result={},re=/([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g,m;
    while((m=re.exec(line))!==null){result[m[1].toLowerCase()]=m[2]!==undefined?m[2]:(m[3]!==undefined?m[3]:m[4]);}
    return result;
  }
  function metaSplit(line){
    var quoted=false,q='',idx=-1;
    for(var i=0;i<line.length;i++){
      var c=line.charAt(i);
      if(c==='"'||c==="'"){
        if(!quoted){quoted=true;q=c;}else if(q===c)quoted=false;
      } else if(c===','&&!quoted){idx=i;break;}
    }
    return idx===-1?['',line]:[line.slice(0,idx),line.slice(idx+1)];
  }
  function parseM3U(text, baseUrl){
    text=text.replace(/^\uFEFF/,'').replace(/\r/g,'');
    if(text.indexOf('#EXTM3U')<0 && text.indexOf('#EXTINF')<0) throw new Error('URL не содержит M3U-плейлист.');
    var lines=text.split('\n'),channels=[],info=null,logo='',extgrp='',ua='',referrer='',headEpg='',headCatchup={},hd={};
    for(var i=0;i<lines.length;i++){
      var line=lines[i].trim();if(!line)continue;
      if(line.indexOf('#EXTM3U')===0){
        hd=parseAttributes(line);headEpg=hd['x-tvg-url']||hd['url-tvg']||headEpg;headCatchup=hd;
      }else if(line.indexOf('#EXTINF:')===0){
        var parts=metaSplit(line),at=parseAttributes(parts[0]);
        info={name:(parts[1]||at['tvg-name']||'Без названия').trim(),
          group:(at['group-title']||'Без категории').trim(),
          id:at['tvg-id']||'',tvgName:at['tvg-name']||'',logo:at['tvg-logo']||'',
          catchup:at['catchup']||at['catchup-type']||headCatchup['catchup']||headCatchup['catchup-type']||'',
          catchupSource:at['catchup-source']||headCatchup['catchup-source']||'',
          catchupCorrection:at['catchup-correction']||headCatchup['catchup-correction']||'0',
          duration:at['catchup-days']||headCatchup['catchup-days']||at['timeshift']||at['tvg-rec']||headCatchup['tvg-rec']||'',
          timeshift:at['timeshift']||at['tvg-rec']||headCatchup['timeshift']||'',
          bitrate:at['bitrate']||at['tvg-bitrate']||'',resolution:at['resolution']||at['tvg-resolution']||''};
        extgrp='';ua='';referrer='';
      }else if(line.indexOf('#EXTGRP:')===0){extgrp=line.substring(8).trim();}
      else if(line.indexOf('#EXTVLCOPT:http-user-agent=')===0){ua=line.substring(27);}
      else if(line.indexOf('#EXTVLCOPT:http-referrer=')===0){referrer=line.substring(26);}
      else if(line.charAt(0)!=='#'){
        if(info){
          if(isLocalPlaylistUrl(baseUrl)&&!/^https?:\/\//i.test(line))throw new Error('В файле M3U найдены относительные адреса потоков. Для импорта нужны абсолютные HTTP/HTTPS-ссылки.');
          info.url=baseResolve(line,baseUrl);
          info.group=(extgrp||info.group||'Без категории');
          info.num=channels.length+1;info.ua=ua;info.referrer=referrer;
          info.key=info.url;channels.push(info);
        }
        info=null;extgrp='';ua='';referrer='';
      }
    }
    return {channels:channels,epg:headEpg};
  }
  function loadPlaylist(restoreOnBoot,forceNetwork,preserveSettings){
    var url=validPlaylistUrl(state.playlist.url);
    if(!url){openSettings();toast('Добавь M3U по URL или файлом через веб-редактор.');return;}
    loading(true,forceNetwork?'Обновляю M3U с сервера...':'Открываю сохранённый M3U...');
    transport(url,function(body,meta){
      try{
        var parsed=parseM3U(body,url);
        if(!parsed.channels.length)throw new Error('В плейлисте не найдено ни одного канала.');
        state.channels=parsed.channels;state.hasPlaylist=true;state.epg={};guideCache={};guideCacheOrder=[];
        state.epgDiagnostics='';setEpgStatus('EPG: ожидание загрузки');if(el.epgDebug)el.epgDebug.textContent='';
        if(!state.playlist.epg && parsed.epg) state.playlist.epg=baseResolve(parsed.epg.split(',')[0],url);
        el.epgUrl.value=state.playlist.epg;
        var resume=-1;
        if(restoreOnBoot && state.resumeUrl===url){
          for(var r=0;r<state.channels.length;r++)if(state.channels[r].key===state.resumeKey){resume=r;break;}
          if(resume<0&&!state.resumeKey&&state.resumeIndex>=0&&state.resumeIndex<state.channels.length)resume=state.resumeIndex;
        }
        state.current=-1;state.group='';state.mode='all';state.groupsExpanded=false;state.search='';state.selectedVisible=0;state.windowStart=-1;el.searchInput.value='';
        hide('searchBox');hide('groups');
        render();loading(false);if(!preserveSettings)closeSettings();else {renderProfileList();populateProfileFields(profileById(state.activePlaylistId));}
        if(resume>=0){playChannel(resume);}
        else{save();showSidebar();}
        el.idle.querySelector('small').textContent='Выбери канал в списке слева';
        toast('Загружено '+parsed.channels.length+' каналов'+(meta&&meta.cached?' · сохранённый M3U':''));
        if(meta&&meta.cacheSaved===false)toast('Внимание: M3U не сохранён на телевизоре: '+(meta.cacheError||'ошибка записи'),9000);
        if(state.playlist.epg)restoreCachedEpg();
      }catch(e){loading(false);toast('Ошибка M3U: '+e.message,6000);}
    },function(error){loading(false);openSettings();toast('Не удалось загрузить M3U: '+error,7000);},true,!!forceNetwork);
  }
  function setEpgStatus(text){state.epgDiagnostics=text;if(el.epgStatus)el.epgStatus.textContent=text;}
  function unpackProgram(row){return row?{name:row[0],start:row[1],end:row[2],desc:row[3]||''}:null;}
  function displayEpg(entries,stats,quiet){
    stats=stats||{};
    var mapped={};
    for(var i=0;i<entries.length;i++){
      var item=entries[i],ch=state.channels[item[0]];
      if(ch)mapped[ch.key]={current:unpackProgram(item[1]),next:unpackProgram(item[2])};
    }
    state.epg=mapped;
    guideCache={};guideCacheOrder=[];
    if(state.sidebarOpen&&state.visible.length){
      var selected=state.visible[Math.min(state.selectedVisible,state.visible.length-1)];
      if(selected)selectChannelGuide(selected);
    }
    var matched=Object.keys(mapped).length;
    var note='EPG: '+matched+' \u0438\u0437 '+state.channels.length+' \u043a\u0430\u043d\u0430\u043b\u043e\u0432';
    if(stats.transport)note+=' · '+stats.transport;
    if(typeof stats.providerChannels==='number')note+=' \u00b7 XMLTV: '+stats.providerChannels+' \u043a\u0430\u043d\u0430\u043b\u043e\u0432';
    if(typeof stats.programmes==='number')note+=' / '+stats.programmes+' \u043f\u0435\u0440\u0435\u0434\u0430\u0447';
    if(typeof stats.byId==='number')note+=' \u00b7 ID: '+stats.byId+', \u0438\u043c\u044f: '+stats.byName;
    if(stats.bytes && stats.wireBytes)note+=' \u00b7 '+(stats.encoding||'XML')+' '+(stats.wireBytes/1048576).toFixed(1)+' / '+(stats.bytes/1048576).toFixed(1)+' \u041c\u0438\u0411';
    if(typeof stats.guideEntries==='number')note+=' · расписание: '+stats.guideEntries+' записей'+(stats.guideTruncated?' (ограничено памятью)':'');
    if(typeof stats.guideDescriptionCount==='number')note+=' \u00b7 \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0439: '+stats.guideDescriptionCount;
    if(stats.peakXmlBuffer)note+=' \u00b7 XML-буфер '+Math.ceil(stats.peakXmlBuffer/1024)+' КиБ';
    if(stats.cacheBytes)note+=' · кэш '+(stats.cacheBytes/1048576).toFixed(1)+' МиБ';
    if(stats.checkedAt)note+=' · проверено '+new Date(stats.checkedAt).toLocaleString('ru-RU');
    if(stats.cacheError)note+=' · не удалось сохранить кэш: '+stats.cacheError;
    setEpgStatus(note);
    var lines=[];
    if(typeof stats.recognized==='number'){
      lines.push('\u041a\u0430\u043d\u0430\u043b\u044b, \u043e\u043f\u043e\u0437\u043d\u0430\u043d\u043d\u044b\u0435 \u043f\u043e ID/\u0438\u043c\u0435\u043d\u0438: '+stats.recognized+'; \u0431\u0435\u0437 \u0442\u0435\u043a\u0443\u0449\u0438\u0445 \u043f\u0435\u0440\u0435\u0434\u0430\u0447: '+stats.missingProgramme+'.');
      lines.push('\u041a\u0430\u043d\u0430\u043b\u044b \u0441 \u0442\u0435\u043a\u0443\u0449\u0438\u043c\u0438/\u0431\u043b\u0438\u0436\u0430\u0439\u0448\u0438\u043c\u0438 \u043f\u0435\u0440\u0435\u0434\u0430\u0447\u0430\u043c\u0438: '+(stats.activeSchedules||0));
    }
    if(!matched && stats.samples && stats.samples.length){
      lines.push('\u041f\u0440\u0438\u043c\u0435\u0440\u044b \u0438\u0437 XMLTV:');
      for(var n=0;n<stats.samples.length;n++)lines.push('  '+stats.samples[n][1]+' [ID: '+stats.samples[n][0]+']');
    }
    if(!matched && stats.requestedSample && stats.requestedSample.length){
      lines.push('\u041f\u0440\u0438\u043c\u0435\u0440\u044b \u0438\u0437 M3U:');
      for(var j=0;j<stats.requestedSample.length;j++)lines.push('  '+stats.requestedSample[j][1]+' [tvg-id: '+stats.requestedSample[j][0]+']');
    }
    if(el.epgDebug)el.epgDebug.textContent=lines.join('\n');
    updateVisibleEpg();updatePlayerInfo();
    if(matched&&!quiet)toast('EPG: '+matched+' \u043a\u0430\u043d\u0430\u043b\u043e\u0432',6500);
    else if(!quiet&&stats.recognized>0)toast('EPG: \u043a\u0430\u043d\u0430\u043b\u044b \u043d\u0430\u0439\u0434\u0435\u043d\u044b, \u043d\u043e \u043d\u0435\u0442 \u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0445 \u043f\u0435\u0440\u0435\u0434\u0430\u0447',7500);
    else if(!quiet)toast('EPG: ID \u0438 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f \u043a\u0430\u043d\u0430\u043b\u043e\u0432 \u043d\u0435 \u0441\u043e\u0432\u043f\u0430\u043b\u0438',7500);
  }
  function compactEpgChannels(){
    var compact=[];
    for(var i=0;i<state.channels.length;i++){
      var c=state.channels[i];compact.push([c.id||'',c.name||'',c.tvgName||'']);
    }
    return compact;
  }
  function pingEpgService(callback){
    if(typeof window.PalmServiceBridge!=='function'){
      callback(false,'PalmServiceBridge отсутствует');return;
    }
    var bridge=new window.PalmServiceBridge(), finished=false;
    pendingBridges.push(bridge);
    var timer=setTimeout(function(){done(false,'не ответил на ping за 8 секунд');},8000);
    function done(ok,reason){
      if(finished)return;
      finished=true;clearTimeout(timer);
      var pos=pendingBridges.indexOf(bridge);if(pos>=0)pendingBridges.splice(pos,1);
      callback(ok,reason);
    }
    bridge.onservicecallback=function(txt){
      try{var r=JSON.parse(txt);
        if(r.returnValue===true)done(true,'v'+(r.serviceVersion||'?'));
        else done(false,r.errorText||r.errorCode||r.error||'сервис отклонил запрос');
      }catch(e){done(false,'сервис прислал повреждённый ответ');}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/ping','{}');}
    catch(e){done(false,e.message||'ошибка вызова сетевого сервиса');}
  }
  // Единственный способ EPG: один HTTP GET внутри webOS-сервиса.
  // Сервис по мере прихода байтов распаковывает GZIP и разбирает XMLTV.
  // WebView не скачивает и не хранит файл, а получает только «сейчас/далее».
  function cancelEpg(){
    if(!state.epgLoading)return;
    if(!epgServiceStarted){
      state.epgLoading=false;loading(false);
      el.refreshEpg.textContent='Обновить EPG';
      setEpgStatus('EPG: отменено до начала загрузки');
      return;
    }
    setEpgStatus('EPG: останавливаю сетевой поток...');
    var bridge=new window.PalmServiceBridge();
    bridge.onservicecallback=function(){};
    try{bridge.call('luna://'+SERVICE_ID+'/cancelEpg','{}');}
    catch(e){toast('Не удалось остановить EPG: '+e.message,6000);}
  }
  function serviceEpg(url,force,quiet){
    epgServiceStarted=true;
    var bridge=new window.PalmServiceBridge(),finished=false,pollTimer=0;
    pendingBridges.push(bridge);
    var watchdog=setTimeout(function(){
      var killer=new window.PalmServiceBridge();
      killer.onservicecallback=function(){};
      try{killer.call('luna://'+SERVICE_ID+'/cancelEpg','{}');}catch(e){}
      complete(false,'Потоковый EPG не завершился за 10 минут');
    },600000);
    function complete(ok,result){
      if(finished)return;
      finished=true;clearTimeout(watchdog);clearTimeout(pollTimer);
      var pos=pendingBridges.indexOf(bridge);if(pos>=0)pendingBridges.splice(pos,1);
      state.epgLoading=false;epgServiceStarted=false;loading(false);
      el.refreshEpg.textContent='Обновить EPG';
      if(ok){
        displayEpg(result.items||[],result.stats||{},!!quiet);
        epgLastChecked=Number(result.stats&&result.stats.checkedAt||Date.now());
        scheduleEpgRefresh(epgLastChecked);
      }
      else {
        var reason=String(result||'Неизвестная ошибка XMLTV');
        setEpgStatus('EPG: ошибка потока: '+reason);
        toast('EPG: '+reason,9000);
        if(quiet)scheduleEpgRetry();
      }
    }
    function pollProgress(){
      if(finished)return;
      var p=new window.PalmServiceBridge(),handled=false;
      var limit=setTimeout(function(){scheduleNext();},6000);
      function scheduleNext(){
        if(handled)return;
        handled=true;clearTimeout(limit);
        if(!finished)pollTimer=setTimeout(pollProgress,2300);
      }
      p.onservicecallback=function(txt){
        if(handled)return;
        try{
          var r=JSON.parse(txt);
          if(r.returnValue===true&&r.running&&!finished){
            var net=Number(r.wireBytes||0),xml=Number(r.bytes||0),total=Number(r.totalBytes||0);
            var percent=total?Math.min(99,Math.floor(net*100/total)):-1;
            var prefix=percent<0?'':percent+'% · ';
            var note='EPG: HTTP-поток '+prefix+(net/1048576).toFixed(1);
            if(total)note+='/'+(total/1048576).toFixed(1);
            note+=' МиБ · XML '+(xml/1048576).toFixed(1)+' МиБ · '+(r.programmes||0)+' передач';
            if(r.state==='finishing')note+=' · завершаю';
            setEpgStatus(note);
            el.loadingText.textContent='EPG: поток '+prefix+(r.programmes||0)+' передач';
          }
        }catch(e){}
        scheduleNext();
      };
      try{p.call('luna://'+SERVICE_ID+'/getEpgProgress','{}');}
      catch(e){scheduleNext();}
    }
    bridge.onservicecallback=function(txt){
      try{
        var r=JSON.parse(txt);
        if(r.returnValue===true&&Array.isArray(r.items))complete(true,r);
        else complete(false,r.errorText||r.error||'Не удалось обработать XMLTV');
      }catch(e){complete(false,'Некорректный ответ EPG-сервиса');}
    };
    try{
      bridge.call('luna://'+SERVICE_ID+'/getEpg',JSON.stringify({url:url,channels:compactEpgChannels(),force:!!force}));
      pollTimer=setTimeout(pollProgress,1400);
    }catch(e){complete(false,e.message||'Не запускается EPG-сервис');}
  }
  function scheduleEpgRetry(){
    clearTimeout(epgRefreshTimer);
    epgRefreshTimer=setTimeout(function(){
      if(state.channels.length&&normalURL(state.playlist.epg)&&!state.epgLoading)loadEpg(false,true);
    },3600000);
  }
  // Cache first: the TV starts with saved guide instantly; only a 24-hour
  // expiry triggers a new conditional HTTP request. No XMLTV in localStorage.
  function scheduleEpgRefresh(lastChecked){
    clearTimeout(epgRefreshTimer);
    var deadline=Number(lastChecked||0)+86400000;
    var wait=Math.max(60000,deadline-Date.now()+1000);
    epgRefreshTimer=setTimeout(function(){
      if(!state.channels.length||!normalURL(state.playlist.epg))return;
      if(state.epgLoading){scheduleEpgRefresh(Date.now()-86400000+1800000);return;}
      loadEpg(false,true);
    },Math.min(86400000,wait));
  }
  function restoreCachedEpg(){
    var url=normalURL(state.playlist.epg);
    if(!url||!state.channels.length)return;
    clearTimeout(epgRefreshTimer);var serial=++epgRestoreSerial;
    if(typeof window.PalmServiceBridge!=='function'){
      setEpgStatus('EPG: кэш недоступен, загружаю телепрограмму');loadEpg(false,true);return;
    }
    setEpgStatus('EPG: читаю сохранённую телепрограмму...');
    var bridge=new window.PalmServiceBridge(),done=false;
    var timeout=setTimeout(function(){finish(null);},20000);
    function finish(r){
      if(done)return;done=true;clearTimeout(timeout);
      if(serial!==epgRestoreSerial)return;
      if(r&&r.returnValue&&r.found&&Array.isArray(r.items)){
        displayEpg(r.items,r.stats||{},true);
        epgLastChecked=Number(r.checkedAt||0);
        if(r.fresh){scheduleEpgRefresh(epgLastChecked);return;}
        setEpgStatus(state.epgDiagnostics+' · обновляю кэш по истечении 24 ч');
      }else setEpgStatus('EPG: локального кэша пока нет');
      loadEpg(false,true);
    }
    bridge.onservicecallback=function(text){try{finish(JSON.parse(text));}catch(e){finish(null);}};
    try{bridge.call('luna://'+SERVICE_ID+'/getCachedEpg',JSON.stringify({url:url,channels:compactEpgChannels()}));}
    catch(e){finish(null);}
  }
  function refreshEpgNow(){
    if(epgNowBusy||state.epgLoading||!state.channels.length||!epgLastChecked||typeof window.PalmServiceBridge!=='function')return;
    epgNowBusy=true;
    var bridge=new window.PalmServiceBridge(),watch=setTimeout(function(){epgNowBusy=false;},7000);
    bridge.onservicecallback=function(text){
      if(!epgNowBusy)return;clearTimeout(watch);epgNowBusy=false;
      try{
        var r=JSON.parse(text);if(!r.returnValue||!Array.isArray(r.items))return;
        var mapped={},i,item,ch;
        for(i=0;i<r.items.length;i++){
          item=r.items[i];ch=state.channels[item[0]];
          if(ch)mapped[ch.key]={current:unpackProgram(item[1]),next:unpackProgram(item[2])};
        }
        state.epg=mapped;updateVisibleEpg();updatePlayerInfo();
      }catch(e){}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/getEpgNow','{}');}catch(e){clearTimeout(watch);epgNowBusy=false;}
  }
  function loadEpg(force,quiet){
    var url=normalURL(state.playlist.epg);
    if(!url){setEpgStatus('EPG: URL не указан');return;}
    if(state.epgLoading){toast('EPG уже загружается. Прогресс виден в Настройках.',4200);return;}
    if(!state.channels.length){setEpgStatus('EPG: сначала загрузи M3U-плейлист');return;}
    state.epgLoading=true;epgServiceStarted=false;
    el.refreshEpg.textContent='Остановить EPG';
    if(!quiet)loading(true,'Проверяю EPG-сервис...');
    setEpgStatus('EPG: проверяю сетевой сервис...');
    pingEpgService(function(ok,reason){
      if(!state.epgLoading)return;
      if(ok){
        el.serviceStatus.className='statusline ok';
        el.serviceStatus.textContent='Сетевой сервис подключён ('+reason+', один HTTP-поток, без исходного XMLTV на диске)';
        el.loadingText.textContent='EPG: потоковая обработка XMLTV...';
        setEpgStatus('EPG: один HTTP GET → GZIP → XMLTV; сохраняется только компактное расписание');
        serviceEpg(url,force,quiet);
      }else{
        state.epgLoading=false;loading(false);
        el.refreshEpg.textContent='Обновить EPG';
        el.serviceStatus.className='statusline bad';
        el.serviceStatus.textContent='Сетевой сервис: '+reason;
        var error='EPG: необходим потоковый webOS-сервис ('+reason+')';
        setEpgStatus(error);toast(error,8500);
        if(quiet)scheduleEpgRetry();
      }
    });
  }

  // Keep only a few recently viewed guides in the web view. The rest of the
  // compact guide remains in the JS service while a bus subscription exists.
  function holdGuideService(){
    if(serviceHold||typeof window.PalmServiceBridge!=='function')return;
    try{
      var bridge=new window.PalmServiceBridge();
      bridge.onservicecallback=function(){};
      bridge.call('luna://'+SERVICE_ID+'/holdGuide','{"subscribe":true}');
      serviceHold=bridge;
    }catch(e){serviceHold=null;}
  }
  function timeLabel(value){
    var d=new Date(value);return pad(d.getHours())+':'+pad(d.getMinutes());
  }
  function dayLabel(value){
    var d=new Date(value);
    return weekdays[d.getDay()]+' '+pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+d.getFullYear();
  }
  function findPrograms(rows){
    var now=Date.now(),current=null,next=null;
    for(var i=0;i<rows.length;i++){
      var r=rows[i];
      if(r[1]<=now&&r[2]>now&&(!current||r[1]>current[1]))current=r;
      if(r[1]>now&&(!next||r[1]<next[1]))next=r;
    }
    return {current:current,next:next};
  }
  function refreshGuideSummary(ch,rows){
    if(!ch)return;
    var p=findPrograms(rows);
    if(p.current||p.next)state.epg[ch.key]={current:unpackProgram(p.current),next:unpackProgram(p.next)};
    if(state.current===ch.num-1)updatePlayerInfo();
    updateVisibleEpg();
  }
  function cacheGuide(index,rows){
    if(guideCache[index])guideCacheOrder.splice(guideCacheOrder.indexOf(index),1);
    guideCache[index]=rows;guideCacheOrder.push(index);
    if(guideCacheOrder.length>6)delete guideCache[guideCacheOrder.shift()];
  }
  function showGuideText(ch){
    el.guideName.textContent=ch.name;
    el.guideRange.textContent='Канал № '+ch.num+' · '+ch.group;
    el.guideLogo.src=ch.logo||'';
    el.guideLogo.style.display=ch.logo?'block':'none';
  }
  function guideMessage(message){
    el.guideRows.textContent='';el.guideRows.appendChild(create('div','guide-empty',message));
    el.guideSelectedTime.textContent='';el.guideSelectedTitle.textContent='';el.guideSelectedDesc.textContent='';
    el.guideDates.textContent='';
  }
  function selectChannelGuide(ch){
    if((!state.sidebarOpen&&!state.playbackGuideOpen)||state.settingsOpen||!ch||state.sidebarFromPlayback||state.quickGroupOpen)return;
    if(!state.playbackGuideOpen)el.guideNavHint.textContent='↑ / ↓ — передачи · ← — каналы · → — даты';
    show('guidePanel');showGuideText(ch);
    var index=ch.num-1,serial=++guideRequestSerial;
    clearTimeout(guideRequestTimer);
    if(guideCache[index]){renderGuide(ch,guideCache[index]);return;}
    guideMessage(state.epgLoading?'EPG загружается. Полное расписание появится после завершения.':'Читаю программу выбранного канала...');
    if(state.epgLoading||!Object.keys(state.epg).length)return;
    guideRequestTimer=setTimeout(function(){
      if((!state.sidebarOpen&&!state.playbackGuideOpen)||state.epgLoading||serial!==guideRequestSerial)return;
      if(typeof window.PalmServiceBridge!=='function'){
        guideMessage('Для просмотра телепрограммы нужен сетевой сервис webOS.');return;
      }
      var bridge=new window.PalmServiceBridge(),finished=false;
      pendingBridges.push(bridge);
      var timeout=setTimeout(function(){done(null,'Сервис телепрограммы не ответил');},10000);
      function done(rows,err){
        if(finished)return;finished=true;clearTimeout(timeout);
        var j=pendingBridges.indexOf(bridge);if(j>=0)pendingBridges.splice(j,1);
        if(rows){cacheGuide(index,rows);refreshGuideSummary(ch,rows);}
        if(serial!==guideRequestSerial||(!state.sidebarOpen&&!state.playbackGuideOpen))return;
        if(rows)renderGuide(ch,rows);
        else guideMessage((err||'Телепрограмма недоступна')+'. Если сервис был перезапущен, обнови EPG в настройках.');
      }
      bridge.onservicecallback=function(txt){
        try{var r=JSON.parse(txt);
          if(r.returnValue===true&&Array.isArray(r.rows))done(r.rows,null);
          else done(null,r.errorText||'Расписание отсутствует');
        }catch(e){done(null,'Некорректный ответ сервиса');}
      };
      try{bridge.call('luna://'+SERVICE_ID+'/getGuide',JSON.stringify({index:index}));}
      catch(e){done(null,e.message||'Ошибка запроса EPG');}
    },165);
  }
  function renderGuide(ch,rows){
    if((!state.sidebarOpen&&!state.playbackGuideOpen)||!ch)return;
    show('guidePanel');showGuideText(ch);
    el.guideRows.textContent='';
    if(!rows||!rows.length){el.guideDates.textContent='';guideMessage('Нет доступных передач для этого канала в XMLTV.');return;}
    var fragment=document.createDocumentFragment(),lastDay='',onAir=null,next=null,now=Date.now();
    var closest=-1,firstFuture=-1;
    for(var i=0;i<rows.length;i++){
      var r=rows[i],day=dayLabel(r[1]);
      if(day!==lastDay){fragment.appendChild(create('div','guide-date',day));lastDay=day;}
      var button=create('button','guide-row'+(r[1]<=now&&r[2]>now?' guide-onair':(r[2]<=now?' guide-past':'')));
      button.setAttribute('data-guide-index',i);button.setAttribute('data-focus','1');
      if(r[1]<now&&canArchive(ch,r))button.classList.add('archive-available');
      button.appendChild(create('span','guide-time',timeLabel(r[1])));
      button.appendChild(create('span','guide-program',r[0]));
      button.onfocus=(function(rr,idx){return function(){state.selectedGuideRow=idx;showSelectedProgramme(rr);};})(r,i);
      button.onclick=(function(rr,channel){return function(){showSelectedProgramme(rr);
        if(rr[1]<Date.now() && canArchive(channel,rr)){playArchivedProgramme(channel,rr);}
        else if(rr[1]<Date.now())toast('Архив для этой передачи не заявлен или недоступен',4000);
      };})(r,ch);
      fragment.appendChild(button);
      if(r[1]<=now&&r[2]>now){closest=i;onAir=r;}
      else if(r[1]>now&&firstFuture<0)firstFuture=i;
    }
    el.guideRows.appendChild(fragment);
    renderGuideDates(rows);
    if(closest<0)closest=firstFuture>=0?firstFuture:0;
    var selected=el.guideRows.querySelector('[data-guide-index="'+closest+'"]');
    if(selected){
      var off=selected.offsetTop-el.guideRows.offsetTop;
      el.guideRows.scrollTop=Math.max(0,off-105);
    }
    showSelectedProgramme(rows[closest]);
    if(state.playbackGuideOpen && selected)selected.focus();
    el.guideRange.textContent=rows.length+' передач · '+dayLabel(rows[0][1])+' — '+dayLabel(rows[rows.length-1][1]);
  }
  function showSelectedProgramme(row){
    if(!row)return;
    var now=Date.now();
    el.guideSelectedTime.textContent=dayLabel(row[1])+' · '+timeLabel(row[1])+'–'+timeLabel(row[2])+
      (row[1]<=now&&row[2]>now?' · СЕЙЧАС':(row[2]<now?' · ПРОШЛО':' · ДАЛЕЕ'));
    el.guideSelectedTitle.textContent=row[0];
    el.guideSelectedDesc.textContent=row[3]||'\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u043d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e \u0438\u043b\u0438 \u043e\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442 \u0432 EPG.';
    syncGuideDate(row[1]);
    var ch=state.playbackGuideOpen?state.channels[state.current]:state.visible[state.selectedVisible];
    if(ch&&row[1]<now&&canArchive(ch,row))el.guideNavHint.textContent='↑ / ↓ — передачи · OK — смотреть из архива · BACK — закрыть';
    else if(state.playbackGuideOpen)el.guideNavHint.textContent='↑ / ↓ — передачи · ← — даты · BACK — закрыть';
  }
  // The date column is created from the currently cached guide (no network fetch).
  // It is focusable on remote controls via RIGHT from any programme row.
  function renderGuideDates(rows){
    el.guideDates.textContent='';
    if(!rows||!rows.length)return;
    var previous='',seen={},now=Date.now();
    for(var i=0;i<rows.length;i++){
      var d=new Date(rows[i][1]),key=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
      if(seen[key])continue;
      seen[key]=true;var button=create('button','guide-day',weekdays[d.getDay()]+'\n'+pad(d.getDate())+'.'+pad(d.getMonth()+1));
      button.setAttribute('data-day-key',key);button.setAttribute('data-first-row',i);button.setAttribute('data-focus','1');
      button.onclick=(function(idx){return function(){jumpGuideDate(idx,true);};})(i);
      el.guideDates.appendChild(button);
    }
  }
  function guideDayKey(timestamp){var d=new Date(timestamp);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
  function syncGuideDate(timestamp){
    if(!el.guideDates||!timestamp)return;
    var selected=guideDayKey(timestamp),buttons=el.guideDates.querySelectorAll('.guide-day');
    for(var i=0;i<buttons.length;i++)buttons[i].classList.toggle('active',buttons[i].getAttribute('data-day-key')===selected);
  }
  function jumpGuideDate(index,keepDateFocus){
    var programme=el.guideRows.querySelector('[data-guide-index="'+index+'"]');
    if(!programme)return;
    state.selectedGuideRow=index;el.guideRows.scrollTop=Math.max(0,programme.offsetTop-el.guideRows.offsetTop-12);
    var matching=el.guideDates.querySelector('[data-first-row="'+index+'"]');
    if(matching)matching.classList.add('active');
    var rows=guideRowsFromDOM(),r=rows[index];
    if(r)showSelectedProgramme(r);
    if(!keepDateFocus)programme.focus();
  }
  function guideRowsFromDOM(){
    var ch=state.playbackGuideOpen?state.channels[state.current]:state.visible[state.selectedVisible];
    return ch?(guideCache[ch.num-1]||[]):[];
  }
  // In the full-screen guide the date column is visually to the LEFT of
  // the programme rows. In the compact browser the original column remains
  // on the right; its remote mapping is kept for backwards compatibility.
  function focusGuideDateForSelectedProgramme(){
    var dates=el.guideDates.querySelectorAll('.guide-day');if(!dates.length)return;
    var programmes=guideRowsFromDOM(),selected=programmes[state.selectedGuideRow];
    var dayKey=selected?guideDayKey(selected[1]):'';
    var date=null;
    for(var i=0;i<dates.length;i++){
      if(dates[i].getAttribute('data-day-key')===dayKey){date=dates[i];break;}
    }
    if(!date)date=el.guideDates.querySelector('.guide-day.active')||dates[0];
    date.focus();
    el.guideNavHint.textContent='↑ / ↓ — даты · → — передачи · BACK — закрыть';
  }
  function focusGuideProgrammeFromDate(){
    var index=state.selectedGuideRow;
    var programme=el.guideRows.querySelector('[data-guide-index="'+index+'"]')||el.guideRows.querySelector('.guide-row');
    if(programme)programme.focus();
  }
  function guideDateNavigate(direction){
    var dates=el.guideDates.querySelectorAll('.guide-day');if(!dates.length)return;
    if(direction==='right'&&state.playbackGuideOpen){focusGuideProgrammeFromDate();return;}
    if(direction==='left'&&!state.playbackGuideOpen){focusGuideProgrammeFromDate();return;}
    // Date is the leftmost focusable column in full-screen playback EPG.
    if(direction==='left'&&state.playbackGuideOpen)return;
    if(direction==='right'&&!state.playbackGuideOpen)return;
    var active=document.activeElement,index=Array.prototype.indexOf.call(dates,active);
    if(index<0)index=0;
    if(direction==='up')index=Math.max(0,index-1);
    else if(direction==='down')index=Math.min(dates.length-1,index+1);
    dates[index].focus();jumpGuideDate(+dates[index].getAttribute('data-first-row'),true);
    if(state.playbackGuideOpen)el.guideNavHint.textContent='↑ / ↓ — даты · → — передачи · BACK — закрыть';
  }
  function guideNavigate(direction){
    var rows=el.guideRows.querySelectorAll('.guide-row');if(!rows.length)return;
    var active=document.activeElement,idx=active&&active.hasAttribute&&active.hasAttribute('data-guide-index')?+active.getAttribute('data-guide-index'):-1;
    if(idx<0){
      var nowRow=el.guideRows.querySelector('.guide-onair')||rows[0];
      idx=+nowRow.getAttribute('data-guide-index');
      rows[idx].focus();return;
    }
    if(direction==='up')idx=Math.max(0,idx-1);
    else if(direction==='down')idx=Math.min(rows.length-1,idx+1);
    else if(direction==='left'){if(!state.playbackGuideOpen)focusChannel(Math.min(state.selectedVisible,state.visible.length-1));return;}
    rows[idx].focus();
  }
  function resetPlayerOSD(){
    hide('playerInfo');hide('zapCarousel');el.playerInfo.classList.remove('zapping');clearTimeout(infoTimer);refreshTopline();
  }
  function renderZapCarousel(){
    // Render just the current channel and nearby neighbours, never the whole
    // M3U list. Keep the actual player source owned by playChannel().
    var list=el.zapCarouselItems;
    if(!list)return;
    list.textContent='';
    var count=state.channels.length,index=state.current;
    if(count<1||index<0)return;
    var slots=Math.min(count,window.innerWidth<1280?3:5);
    var start=index-Math.floor(slots/2);
    for(var offset=0;offset<slots;offset++){
      var idx=(start+offset%count+count*2)%count;
      var channel=state.channels[idx],active=idx===index;
      var card=create('div','zap-channel-card'+(active?' is-current':''));
      var media=create('span','zap-channel-logo');
      if(channel.logo){
        var logo=document.createElement('img');logo.src=channel.logo;logo.alt='';
        media.appendChild(logo);
      }else{media.textContent=String(channel.num);}
      var details=create('span','zap-channel-text');
      details.appendChild(create('span','zap-channel-title',channel.num+'. '+channel.name));
      var epg=state.epg[channel.key]&&state.epg[channel.key].current;
      details.appendChild(create('span','zap-channel-program',epg&&epg.name?epg.name:'Прямой эфир'));
      card.appendChild(media);card.appendChild(details);
      if(active)card.appendChild(create('span','zap-current-icon','▶'));
      list.appendChild(card);
    }
  }
  function showPlayerOSD(fromZap){
    if(state.current<0||state.sidebarOpen||state.playbackGuideOpen||state.settingsOpen)return;
    if(fromZap){renderZapCarousel();show('zapCarousel');el.playerInfo.classList.add('zapping');}
    else {hide('zapCarousel');el.playerInfo.classList.remove('zapping');}
    updatePlayerInfo();show('playerInfo');refreshTopline();
    pollNetworkSpeed();
    clearTimeout(infoTimer);
    infoTimer=setTimeout(function(){resetPlayerOSD();},fromZap?6500:9000);
  }
  // The TV hardware player fetches video itself. We cannot obtain the media
  // response byte count from HTMLVideoElement; system network interface deltas
  // from the Node service show REAL total TV traffic, not per-stream bitrate.
  function formatNetworkSpeed(bytesPerSecond){
    if(!isFinite(bytesPerSecond)||bytesPerSecond<0)return '—';
    return (bytesPerSecond*8/1000000).toFixed(2).replace('.',',')+' Мбит/с';
  }
  function pollNetworkSpeed(){
    if(netSpeedBusy||state.current<0||el.playerInfo.classList.contains('hidden'))return;
    if(typeof window.PalmServiceBridge!=='function'){
      el.playerNetRx.textContent='↓ Приём ТВ: н/д';
      el.playerNetTx.textContent='↑ Передача ТВ: н/д';
      return;
    }
    var bridge=new window.PalmServiceBridge();netSpeedBridge=bridge;netSpeedBusy=true;
    var finished=false;
    function done(payload){
      if(finished)return;
      finished=true;clearTimeout(netSpeedWatchdog);netSpeedBusy=false;netSpeedBridge=null;
      if(!payload||!payload.returnValue){
        el.playerNetRx.textContent='↓ Приём ТВ: н/д';
        el.playerNetTx.textContent='↑ Передача ТВ: н/д';
      }else if(!payload.available){
        el.playerNetRx.textContent='↓ Приём ТВ: измерение…';
        el.playerNetTx.textContent='↑ Передача ТВ: измерение…';
      }else{
        el.playerNetRx.textContent='↓ Приём ТВ: '+formatNetworkSpeed(Number(payload.rxBytesPerSec));
        el.playerNetTx.textContent='↑ Передача ТВ: '+formatNetworkSpeed(Number(payload.txBytesPerSec));
      }
    }
    netSpeedWatchdog=setTimeout(function(){done(null);},4500);
    bridge.onservicecallback=function(data){
      var response=null;
      try{response=JSON.parse(data);}catch(e){}
      done(response);
    };
    try{bridge.call('luna://'+SERVICE_ID+'/getNetworkSpeed','{}');}
    catch(e){done(null);}
  }
  function archiveLabel(ch){
    var count=parseFloat(String(ch.duration||'').replace(',','.'));
    if(isFinite(count)&&count>0)return 'Архив: '+count+' дн. (по M3U)';
    if((ch.catchup&&ch.catchup!=='0'&&ch.catchup!=='false')||ch.timeshift)return 'Архив: заявлен, срок неизвестен';
    return 'Архив: не заявлен';
  }
  function describeBitrate(ch){
    var b=Number(ch.streamBps||0);
    if(isFinite(b)&&b>0)return 'Битрейт: до '+(b/1000000).toFixed(2)+' Мбит/с (HLS, заявлен)';
    var source=Number(ch.bitrate||0);
    if(!isFinite(source)||source<=0)return 'Битрейт: нет данных';
    // M3U extension bitrate values can be given in Mbps, kbps, or bits/s.
    var mbps=source>1000000?source/1000000:(source>100?source/1000:source);
    return 'Битрейт: '+mbps.toFixed(2)+' Мбит/с (M3U, заявлен)';
  }
  function describeResolution(ch){
    var w=el.video.videoWidth||0,h=el.video.videoHeight||0;
    return 'Разрешение: '+(w&&h?w+'×'+h:(ch.streamResolution?'до '+ch.streamResolution+' (HLS)':(ch.resolution||'нет данных')));
  }
  function requestHlsInfo(ch){
    if(!ch||!/(?:\.m3u8)(?:[?#]|$)/i.test(ch.url)||typeof window.PalmServiceBridge!=='function')return;
    var serial=++streamInfoSerial,bridge=new window.PalmServiceBridge();
    bridge.onservicecallback=function(txt){
      if(serial!==streamInfoSerial)return;
      try{var r=JSON.parse(txt);if(!r.returnValue)return;
        if(r.bps)ch.streamBps=r.bps;
        if(r.resolution)ch.streamResolution=r.resolution;
        if(state.channels[state.current]===ch)updatePlayerInfo();
      }catch(e){}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/getHlsInfo',JSON.stringify({url:ch.url}));}catch(e){}
  }

  function groups(){
    var seen={},out=[];
    for(var i=0;i<state.channels.length;i++){
      var group=state.channels[i].group||'Без категории';
      if(!seen[group]){seen[group]=true;out.push(group);}
    }
    return out;
  }
  function filtered(){
    var result=[];for(var i=0;i<state.channels.length;i++){
      var ch=state.channels[i];
      if(state.playbackGroupList){
        var playing=state.channels[state.current];
        if(!playing || ch.group!==playing.group)continue;
        result.push(ch);continue;
      }
      if(state.mode==='fav'&&!state.favorites[ch.key])continue;
      if(state.mode==='groups'&&state.group&&ch.group!==state.group)continue;
      if(state.search){var q=state.search.toLowerCase();if((ch.name+' '+ch.group).toLowerCase().indexOf(q)<0)continue;}
      result.push(ch);
    }
    return result;
  }
  function create(tag,cls,txt){var node=document.createElement(tag);if(cls)node.className=cls;if(txt!==undefined)node.textContent=txt;return node;}
  function render(){
    var playingGroup=state.channels[state.current];
    el.playlistName.textContent=state.quickMode?(state.group||'Все каналы'):(state.playbackGroupList&&playingGroup?'Группа: '+playingGroup.group:(state.playlist.title||'M3U-плейлист'));
    el.sidebarHeadingText.textContent=state.playbackGroupList?'Каналы группы':'Телеканалы';
    el.modeAll.classList.toggle('active',state.mode==='all');
    el.modeFav.classList.toggle('active',state.mode==='fav');
    el.modeGroups.classList.toggle('active',state.mode==='groups');
    el.channelCount.textContent=state.channels.length;
    var gs=groups();el.groups.textContent='';
    if(state.mode==='groups'&&state.groupsExpanded&&!state.playbackGroupList){
      show('groups');
      var all=create('button','group-item'+(!state.group?' active':''),'Все группы');all.setAttribute('data-focus','1');
      all.onfocus=function(){state.lastGroupFocusIndex=0;};
      all.onclick=function(){state.group='';render();focusFirstChannel();};el.groups.appendChild(all);
      for(var g=0;g<gs.length;g++){
        (function(group,index){var btn=create('button','group-item'+(state.group===group?' active':''),group);btn.setAttribute('data-focus','1');
          btn.onfocus=function(){state.lastGroupFocusIndex=index;};
          btn.onclick=function(){state.group=group;render();focusFirstChannel();};el.groups.appendChild(btn);})(gs[g],g+1);
      }
    } else hide('groups');
    state.visible=filtered();state.selectedVisible=0;
    el.channelCount.textContent=state.playbackGroupList?state.visible.length:state.channels.length;
    el.channels.textContent='';el.channels.scrollTop=0;
    state.windowStart=-1;state.windowEnd=-1;
    if(!state.visible.length){el.channels.appendChild(create('div','empty-list',state.channels.length?'Нет каналов с такими условиями':'Добавь плейлист в настройках'));return;}
    state.topSpacer=create('div','list-spacer');
    state.rowsLayer=create('div','list-rows');
    state.bottomSpacer=create('div','list-spacer');
    el.channels.appendChild(state.topSpacer);
    el.channels.appendChild(state.rowsLayer);
    el.channels.appendChild(state.bottomSpacer);
    renderWindow(true);
  }
  function channelProgram(ch){
    var e=state.epg[ch.key],program=e&&(e.current||e.next);
    return program?(program.start>Date.now()?'Далее: ':'Сейчас: ')+program.name:ch.group;
  }
  function createChannelRow(ch,idx){
    // Separate sibling buttons: the star must be reachable with a real D-pad.
    var row=create('div','channel-row');
    var item=create('button','channel-item'+(state.current>=0&&state.channels[state.current]===ch?' playing':''));
    item.setAttribute('data-focus','1');item.setAttribute('data-channel',ch.num);
    item.setAttribute('data-visible-index',idx);
    item.appendChild(create('div','channel-number',String(ch.num)));
    var image;
    if(ch.logo){
      image=document.createElement('img');image.className='channel-logo';image.setAttribute('alt','');image.src=ch.logo;
      image.onerror=function(){this.style.display='none';};
    }else image=create('div','channel-logo logo-fallback',ch.name.substring(0,2).toUpperCase());
    item.appendChild(image);
    var meta=create('div','channel-info');meta.appendChild(create('div','channel-name',ch.name));
    meta.appendChild(create('div','channel-program',channelProgram(ch)));
    var currentSummary=state.epg[ch.key]&&state.epg[ch.key].current;
    var progress=create('div','channel-meter');var fill=create('span','channel-meter-fill');
    if(currentSummary&&currentSummary.end>currentSummary.start){
      fill.style.width=Math.max(0,Math.min(100,(Date.now()-currentSummary.start)/(currentSummary.end-currentSummary.start)*100))+'%';
    }
    progress.appendChild(fill);meta.appendChild(progress);item.appendChild(meta);
    var signals=create('span','channel-signals');
    if(state.current===ch.num-1)signals.appendChild(create('span','channel-playing-icon','▶'));
    if(ch.catchupSource||ch.catchup&&ch.catchup!=='0'&&ch.catchup!=='false'||archiveDays(ch)){
      var archiveIcon=create('span','channel-archive-icon');
      archiveIcon.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10a9 9 0 1 1 2.4 8M3.5 4v6h6"/><path d="M12 6.5v5.5l3.5 2"/></svg>';
      signals.appendChild(archiveIcon);
    }
    item.appendChild(signals);
    var star=create('button','favorite-toggle'+(state.favorites[ch.key]?' on':''),state.favorites[ch.key]?'\u2605':'\u2606');
    star.type='button';star.setAttribute('data-focus','1');
    star.setAttribute('data-favorite-index',idx);star.setAttribute('data-favorite-channel',ch.num);
    star.setAttribute('aria-pressed',state.favorites[ch.key]?'true':'false');
    star.setAttribute('title','\u0418\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435');
    star.setAttribute('aria-label',star.getAttribute('title')+': '+ch.name);
    star.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();toggleFavorite(ch.num-1);};
    star.onfocus=function(){state.selectedVisible=idx;};
    item.onclick=function(){playChannel(ch.num-1);};
    item.oncontextmenu=function(ev){ev.preventDefault();toggleFavorite(ch.num-1);};
    item.onfocus=function(){state.selectedVisible=idx;if(!state.playbackGroupList)selectChannelGuide(ch);};
    row.appendChild(item);row.appendChild(star);
    return row;
  }
  // Animate only genuinely overflowing programme titles. Each visible virtual
  // row has two identical copies; scrolling half the track is a seamless loop.
  // Uses compositor transforms instead of JavaScript timers on old webOS.
  function applyVisibleMarquees(){
    if(!state.quickMode||!state.rowsLayer||!state.sidebarOpen)return;
    var lines=state.rowsLayer.querySelectorAll('.channel-program');
    for(var i=0;i<lines.length;i++){
      var line=lines[i],original=line.getAttribute('data-epg-text')||line.textContent;
      if(!line.getAttribute('data-epg-text'))line.setAttribute('data-epg-text',original);
      line.classList.remove('ptv-marquee');
      line.textContent=original;
      if(line.clientWidth<30||line.scrollWidth<=line.clientWidth+3)continue;
      var track=create('span','ptv-marquee-track');
      track.appendChild(create('span','ptv-marquee-copy',original));
      track.appendChild(create('span','ptv-marquee-copy',original));
      line.textContent='';line.appendChild(track);line.classList.add('ptv-marquee');
    }
  }
  function scheduleVisibleMarquees(){
    if(!state.quickMode)return;
    if(typeof window.requestAnimationFrame==='function')window.requestAnimationFrame(applyVisibleMarquees);
    else setTimeout(applyVisibleMarquees,30);
  }
  function renderWindow(force){
    if(!state.rowsLayer)return;
    var len=state.visible.length;
    var height=el.channels.clientHeight||600;
    var start=Math.max(0,Math.floor(el.channels.scrollTop/ROW_HEIGHT)-OVERSCAN);
    var count=Math.ceil(height/ROW_HEIGHT)+OVERSCAN*2;
    var end=Math.min(len,start+count);
    if(!force && start===state.windowStart && end===state.windowEnd)return;
    var active=document.activeElement,focusIndex=active&&active.getAttribute?active.getAttribute('data-visible-index'):null;
    var favoriteFocus=active&&active.getAttribute?active.getAttribute('data-favorite-index'):null;
    state.windowStart=start;state.windowEnd=end;
    state.topSpacer.style.height=(start*ROW_HEIGHT)+'px';
    state.bottomSpacer.style.height=((len-end)*ROW_HEIGHT)+'px';
    var frag=document.createDocumentFragment();
    for(var i=start;i<end;i++)frag.appendChild(createChannelRow(state.visible[i],i));
    state.rowsLayer.textContent='';state.rowsLayer.appendChild(frag);
    if(favoriteFocus!==null && favoriteFocus!=='' && +favoriteFocus>=start && +favoriteFocus<end){
      var favorite=state.rowsLayer.querySelector('[data-favorite-index="'+favoriteFocus+'"]');
      if(favorite)favorite.focus();
    } else if(focusIndex!==null && focusIndex!=='' && +focusIndex>=start && +focusIndex<end){
      var node=state.rowsLayer.querySelector('[data-visible-index="'+focusIndex+'"]');
      if(node)node.focus();
    }
    scheduleVisibleMarquees();
  }
  function focusChannel(index){
    if(index<0||index>=state.visible.length)return;
    state.selectedVisible=index;
    var height=el.channels.clientHeight||600;
    // Keep the cursor at the second-to-last *visible* row when browsing down;
    // the underlying list scrolls instead of jumping the focus into the footer.
    var capacity=Math.max(3,Math.floor(height/ROW_HEIGHT));
    var targetSlot=capacity-2;
    var targetTop=Math.max(0,(index-targetSlot)*ROW_HEIGHT);
    var maximum=Math.max(0,state.visible.length*ROW_HEIGHT-height);
    el.channels.scrollTop=Math.max(0,Math.min(maximum,targetTop));
    renderWindow(false);
    var found=state.rowsLayer&&state.rowsLayer.querySelector('[data-visible-index="'+index+'"]');
    if(!found){renderWindow(true);found=state.rowsLayer.querySelector('[data-visible-index="'+index+'"]');}
    if(found){found.focus();el.channels.scrollTop=Math.max(0,Math.min(maximum,targetTop));}
  }
  function focusFavorite(index){
    if(index<0||index>=state.visible.length)return;
    focusChannel(index);
    var star=state.rowsLayer&&state.rowsLayer.querySelector('[data-favorite-index="'+index+'"]');
    if(star)star.focus();
  }
  function updateVisibleEpg(){
    if(!state.rowsLayer)return;
    var nodes=state.rowsLayer.querySelectorAll('[data-visible-index]');
    for(var i=0;i<nodes.length;i++){
      var index=+nodes[i].getAttribute('data-visible-index');
      var label=nodes[i].querySelector('.channel-program');
      if(label&&state.visible[index]){
        var channel=state.visible[index];var text=channelProgram(channel);
        label.textContent=text;label.setAttribute('data-epg-text',text);
        var epg=state.epg[channel.key]&&state.epg[channel.key].current;
        var bar=nodes[i].querySelector('.channel-meter-fill');
        if(bar)bar.style.width=epg&&epg.end>epg.start?Math.max(0,Math.min(100,(Date.now()-epg.start)/(epg.end-epg.start)*100))+'%':'0%';
      }
    }
    scheduleVisibleMarquees();
  }
  function toggleFavorite(index){
    if(index<0||!state.channels[index])return;
    var key=state.channels[index].key,visibleIndex=state.selectedVisible;
    if(state.favorites[key])delete state.favorites[key];else state.favorites[key]=true;
    save();
    if(state.mode==='fav'&&!state.playbackGroupList){
      render();
      if(state.visible.length)focusChannel(Math.min(visibleIndex,state.visible.length-1));
      else el.modeFav.focus();
    } else if(state.rowsLayer){
      var star=state.rowsLayer.querySelector('.favorite-toggle[data-favorite-channel="'+(index+1)+'"]');
      if(star){
        star.classList.toggle('on',!!state.favorites[key]);
        star.textContent=state.favorites[key]?'\u2605':'\u2606';
        star.setAttribute('aria-pressed',state.favorites[key]?'true':'false');
      }
    }
    toast(state.favorites[key]?'\u0414\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e \u0432 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0435':'\u0423\u0434\u0430\u043b\u0435\u043d\u043e \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043d\u043d\u043e\u0433\u043e');
  }
  function markPlaying(index){
    var old=state.current;
    if(old>=0&&old!==index&&state.channels[old]){
      var previousKey=state.channels[old].key,currentKey=state.channels[index].key;
      state.history=[previousKey].concat(state.history.filter(function(k){return k!==previousKey&&k!==currentKey;})).slice(0,20);
    }
    state.current=index;save();
    if(state.rowsLayer){
      var prev=state.rowsLayer.querySelector('[data-channel="'+(old+1)+'"]');
      var next=state.rowsLayer.querySelector('[data-channel="'+(index+1)+'"]');
      if(prev)prev.classList.remove('playing');
      if(next)next.classList.add('playing');
    }
  }
  function playChannel(index){
    var channel=state.channels[index];if(!channel)return;
    if(!/^https?:\/\//i.test(channel.url)){
      toast('Протокол канала '+channel.url.split(':')[0]+' не поддерживается веб-плеером webOS.',5500);return;
    }
    closeArchiveLiveInfo();closePlaybackGuide();closeRecent();closeTvGrid();closeQuickBrowser();state.archive=null;hideArchiveSeek();markPlaying(index);show('video');hide('idle');hideSidebar();
    streamInfoSerial++;requestHlsInfo(channel);startVideo(channel.url,channel);
    updatePlayerInfo();resetPlayerOSD();
  }
  function startVideo(url,channel,autoPlay){
    if(autoPlay===undefined)autoPlay=true;
    var video=el.video;video.pause();video.removeAttribute('src');
    while(video.firstChild)video.removeChild(video.firstChild);
    // webOS 4.x: reset the native playback pipeline before switching source.
    // Reopening the archive at a fresh UTC position avoids native seek decoder stalls.
    video.load();video.autoplay=autoPlay;
    var src=document.createElement('source');src.src=url;
    if(/\.m3u8(?:[?#]|$)/i.test(url))src.type='application/vnd.apple.mpegurl';
    else if(/\.mpd(?:[?#]|$)/i.test(url))src.type='application/dash+xml';
    else if(/\.mp4(?:[?#]|$)/i.test(url))src.type='video/mp4';
    else if(/\.ts(?:[?#]|$)/i.test(url))src.type='video/mp2t';
    video.appendChild(src);video.load();
    var result;
    if(autoPlay){
      try{result=video.play();}catch(e){toast('Ошибка старта: '+e.message);}
      if(result&&typeof result.catch==='function')result.catch(function(e){toast('Не удалось воспроизвести: '+(e.message||'неизвестная ошибка'),5500);});
    }
    if(channel&& (channel.ua||channel.referrer))toast('Поток требует особых заголовков; воспроизведение может не работать.',5200);
  }
  function updatePlayerInfo(){
    var ch=state.channels[state.current];if(!ch)return;
    el.playerName.textContent=ch.num+'. '+ch.name;
    el.playerLogo.src=ch.logo||'';
    el.playerLogo.style.display=ch.logo?'block':'none';
    el.playerGroup.textContent=ch.group;
    el.playerMode.textContent=state.archive?'АРХИВ':'ПРЯМОЙ ЭФИР';
    el.playerMode.classList.toggle('archive-tag',!!state.archive);
    var rows=guideCache[ch.num-1],parsed=rows?findPrograms(rows):null;
    var info=state.epg[ch.key]||{};
    var current=parsed&&parsed.current?unpackProgram(parsed.current):info.current;
    var next=parsed&&parsed.next?unpackProgram(parsed.next):info.next;
    if(state.archive){current={start:state.archive.start,end:state.archive.end,name:state.archive.name,desc:state.archive.desc};next=null;}
    el.playerEpg.textContent=current?(timeLabel(current.start)+'–'+timeLabel(current.end)+' · '+current.name):'Нет данных EPG';
    el.playerNext.textContent=next?(timeLabel(next.start)+' · '+next.name):'Нет данных EPG';
    // Keep the zap panel at one size: a short two-line excerpt is enough
    // while switching. Down opens the usual info panel with the full text.
    var fullDescription=current&&current.desc?current.desc:'Описание текущей передачи в XMLTV отсутствует.';
    if(el.playerInfo.classList.contains('zapping')&&fullDescription.length>176){
      var excerpt=fullDescription.slice(0,176);
      excerpt=excerpt.replace(/\s+\S*$/,'');
      fullDescription=excerpt+'…';
    }
    el.playerDescription.textContent=fullDescription;
    updateLiveTimeline(current);
    el.playerResolution.textContent=describeResolution(ch);
    el.playerBitrate.textContent=describeBitrate(ch);
    el.playerArchive.textContent=archiveLabel(ch);
  }
  function archiveDays(ch){
    if(!ch)return 0;
    var d=parseFloat(String(ch.duration||ch.timeshift||'0').replace(',','.'));
    return isFinite(d)&&d>0?d:0;
  }
  function canArchive(ch,row){
    if(!ch||!row||row[1]>=Date.now())return false;
    var mode=String(ch.catchup||'').toLowerCase();
    if(!mode&&!ch.catchupSource&&!archiveDays(ch))return false;
    var days=archiveDays(ch);
    if(days&&Date.now()-row[1]>days*86400000)return false;
    return !!(ch.catchupSource || days || mode==='shift'||mode.indexOf('flussonic')===0||mode==='xc'||mode==='append');
  }
  function archiveLink(ch,row){
    var start=Math.floor(row[1]/1000),now=Math.floor(Date.now()/1000);
    var duration=Math.max(60,Math.ceil((Math.min(row[2],Date.now())-row[1])/1000));
    var correction=parseFloat(String(ch.catchupCorrection||'0'))||0;
    start+=Math.round(correction*3600);
    var dt=new Date(start*1000);
    function fmt(n){return ('0'+n).slice(-2);}
    var data={utc:start,start:start,timestamp:start,end:start+duration,lutc:now,now:now,duration:duration,offset:start-now,
      Y:dt.getUTCFullYear(),m:fmt(dt.getUTCMonth()+1),d:fmt(dt.getUTCDate()),H:fmt(dt.getUTCHours()),M:fmt(dt.getUTCMinutes()),S:fmt(dt.getUTCSeconds())};
    function subst(url){return String(url).replace(/\$?\{([a-zA-Z]+)\}/g,function(all,key){return data[key]===undefined?all:String(data[key]);});}
    var source=String(ch.catchupSource||''),mode=String(ch.catchup||'').toLowerCase();
    var url=ch.url;
    if(source){
      if(mode==='append')url=url+source;
      else if(/^https?:\/\//i.test(source))url=source;
      else if(source.charAt(0)==='?'||source.charAt(0)==='&')url=url+source;
      else url=baseResolve(source,url);
      return subst(url);
    }
    if(mode==='shift'||mode==='timeshift'||mode==='default'||!mode){
      return url+(url.indexOf('?')>=0?'&':'?')+'utc='+start+'&lutc='+now;
    }
    if(mode==='flussonic'||mode==='flussonic-hls'||mode==='flussonic-ts'||mode==='fs'){
      var extension=(mode==='flussonic-ts'||mode==='fs')?'.ts':'.m3u8';
      var parts=/^([^?#]+)([?#].*)?$/.exec(url),path=parts&&parts[1]||url,suffix=parts&&parts[2]||'';
      var slash=path.lastIndexOf('/');if(slash<0)return '';
      if(/\/(?:index|video)\.m3u8$/i.test(path))return path.slice(0,slash)+'/archive-'+start+'-'+duration+extension+suffix;
      return path.slice(0,slash)+'/timeshift_abs-'+start+extension+suffix;
    }
    if(mode==='xc'||mode==='xtream'||mode==='xstream'){
      var m=/^(https?:\/\/[^/]+)\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.[^/?#]+)?(?:\?.*)?$/i.exec(url);
      if(!m)return '';
      return m[1]+'/timeshift/'+m[2]+'/'+m[3]+'/'+Math.ceil(duration/60)+'/'+
        data.Y+'-'+data.m+'-'+data.d+':'+data.H+'-'+data.M+'/'+m[4]+'.ts';
    }
    return '';
  }
  function playArchivedProgramme(ch,row){
    if(!canArchive(ch,row)){toast('Архив отсутствует или передача старше срока хранения',5000);return;}
    var url=archiveLink(ch,row);
    if(!/^https?:\/\//i.test(url)){toast('Формат архива этого провайдера пока не поддерживается',5500);return;}
    var index=ch.num-1;
    closeArchiveLiveInfo();closePlaybackGuide();closeRecent();closeTvGrid();closeQuickGroups();hideSidebar();hideArchiveSeek();
    markPlaying(index);
    state.archive={start:row[1],end:row[2],name:row[0],desc:row[3]||'',url:url,streamBase:0,mediaOrigin:0,seekCount:0};
    show('video');hide('idle');
    startVideo(url,ch);updatePlayerInfo();resetPlayerOSD();
    toast('Запускаю архив: '+row[0],3300);
  }
  // The archive timeline is always based on the selected EPG programme. Native
  // HTMLMediaElement.duration is often Infinity for provider catch-up HLS streams.
  function archiveLength(){
    if(!state.archive)return 0;
    return Math.max(0,Math.floor((Math.min(state.archive.end,Date.now())-state.archive.start)/1000));
  }
  function archiveClamp(seconds){return Math.max(0,Math.min(Math.max(0,archiveLength()-3),seconds));}
  function archivePlaybackPosition(){
    var archive=state.archive;if(!archive)return 0;
    var t=Number(el.video.currentTime);
    if(!isFinite(t)||t<0)t=0;
    return archiveClamp((archive.streamBase||0)+Math.max(0,t-(archive.mediaOrigin||0)));
  }
  function archiveTimeText(seconds){
    var t=Math.floor(Math.max(0,seconds)),hours=Math.floor(t/3600),minutes=Math.floor(t/60)%60;
    return (hours?pad(hours)+':':'')+pad(minutes)+':'+pad(t%60);
  }
  function shortDurationText(seconds){
    var t=Math.max(0,Math.floor(seconds||0)),hours=Math.floor(t/3600),minutes=Math.floor(t/60)%60;
    return pad(hours)+':'+pad(minutes);
  }
  function remainingDurationText(seconds){
    var t=Math.max(0,Math.ceil(seconds||0)),hours=Math.floor(t/3600),minutes=Math.ceil((t%3600)/60);
    if(minutes===60){hours++;minutes=0;}
    if(hours>0&&minutes>0)return 'ещё '+hours+' ч '+minutes+' мин';
    if(hours>0)return 'ещё '+hours+' ч';
    return 'ещё '+minutes+' мин';
  }
  function updateLiveTimeline(current){
    if(!current||state.archive||!current.start||!current.end||current.end<=current.start){hide('playerTimeline');return;}
    var now=Date.now(),total=Math.max(1,Math.floor((current.end-current.start)/1000));
    var elapsed=Math.max(0,Math.min(total,Math.floor((now-current.start)/1000)));
    var remaining=Math.max(0,total-elapsed);
    el.playerTimelineElapsed.textContent=shortDurationText(elapsed);
    el.playerTimelineTotal.textContent=shortDurationText(total);
    el.playerTimelineRemaining.textContent=remainingDurationText(remaining);
    el.playerTimelineFill.style.width=Math.max(0,Math.min(100,elapsed/total*100))+'%';
    show('playerTimeline');
  }
  function archiveSelectedTime(){
    if(!state.archive)return '';
    return dayLabel(state.archive.start+state.archiveSeekTarget*1000)+' · '+timeLabel(state.archive.start+state.archiveSeekTarget*1000);
  }
  function resetArchiveHideTimer(){
    clearTimeout(seekTimer);
    // The seek panel is interactive: close only after a longer idle period.
    seekTimer=setTimeout(function(){if(!state.archiveSeekPending)hideArchiveSeek();},22000);
  }
  function hideArchiveSeek(){
    state.archiveSeekOpen=false;state.archiveSeekPending=false;
    clearTimeout(seekTimer);clearTimeout(seekCommitTimer);
    if(el.archiveSeek)hide('archiveSeek');
    if(document.activeElement&&el.archiveSeek&&el.archiveSeek.contains(document.activeElement))document.activeElement.blur();
    refreshTopline();
  }
  function updateArchivePlayButton(){
    if(!state.archive||!el.archivePlayLabel)return;
    var paused=el.video.paused;
    el.archivePlayLabel.textContent=paused?'Воспроизвести':'Пауза';
    el.archivePlaySymbol.textContent=paused?'▶':'Ⅱ';
  }
  function updateArchiveSeek(){
    if(!state.archive||!state.archiveSeekOpen)return;
    var duration=archiveLength();
    if(!state.archiveSeekPending)state.archiveSeekTarget=archivePlaybackPosition();
    var position=archiveClamp(state.archiveSeekTarget);
    var pct=duration?Math.min(100,position/duration*100):0;
    el.archiveSeekBar.style.width=pct+'%';el.archiveSeekMarker.style.left=pct+'%';
    el.archiveSeekElapsed.textContent=archiveTimeText(position);
    el.archiveSeekTotal.textContent=archiveTimeText(duration);
    el.archiveSeekClock.textContent=archiveSelectedTime();
    el.archiveSeekPosition.textContent=timeLabel(state.archive.start+position*1000);
    el.archiveSeekStatus.textContent=state.archiveSeekPending?
      'Выбрано '+archiveSelectedTime()+' · переход через 1 секунду после последнего нажатия':
      '← / → — передвинуть ползунок; переход выполняется одним запросом';
    el.archiveSeekTrack.setAttribute('aria-valuenow',String(Math.floor(position)));
    el.archiveSeekTrack.setAttribute('aria-valuemax',String(duration));
    updateArchivePlayButton();
  }
  function openArchiveSeek(){
    if(!state.archive)return;
    resetPlayerOSD();state.archiveSeekOpen=true;state.archiveSeekPending=false;
    clearTimeout(seekCommitTimer);
    state.archiveSeekTarget=archivePlaybackPosition();
    var channel=state.channels[state.current];
    el.archiveSeekTitle.textContent=state.archive.name;
    el.archiveSeekChannel.textContent=channel?channel.name:'Канал';
    el.archiveSeekLogo.src=channel&&channel.logo?channel.logo:'';
    el.archiveSeekLogo.style.display=channel&&channel.logo?'block':'none';
    el.archiveSeekDescription.textContent=state.archive.desc||'Описание передачи отсутствует в программе.';
    el.archiveSeekProgrammeTime.textContent=dayLabel(state.archive.start)+' · '+timeLabel(state.archive.start)+'–'+timeLabel(state.archive.end);
    show('archiveSeek');updateArchiveSeek();el.archiveSeekTrack.focus();resetArchiveHideTimer();refreshTopline();
  }
  function moveArchiveSlider(direction){
    if(!state.archive)return;
    var duration=archiveLength();
    if(duration<4){toast('Длительность записи пока неизвестна');return;}
    if(!state.archiveSeekPending)state.archiveSeekTarget=archivePlaybackPosition();
    // About one percent per press (15-120 s), scalable to long programmes.
    var step=Math.max(15,Math.min(120,Math.round(duration/120/5)*5));
    state.archiveSeekTarget=archiveClamp(state.archiveSeekTarget+direction*step);
    state.archiveSeekPending=true;
    clearTimeout(seekCommitTimer);
    seekCommitTimer=setTimeout(commitArchiveSeek,1000);
    updateArchiveSeek();resetArchiveHideTimer();
  }
  function commitArchiveSeek(){
    clearTimeout(seekCommitTimer);seekCommitTimer=0;
    if(!state.archive||!state.archiveSeekPending)return;
    var target=archiveClamp(state.archiveSeekTarget),archive=state.archive;
    state.archiveSeekPending=false;
    if(Math.abs(target-archivePlaybackPosition())<3){updateArchiveSeek();return;}
    var channel=state.channels[state.current];if(!channel)return;
    // For catch-up IPTV, use the EPG timestamp to request a NEW archive stream
    // directly at the selected time instead of setting video.currentTime.
    var tail=Math.min(archive.end,Date.now());
    var selectedRow=[archive.name,archive.start+target*1000,tail,archive.desc];
    var nextUrl=archiveLink(channel,selectedRow);
    if(!nextUrl||nextUrl===archive.url){
      toast('Этот формат архива не позволяет открыть выбранное время отдельной ссылкой',5100);
      updateArchiveSeek();return;
    }
    var resumePaused=el.video.paused;
    archive.streamBase=target;archive.mediaOrigin=0;archive.url=nextUrl;archive.seekCount++;
    archive.lastRequested=target;
    startVideo(nextUrl,channel,!resumePaused);
    el.archiveSeekStatus.textContent='Перехожу к '+archiveSelectedTime()+' · обновляю поток';
    resetArchiveHideTimer();
  }
  function toggleArchivePlayback(){
    if(!state.archive)return;
    if(el.video.paused){
      try{var ret=el.video.play();if(ret&&typeof ret.catch==='function')ret.catch(function(){toast('Не удалось возобновить архив',4200);});}
      catch(e){toast('Не удалось запустить архив');}
    }else{el.video.pause();}
    updateArchivePlayButton();resetArchiveHideTimer();
  }
  function archivePanelNavigation(code){
    if(code===37||code===39){
      if(document.activeElement===el.archiveSeekTrack)moveArchiveSlider(code===37?-1:1);
      else {
        var actions=[el.archivePlayPause,el.archiveLiveDetails,el.archiveLiveButton];
        var pos=actions.indexOf(document.activeElement);
        actions[Math.min(actions.length-1,Math.max(0,(pos<0?0:pos)+(code===37?-1:1)))].focus();
      }
    }else if(code===38){el.archiveSeekTrack.focus();}
    else if(code===40){el.archivePlayPause.focus();}
    else if(code===13){
      if(document.activeElement===el.archiveLiveButton)backToLive();
      else if(document.activeElement===el.archiveLiveDetails)openArchiveLiveInfo();
      else if(document.activeElement===el.archivePlayPause)toggleArchivePlayback();
      else if(state.archiveSeekPending)commitArchiveSeek();
    }
    if(state.archiveSeekOpen)resetArchiveHideTimer();
  }
  function backToLive(){
    if(state.current>=0)playChannel(state.current);
  }

  function zap(direction){
    if(!state.channels.length){showSidebar();return;}
    var idx=state.current;
    if(idx<0)idx=direction<0?state.channels.length-1:0;
    else idx=(idx+direction+state.channels.length)%state.channels.length;
    playChannel(idx);
    // Each zap immediately reveals the channel's current EPG information.
    // Subsequent left/right presses update the centred card and restart the
    // hide timer, without creating another player or downloading EPG.
    showPlayerOSD(true);
  }
  // Playback hotkeys: left/right zap, up guide, down info/recent/archive, OK opens group browser.
  function closePlaybackGuide(){
    if(!state.playbackGuideOpen)return;
    state.playbackGuideOpen=false;
    hide('guidePanel');el.guidePanel.classList.remove('playback-guide');
    clearTimeout(guideRequestTimer);guideRequestSerial++;
    if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
    refreshTopline();
  }
  function openPlaybackGuide(){
    var ch=state.channels[state.current];if(!ch)return;
    if(state.playbackGuideOpen)return;
    hideSidebar();resetPlayerOSD();
    state.playbackGuideOpen=true;
    el.guidePanel.classList.add('playback-guide');
    el.guideNavHint.textContent='↑ / ↓ — передачи · ← — даты · BACK — закрыть';
    selectChannelGuide(ch);refreshTopline();
  }
  function openPlaybackGroupList(){
    var ch=state.channels[state.current];if(!ch){showSidebar();return;}
    closePlaybackGuide();resetPlayerOSD();hideArchiveSeek();
    state.playbackGroupList=false;
    el.sidebar.classList.remove('playback-group');
    state.mode='groups';state.group=ch.group;state.groupsExpanded=false;
    state.sidebarFromPlayback=true;hide('guidePanel');
    render();showSidebar();
  }
  function showSidebar(){
    if(state.settingsOpen)return;
    closePlaybackGuide();
    el.sidebar.classList.add('open');state.sidebarOpen=true;resetPlayerOSD();refreshTopline();
    el.sidebar.classList.toggle('playing-overlay',state.current>=0);
    var channel=state.channels[state.current];
    var index=channel?state.visible.indexOf(channel):-1;
    setTimeout(function(){if(!state.sidebarOpen)return;if(index>=0)focusChannel(index);else focusFirstChannel();},65);
  }
  function focusFirstChannel(){
    if(state.visible.length)focusChannel(0);else el.settingsButton.focus();
  }
  function hideSidebar(){
    el.sidebar.classList.remove('open');el.sidebar.classList.remove('playing-overlay');
    state.sidebarOpen=false;state.sidebarFromPlayback=false;
    refreshTopline();
    if(!state.playbackGuideOpen){hide('guidePanel');clearTimeout(guideRequestTimer);guideRequestSerial++;}
    if(state.playbackGroupList){
      state.playbackGroupList=false;el.sidebar.classList.remove('playback-group');render();
    }
  }
  function showSettingsSection(name){
    state.settingsSection=name==='fonts'?'fonts':'playlists';
    var fonts=state.settingsSection==='fonts';
    el.settingsTabFonts.classList.toggle('selected',fonts);
    el.settingsTabPlaylists.classList.toggle('selected',!fonts);
    el.settingsModal.classList.toggle('fonts-preview',fonts);
    if(fonts){hide('settingsPlaylistSection');show('settingsFontSection');stopRemoteSettings();
      buildFontScene(FONT_OPTIONS.filter(function(opt){return opt.key===focusedFontKey;})[0]||FONT_OPTIONS[0]);}
    else {show('settingsPlaylistSection');hide('settingsFontSection');hide('fontScene');if(state.settingsOpen)startRemoteSettings();}
    if(el.settingsModal)el.settingsModal.querySelector('.modal-panel').scrollTop=0;
  }
  function renderProfileList(){
    var list=el.playlistProfiles;list.textContent='';
    for(var i=0;i<state.playlists.length;i++){
      (function(profile){
        var active=profile.id===state.activePlaylistId;
        var button=create('button','profile-item'+(active?' current':''));
        button.type='button';button.setAttribute('data-focus','1');button.setAttribute('data-profile',profile.id);
        var title=create('span','profile-name',(active?'▶ ':'')+(profile.title||'Без названия'));
        var status=create('span','profile-info',(active?'Сейчас используется · ':'')+(profile.source==='file'?'Импортирован из файла':(profile.url?'Ссылка M3U':'Не настроен')));
        button.appendChild(title);button.appendChild(status);
        button.onclick=function(){activateProfile(profile.id);};
        list.appendChild(button);
      })(state.playlists[i]);
    }
  }
  function populateProfileFields(profile){
    el.playlistUrl.value=profile&&profile.source!=='file'?profile.url:'';
    if(el.playlistFileNote)el.playlistFileNote.textContent=profile&&profile.source==='file'?'M3U импортирован из файла. Для замены файла открой веб-редактор по QR. Здесь можно изменить название и EPG.':'Можно добавить M3U по URL или загрузить файл с компьютера/телефона через веб-редактор.';
    el.playlistTitle.value=profile&&profile.title||'';
    el.epgUrl.value=profile&&profile.epg||'';
  }
  function beginAddPlaylist(){
    if(state.playlists.length>=12){toast('Максимум 12 плейлистов, чтобы не перегрузить телевизор',5000);return;}
    state.editingPlaylistId='__new__';state.deleteConfirmId='';
    populateProfileFields(null);
    el.playlistProfileNote.textContent='Новый плейлист: введи URL или открой веб-редактор по QR, чтобы импортировать файл M3U.';
    el.playlistUrl.focus();
  }
  function removePlaylist(){
    var id=state.activePlaylistId;
    if(!id||state.playlists.length<2){toast('Последний плейлист удалить нельзя',4000);return;}
    if(state.deleteConfirmId!==id){state.deleteConfirmId=id;el.playlistProfileNote.textContent='Подтверждение: нажми «Удалить выбранный» ещё раз. Настройки остальных плейлистов сохранятся.';return;}
    state.deleteConfirmId='';
    state.playlists=state.playlists.filter(function(p){return p.id!==id;});
    var next=state.playlists[0];state.activePlaylistId=next.id;
    activateProfile(next.id,true);
    toast('Профиль удалён. Сетевой кэш других плейлистов не затронут.');
  }
  function activateProfile(id,force,preserveSettings){
    var p=profileById(id);if(!p)return;
    if(!force&&state.activePlaylistId===id){
      state.editingPlaylistId=id;populateProfileFields(p);
      el.playlistProfileNote.textContent='Активный плейлист: измени поля и нажми «Сохранить и загрузить».';
      return;
    }
    if(state.epgLoading){toast('Дождись завершения обновления EPG перед сменой плейлиста',6000);return;}
    // Save last watched channel of old profile before changing selection.
    if(!force)save();
    state.activePlaylistId=id;state.editingPlaylistId=id;state.deleteConfirmId='';
    state.playlist={url:p.url,epg:p.epg,title:p.title,source:p.source||'url'};
    state.resumeKey=p.lastKey||'';state.resumeUrl=p.url;state.resumeIndex=-1;
    ++epgRestoreSerial;clearTimeout(epgRefreshTimer);
    state.epg={};epgLastChecked=0;epgNowBusy=false;guideCache={};guideCacheOrder=[];gridGuideCache={};gridGuideOrder=[];
    state.current=-1;state.archive=null;
    try{el.video.pause();el.video.removeAttribute('src');while(el.video.firstChild)el.video.removeChild(el.video.firstChild);el.video.load();}catch(err){}
    hide('video');show('idle');hideArchiveSeek();
    closeQuickBrowser();closeRecent();closeTvGrid();closePlaybackGuide();
    populateProfileFields(p);renderProfileList();save();syncRemoteSettings();loadPlaylist(true,false,!!preserveSettings);
  }
  // An inline preview follows the focused typography control. Keeping it
  // inside the row makes it visible while scrolling with the TV D-pad.
  var focusedFontKey='channel';
  var FONT_SAMPLES={
    channel:'316. Yosso TV BEST',
    program:'Сейчас: Чёрная дыра (2000)',
    guide:'12:46 — Моана (2026)',
    description:'В недалёком будущем космический корабль терпит бедствие. Экипаж вынужден совершить посадку.',
    hints:'← / → — каналы · OK — список · BACK — закрыть',
    menus:'YOSSO TV · Все каналы · Избранное',
    title:'316. Yosso TV BEST',
    zapName:'Yosso TV BEST',
    zapEpg:'Сейчас 18:42 · Чёрная дыра (2000)   Далее 20:09 · Следующий фильм',
    infoEpg:'Сейчас: Чёрная дыра (2000) · Далее: Сумерки (2008)',
    infoLabels:'Сейчас                      Далее'
  };
  // Lightweight fullscreen examples behind Settings > Fonts. No network
  // requests or changes to the live navigation/playback state are performed.
  function buildFontScene(opt){
    if(!el.fontScene||!state.settingsOpen||state.settingsSection!=='fonts'){if(el.fontScene)hide('fontScene');return;}
    var scene=el.fontScene;scene.textContent='';
    var mode=(opt.key==='zapName'||opt.key==='zapEpg')?'zap':
      (opt.key==='guide'||opt.key==='description')?'guide':
      (opt.key==='title'||opt.key==='hints'||opt.key==='infoEpg'||opt.key==='infoLabels')?'info':'channels';
    scene.className='font-scene scene-'+mode;
    scene.appendChild(create('div','scene-watermark','ПРИМЕР · '+(mode==='guide'?'ПРОГРАММА ПЕРЕДАЧ':mode==='info'?'ИНФОРМАЦИЯ О КАНАЛЕ':mode==='zap'?'ПЕРЕКЛЮЧЕНИЕ КАНАЛОВ':'СПИСОК КАНАЛОВ')));
    var ch=state.channels[state.current]||state.channels[0]||{name:'Yosso TV Kids',group:'YOSSO TV',num:307,logo:'',key:''};
    var epg=state.epg[ch.key]||{},now=epg.current&&epg.current.name||'Приключения Флика (1998)',
      later=epg.next&&epg.next.name||'Смешарики. Начало (2011)';
    var names=['Yosso TV Grand','Yosso TV VHS','Yosso TV Kids','Yosso TV NEW Кино','Yosso TV Мелодрама','Yosso TV Русские фильмы','Yosso TV Наше Детское'];
    var plays=['Как трусливый Роберт Форд убил Джесси Джеймса','Грязный Гарри (1971)','Соник в кино (2020)','Моана (2026)','Земля Эльзы (2020)','Матч (2012)','Сердце пармы (2022)'];
    var displayChannels=[];
    if(state.channels.length){
      var anchor=Math.max(0,state.current),start=Math.max(0,anchor-3);
      for(var q=start;q<Math.min(state.channels.length,start+7);q++)displayChannels.push(state.channels[q]);
    }
    if(!displayChannels.length)for(var r=0;r<7;r++)displayChannels.push({name:names[r],num:305+r,group:'YOSSO TV',logo:'',key:''});
    function logoFor(node,c){
      var logo=create('span','scene-channel-logo');
      if(c.logo){var img=document.createElement('img');img.alt='';img.src=c.logo;logo.appendChild(img);}
      else logo.textContent=c.name?c.name.charAt(0).toUpperCase():'TV';
      node.appendChild(logo);
    }
    if(mode==='channels'){
      var wrap=create('div','scene-browser');var groupsCol=create('div','scene-browser-groups');
      groupsCol.appendChild(create('div','scene-large-heading','КАТЕГОРИИ'));
      var groups=['Все каналы','YOSSO TV','Новостные','Фильмы и сериалы','Детские','Спортивные','Избранное'];
      for(var g=0;g<groups.length;g++)groupsCol.appendChild(create('div','scene-group-item'+(g===1?' active':''),groups[g]));
      var listing=create('div','scene-browser-list');listing.appendChild(create('div','scene-large-heading','КАНАЛЫ · '+(ch.group||'YOSSO TV')));
      for(var j=0;j<displayChannels.length;j++){
        var candidate=displayChannels[j],chosen=candidate.key===ch.key||j===3&&state.current<0;
        var line=create('div','scene-browser-channel'+(chosen?' active':''));logoFor(line,candidate);
        var body=create('div','scene-browser-channel-meta');body.appendChild(create('div','scene-channel-name',(candidate.num||j+1)+'. '+candidate.name));
        var program=state.epg[candidate.key]&&state.epg[candidate.key].current;
        body.appendChild(create('div','scene-channel-program',program&&program.name||plays[j%plays.length]));
        line.appendChild(body);listing.appendChild(line);
      }
      wrap.appendChild(groupsCol);wrap.appendChild(listing);
      scene.appendChild(wrap);
    }else if(mode==='zap'){
      var zap=create('div','scene-zap-panel');
      var car=create('div','scene-zap-carousel');
      var near=['VeleS Триллер','VeleS Аниме','Yosso TV Kids','Yosso TV BEST','Yosso TV NEW Кино'];
      for(var zi=0;zi<near.length;zi++){
        var card=create('div','scene-zap-card'+(zi===2?' active':''));
        card.appendChild(create('div','scene-zap-card-title',near[zi]));
        card.appendChild(create('div','scene-zap-card-epg',zi===2?now:'Программа передач'));car.appendChild(card);
      }
      zap.appendChild(car);
      var hero=create('div','scene-zap-hero');
      var logoArea=create('div','scene-zap-logo-area');logoFor(logoArea,ch);
      logoArea.appendChild(create('div','scene-zap-name',ch.name));hero.appendChild(logoArea);
      var programs=create('div','scene-zap-programs');
      var zn=create('div','scene-zap-program');
      zn.appendChild(create('span','scene-zap-caption','Сейчас'));
      zn.appendChild(create('span','scene-zap-epg',now));programs.appendChild(zn);
      var zl=create('div','scene-zap-program');
      zl.appendChild(create('span','scene-zap-caption','Далее'));
      zl.appendChild(create('span','scene-zap-epg',later));programs.appendChild(zl);
      hero.appendChild(programs);zap.appendChild(hero);
      zap.appendChild(create('div','scene-zap-timeline','19:04   ━━━━━━━━━━━━━━━━━━━━━━━   22:15'));scene.appendChild(zap);
    }else if(mode==='guide'){
      var panel=create('div','scene-epg-panel'),header=create('div','scene-epg-head');
      header.appendChild(create('div','scene-large-heading','ПРОГРАММА ПЕРЕДАЧ'));
      header.appendChild(create('div','scene-epg-channel-name',ch.name));
      panel.appendChild(header);
      var main=create('div','scene-epg-main');var days=create('div','scene-epg-dates');
      for(var d=0;d<7;d++){
        var dd=new Date(Date.now()+(d-3)*86400000);
        days.appendChild(create('div','scene-epg-day'+(d===3?' active':''),weekdays[dd.getDay()]+'\n'+pad(dd.getDate())+'.'+pad(dd.getMonth()+1)));
      }
      var rowsCol=create('div','scene-epg-list');var titleSamples=['15:17 · Мой сосед Тоторо (1988)','16:43 · На твоей волне (2019)','18:19 · '+now,'20:11 · Навсикая из долины ветров (1984)','22:08 · Паприка (2006)','23:38 · Порко Россо (1992)','01:12 · Принцесса Мононоке (1997)'];
      for(var k=0;k<titleSamples.length;k++)rowsCol.appendChild(create('div','scene-epg-row'+(k===2?' active':''),titleSamples[k]));
      var details=create('div','scene-epg-details');details.appendChild(create('div','scene-date-label','Сегодня · 18:19–20:11'));
      details.appendChild(create('div','scene-epg-detail-title',now));
      details.appendChild(create('div','scene-epg-description',epg.current&&epg.current.desc||'Подробное описание выбранной передачи. Текст и время меняют размер вместе с настройками шрифта телепрограммы.'));
      main.appendChild(days);main.appendChild(rowsCol);main.appendChild(details);panel.appendChild(main);scene.appendChild(panel);
    }else{
      var info=create('div','scene-info-panel'),top=create('div','scene-info-top');logoFor(top,ch);
      var heading=create('div','scene-info-heading');heading.appendChild(create('div','scene-channel-name',ch.name));
      heading.appendChild(create('div','scene-big-title',now));top.appendChild(heading);info.appendChild(top);
      var inow=create('div','scene-info-program');
      inow.appendChild(create('span','scene-info-caption','Сейчас'));
      inow.appendChild(create('span','scene-info-epg','19:01–20:35 · '+now));info.appendChild(inow);
      var inext=create('div','scene-info-program');
      inext.appendChild(create('span','scene-info-caption','Далее'));
      inext.appendChild(create('span','scene-info-epg','20:35 · '+later));info.appendChild(inext);
      info.appendChild(create('div','scene-info-description',epg.current&&epg.current.desc||'Подробное описание фильма или передачи отображается целиком при просмотре информации о канале.'));
      info.appendChild(create('div','scene-info-hint','← / → — каналы · ↓ — информация · ↑ — программа · OK — список · BACK — закрыть'));
      scene.appendChild(info);
    }
    show('fontScene');
  }
  function showFontPreview(opt){
    focusedFontKey=opt.key;
    if(!el.fontControls)return;
    var rows=el.fontControls.querySelectorAll('.font-control-row');
    for(var i=0;i<rows.length;i++){
      var row=rows[i],active=row.getAttribute('data-font-key')===opt.key;
      row.classList.toggle('has-preview',active);
      var sample=row.querySelector('.font-row-sample');
      if(sample&&active)sample.style.fontSize=state.fontSizes[opt.key]+'px';
    }
    buildFontScene(opt);
  }
  function renderFontControls(){
    el.fontControls.textContent='';
    for(var i=0;i<FONT_OPTIONS.length;i++){
      (function(opt){
        var row=create('div','font-control-row');
        row.setAttribute('data-font-key',opt.key);
        var name=create('span','font-control-name',opt.name);
        var controls=create('div','font-control-buttons');
        var minus=create('button','font-adjust','−'),plus=create('button','font-adjust','+');
        var value=create('span','font-control-value',state.fontSizes[opt.key]+' px');
        minus.type='button';plus.type='button';minus.setAttribute('data-focus','1');plus.setAttribute('data-focus','1');
        minus.setAttribute('aria-label',opt.name+' уменьшить');plus.setAttribute('aria-label',opt.name+' увеличить');
        var preview=create('div','font-row-preview');
        var caption=create('span','font-row-preview-caption','ОБРАЗЕЦ · '+opt.name);
        var sample=create('div','font-row-sample font-sample-'+opt.key,FONT_SAMPLES[opt.key]);
        preview.appendChild(caption);preview.appendChild(sample);
        function select(){showFontPreview(opt);}
        minus.onfocus=select;plus.onfocus=select;
        minus.onmouseover=select;plus.onmouseover=select;
        minus.onclick=function(){select();changeFont(opt,-1);value.textContent=state.fontSizes[opt.key]+' px';};
        plus.onclick=function(){select();changeFont(opt,1);value.textContent=state.fontSizes[opt.key]+' px';};
        controls.appendChild(minus);controls.appendChild(value);controls.appendChild(plus);
        row.appendChild(name);row.appendChild(controls);row.appendChild(preview);el.fontControls.appendChild(row);
      })(FONT_OPTIONS[i]);
    }
    showFontPreview(FONT_OPTIONS.filter(function(opt){return opt.key===focusedFontKey;})[0]||FONT_OPTIONS[0]);
  }
  function changeFont(opt,delta){
    var next=Math.max(opt.min,Math.min(opt.max,(Number(state.fontSizes[opt.key])||opt.value)+delta));
    state.fontSizes[opt.key]=next;applyFonts();showFontPreview(opt);save();
  }
  function resetFonts(){state.fontSizes={};applyFonts();renderFontControls();save();}
  function openSettings(){
    state.editingPlaylistId=state.activePlaylistId;
    populateProfileFields(state.playlist);
    if(el.epgStatus)el.epgStatus.textContent=state.epgDiagnostics||'EPG: не загружен';
    state.settingsOpen=true;hide('guidePanel');show('settingsModal');refreshTopline();
    renderProfileList();renderFontControls();
    el.playlistProfileNote.textContent='Выбери профиль для переключения или редактирования. Активный плейлист сохраняется между запусками.';
    showSettingsSection('playlists');
    setTimeout(function(){el.settingsTabPlaylists.focus();},65);checkService();
  }
  function closeSettings(){
    state.settingsOpen=false;hide('settingsModal');hide('fontScene');stopRemoteSettings();refreshTopline();
    if(!state.channels.length)showSidebar();
    else if(state.sidebarOpen){
      if(state.visible.length)focusChannel(Math.min(state.selectedVisible,state.visible.length-1));
      else el.settingsButton.focus();
    }
  }
  function startRemoteSettings(){
    if(!el.remoteStatus||typeof window.PalmServiceBridge!=='function')return;
    var serial=++remoteStartSerial,bridge=new window.PalmServiceBridge();
    el.remoteStatus.textContent='Запускаю локальную страницу настройки...';
    el.remoteQr.innerHTML='';el.remoteAddress.textContent='';el.remotePin.textContent='';
    bridge.onservicecallback=function(txt){
      if(serial!==remoteStartSerial||!state.settingsOpen)return;
      try{
        var r=JSON.parse(txt);
        if(!r.returnValue){el.remoteStatus.textContent=r.errorText||'Ошибка локальной страницы';return;}
        el.remoteStatus.textContent='Управляй плейлистами и импортируй M3U-файлы через браузер';
        el.remoteQr.innerHTML=r.qrSvg||'';
        el.remoteAddress.textContent=r.url?r.url.split('/?')[0]+'/':'Адрес LAN не обнаружен';
        el.remotePin.textContent=r.pin?'Код доступа для браузера: '+r.pin:'QR-код содержит код доступа';
        state.remoteRevision=r.revision||0;
        clearInterval(remotePollTimer);
        remotePollTimer=setInterval(pollRemoteSettings,2300);
      }catch(e){el.remoteStatus.textContent='Ошибка ответа веб-сервиса';}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/startConfig',JSON.stringify({playlists:state.playlists,activePlaylistId:state.activePlaylistId}));}
    catch(e){el.remoteStatus.textContent='Не удалось запустить веб-страницу';}
  }
  function syncRemoteSettings(){
    if(!state.settingsOpen||state.settingsSection!=='playlists'||typeof window.PalmServiceBridge!=='function')return;
    var bridge=new window.PalmServiceBridge();bridge.onservicecallback=function(){};
    try{bridge.call('luna://'+SERVICE_ID+'/syncConfig',JSON.stringify({playlists:state.playlists,activePlaylistId:state.activePlaylistId}));}catch(e){}
  }
  function stopRemoteSettings(){
    ++remoteStartSerial;
    clearInterval(remotePollTimer);remotePollTimer=0;
    if(typeof window.PalmServiceBridge==='function'){
      var bridge=new window.PalmServiceBridge();bridge.onservicecallback=function(){};
      try{bridge.call('luna://'+SERVICE_ID+'/stopConfig','{}');}catch(e){}
    }
  }
  function pollRemoteSettings(){
    if(!state.settingsOpen||typeof window.PalmServiceBridge!=='function')return;
    var bridge=new window.PalmServiceBridge();
    bridge.onservicecallback=function(txt){
      if(!state.settingsOpen)return;
      try{
        var r=JSON.parse(txt);if(!r.returnValue||!r.changed||!r.config)return;
        var p=r.config,raw=Array.isArray(p.playlists)?p.playlists:[];
        if(!raw.length)return;
        var list=[],seen={},i,v,epg,title,url,source;
        for(i=0;i<raw.length&&i<12;i++){
          v=raw[i];if(!v||!v.id||seen[v.id])continue;
          url=validPlaylistUrl(v.url);epg=String(v.epg||'').trim();title=String(v.title||'Плейлист').slice(0,100);
          if(!url||(epg&&!normalURL(epg)))return;
          source=isLocalPlaylistUrl(url)?'file':'url';
          seen[v.id]=true;
          var old=profileById(v.id);
          list.push({id:String(v.id),url:url,epg:epg,title:title,source:source,
            lastKey:old&&old.url===url?old.lastKey:String(v.lastKey||'')});
        }
        if(!list.length)return;
        var target=null;for(i=0;i<list.length;i++)if(list[i].id===p.activePlaylistId){target=list[i];break;}
        if(!target)target=list[0];
        // Persist the previous profile's channel before replacing profiles.
        save();
        var oldId=state.activePlaylistId,oldUrl=state.playlist.url,oldEpg=state.playlist.epg;
        var switching=oldId!==target.id||oldUrl!==target.url||!state.hasPlaylist;
        state.playlists=list;
        state.remoteRevision=r.revision;
        // Acknowledge changes so later TV-side profile edits can sync back to the web.
        var ack=new window.PalmServiceBridge();ack.onservicecallback=function(){};
        try{ack.call('luna://'+SERVICE_ID+'/ackConfigChanges',JSON.stringify({revision:r.revision}));}catch(e){}
        if(switching){activateProfile(target.id,true,true);}
        else{
          state.activePlaylistId=target.id;state.editingPlaylistId=target.id;
          state.playlist={url:target.url,epg:target.epg,title:target.title,source:target.source};
          save();renderProfileList();populateProfileFields(target);
          if(oldEpg!==target.epg){state.epg={};restoreCachedEpg();}
          else updateVisibleEpg();
        }
        toast('Плейлисты обновлены с компьютера / телефона',4500);
      }catch(e){toast('Не удалось применить веб-настройки: '+String(e.message||e),5000);}
    };
    try{bridge.call('luna://'+SERVICE_ID+'/getConfigChanges',JSON.stringify({since:state.remoteRevision||0}));}catch(e){}
  }

  function saveSettings(){
    var existing=state.editingPlaylistId==='__new__'?null:profileById(state.editingPlaylistId);
    var typed=normalURL(el.playlistUrl.value),url=typed||(existing&&existing.source==='file'?existing.url:''),epg=el.epgUrl.value.trim(),title=el.playlistTitle.value.trim();
    if(!url){toast('Укажи URL M3U либо импортируй файл через веб-редактор.',5000);el.playlistUrl.focus();return;}
    if(epg&&!normalURL(epg)){toast('Укажи правильный URL EPG или оставь поле пустым.',5000);el.epgUrl.focus();return;}
    if(!title)title='Плейлист '+(state.playlists.length+(state.editingPlaylistId==='__new__'?1:0));
    var oldUrl=state.playlist.url,oldEpg=state.playlist.epg;
    var profile=state.editingPlaylistId==='__new__'?null:profileById(state.editingPlaylistId);
    if(!profile){profile=makeProfile(url,epg,title);state.playlists.push(profile);}
    profile.url=url;profile.epg=epg;profile.title=title;profile.source=isLocalPlaylistUrl(url)?'file':'url';
    // A selected profile becomes active after explicit Save (or clicking it).
    if(profile.id!==state.activePlaylistId){
      state.activePlaylistId=profile.id;state.editingPlaylistId=profile.id;
      state.playlist={url:url,epg:epg,title:title,source:profile.source};
      state.resumeKey=profile.lastKey||'';state.resumeUrl=url;state.resumeIndex=-1;
      ++epgRestoreSerial;clearTimeout(epgRefreshTimer);
      state.epg={};epgLastChecked=0;epgNowBusy=false;guideCache={};gridGuideCache={};
      state.current=-1;state.archive=null;
      try{el.video.pause();el.video.removeAttribute('src');while(el.video.firstChild)el.video.removeChild(el.video.firstChild);el.video.load();}catch(err){}
      hide('video');show('idle');closeRecent();closeTvGrid();closeQuickBrowser();hideArchiveSeek();
      save();syncRemoteSettings();loadPlaylist(true,false);return;
    }
    state.playlist={url:url,epg:epg,title:title,source:profile.source};
    state.editingPlaylistId=profile.id;save();renderProfileList();syncRemoteSettings();
    if(oldUrl!==url||!state.hasPlaylist){loadPlaylist(false,oldUrl!==url&&!isLocalPlaylistUrl(url));}
    else {closeSettings();if(oldEpg!==epg){state.epg={};guideCache={};guideCacheOrder=[];restoreCachedEpg();}
      else toast('Настройки сохранены. M3U взят из локального кэша.');}
  }
  function isEditing(target){return target&&(/INPUT|TEXTAREA/.test(target.tagName)||target.isContentEditable);}
  function availableFocus(){
    var root=state.settingsOpen?el.settingsModal:el.sidebar;
    var all=root.querySelectorAll('[data-focus="1"],input');var out=[];
    for(var i=0;i<all.length;i++){
      var a=all[i];if(a.offsetWidth>0&&a.offsetHeight>0&&!a.disabled)out.push(a);
    }
    return out;
  }
  function spatialFocus(direction,anchor){
    var nodes=availableFocus();if(!nodes.length)return;
    var active=anchor||document.activeElement;
    if(nodes.indexOf(active)<0){nodes[0].focus();return;}
    var rect=active.getBoundingClientRect(),ax=rect.left+rect.width/2,ay=rect.top+rect.height/2;
    var best=null,score=Infinity;
    for(var i=0;i<nodes.length;i++){
      var node=nodes[i];if(node===active)continue;
      var r=node.getBoundingClientRect(),bx=r.left+r.width/2,by=r.top+r.height/2;
      var dx=bx-ax,dy=by-ay,vertical=direction==='up'||direction==='down';
      if(vertical){if(direction==='up'&&dy>=-8||direction==='down'&&dy<=8)continue;}
      else {if(direction==='left'&&dx>=-8||direction==='right'&&dx<=8)continue;}
      var primary=vertical?Math.abs(dy):Math.abs(dx);
      var secondary=vertical?Math.abs(dx):Math.abs(dy);
      // Keep horizontal navigation on the same row; vertical on the same column.
      var s=primary+secondary*4;
      if(s<score){score=s;best=node;}
    }
    if(best){best.focus();if(best.scrollIntoView)try{best.scrollIntoView(false);}catch(e){}}
  }
  function focusModes(index){
    var tabs=[el.modeAll,el.modeFav,el.modeGroups,id('searchToggle')];
    index=Math.max(0,Math.min(3,index));tabs[index].focus();
  }
  function focusGroup(index){
    var nodes=el.groups.querySelectorAll('.group-item');
    if(!nodes.length){focusFirstChannel();return;}
    index=Math.max(0,Math.min(nodes.length-1,index));
    var target=nodes[index];
    var panel=el.groups;
    // Scroll only the groups pane; calling scrollIntoView() scrolls unrelated TV panes.
    var t=target.getBoundingClientRect(),p=panel.getBoundingClientRect();
    if(t.top<p.top)panel.scrollTop-=p.top-t.top+5;
    else if(t.bottom>p.bottom)panel.scrollTop+=t.bottom-p.bottom+5;
    target.focus();
    state.lastGroupFocusIndex=index;
  }
  function moveWithinGroups(direction,active){
    var nodes=el.groups.querySelectorAll('.group-item');
    var at=Array.prototype.indexOf.call(nodes,active);
    if(at<0)return;
    var r=active.getBoundingClientRect();
    var cx=r.left+r.width/2,cy=r.top+r.height/2;
    var bestIndex=-1,bestScore=Infinity,vertical=direction==='up'||direction==='down';
    for(var i=0;i<nodes.length;i++){
      if(i===at)continue;
      var b=nodes[i].getBoundingClientRect();
      var dx=b.left+b.width/2-cx,dy=b.top+b.height/2-cy;
      if(vertical){
        if(direction==='up'&&dy>=-12 || direction==='down'&&dy<=12)continue;
        var score=Math.abs(dy)*1000+Math.abs(dx);
      } else {
        // Left and right always stay within the same rendered row.
        if(Math.abs(dy)>16)continue;
        if(direction==='left'&&dx>=-8 || direction==='right'&&dx<=8)continue;
        var score=Math.abs(dx);
      }
      if(score<bestScore){bestScore=score;bestIndex=i;}
    }
    if(bestIndex>=0)focusGroup(bestIndex);
    else if(direction==='up')el.modeGroups.focus();
    else if(direction==='down')focusFirstChannel();
  }
  function sidebarMove(direction){
    var active=document.activeElement;
    if(active&&active.hasAttribute&&active.hasAttribute('data-guide-index')){guideNavigate(direction);return;}
    var favorite=active&&active.getAttribute?active.getAttribute('data-favorite-index'):null;
    if(favorite!==null){
      var fi=+favorite;
      if(direction==='left')focusChannel(fi);
      else if(direction==='up')focusFavorite(Math.max(0,fi-1));
      else if(direction==='down')focusFavorite(Math.min(state.visible.length-1,fi+1));
      else if(direction==='right'){
        if(state.playbackGroupList)focusChannel(fi);
        else {
          if(state.sidebarFromPlayback){state.sidebarFromPlayback=false;selectChannelGuide(state.visible[fi]);}
          var g=el.guideRows.querySelector('.guide-onair')||el.guideRows.querySelector('.guide-row');
          if(g)g.focus();
          else focusChannel(fi);
        }
      }
      return;
    }
    var row=active&&active.getAttribute?active.getAttribute('data-visible-index'):null;
    if(row!==null){
      var idx=+row;
      if(direction==='up'){
        if(idx>0)focusChannel(idx-1);
        else if(state.mode==='groups'&&!el.groups.classList.contains('hidden')&&el.groups.firstChild)focusGroup(state.lastGroupFocusIndex);
        else if(!el.searchBox.classList.contains('hidden'))el.searchInput.focus();
        else focusModes(0);
      } else if(direction==='down')focusChannel(Math.min(state.visible.length-1,idx+1));
      else if(direction==='left'&&!state.playbackGroupList)focusModes(0);
      else if(direction==='right')focusFavorite(idx);
      return;
    }
    if(active&&active.classList&&active.classList.contains('mode')){
      var modes=[el.modeAll,el.modeFav,el.modeGroups,id('searchToggle')],pos=modes.indexOf(active);
      if(direction==='left')focusModes(pos-1);
      else if(direction==='right')focusModes(pos+1);
      else if(direction==='up')el.settingsButton.focus();
      else if(direction==='down'){
        if(!el.searchBox.classList.contains('hidden'))el.searchInput.focus();
        else if(state.mode==='groups'&&el.groups.firstChild)focusGroup(0);
        else focusFirstChannel();
      }
      return;
    }
    if(active&&active.classList&&active.classList.contains('group-item')){
      moveWithinGroups(direction,active);return;
    }
    if(active===el.searchInput){
      if(direction==='down')focusFirstChannel();
      else if(direction==='up')id('searchToggle').focus();
      return;
    }
    if(active===id('searchClear')){
      if(direction==='left')el.searchInput.focus();
      else if(direction==='down')focusFirstChannel();
      else if(direction==='up')id('searchToggle').focus();
      return;
    }
    if(active===el.settingsButton){
      if(direction==='down')id('reloadButton').focus();
      else if(direction==='left')id('reloadButton').focus();
      return;
    }
    if(active===id('reloadButton')){
      if(direction==='up')el.settingsButton.focus();
      else if(direction==='down')focusModes(3);
      else if(direction==='right')el.settingsButton.focus();
      return;
    }
    spatialFocus(direction);
  }
  function openQuickBrowser(){
    if(state.current<0){showSidebar();return;}
    closeRecent();closeTvGrid();closePlaybackGuide();hideArchiveSeek();closeQuickGroups();
    state.quickMode=true;state.sidebarFromPlayback=false;state.playbackGroupList=false;
    state.mode='groups';state.group=state.channels[state.current].group;
    state.groupsExpanded=false;
    el.sidebar.classList.add('quick-mode');el.sidebar.classList.remove('quick-group-offset');
    render();showSidebar();
  }
  function closeQuickBrowser(){
    // Unfocus the webOS text field when leaving quick search. Otherwise LEFT
    // presses after reopening the browser are swallowed as text-edit keys.
    if(state.quickMode){
      if(document.activeElement===el.searchInput)el.searchInput.blur();
      state.search='';el.searchInput.value='';hide('searchBox');
    }
    closeQuickGroups();state.quickMode=false;state.quickGuideFocused=false;
    el.sidebar.classList.remove('quick-mode');el.sidebar.classList.remove('quick-group-offset');
    if(state.sidebarOpen)hideSidebar();refreshTopline();
  }
  function quickFocusChannel(){
    if(!state.visible.length){el.modeFav.focus();return;}
    focusChannel(Math.min(state.selectedVisible,state.visible.length-1));
  }
  function openQuickGroups(){
    if(!state.quickMode||!state.sidebarOpen)return;
    state.quickGroupOpen=true;show('quickGroupPanel');el.sidebar.classList.add('quick-group-offset');
    hide('guidePanel');var list=el.quickGroupList;list.textContent='';
    var all=['Все каналы'].concat(groups()),active=0;
    for(var i=0;i<all.length;i++){
      var val=i===0?'':all[i],btn=create('button','quick-group-item'+(val===state.group?' active':''),all[i]);
      btn.setAttribute('data-group-position',i);btn.setAttribute('data-focus','1');
      btn.onclick=(function(group){return function(){state.group=group;state.mode='groups';render();
        closeQuickGroups();quickFocusChannel();};})(val);
      list.appendChild(btn);if(val===state.group)active=i;
    }
    var target=list.querySelector('[data-group-position="'+active+'"]');if(target)target.focus();refreshTopline();
  }
  function openQuickActions(){
    if(!state.quickMode||!state.sidebarOpen||!state.quickGroupOpen)return;
    state.quickActionsOpen=true;hide('quickGroupPanel');show('quickActionsPanel');
    el.quickActionSettings.focus();refreshTopline();
  }
  function closeQuickActions(){
    if(!state.quickActionsOpen)return;
    state.quickActionsOpen=false;hide('quickActionsPanel');
    if(state.quickGroupOpen)show('quickGroupPanel');
    refreshTopline();
  }
  function quickActionSelect(action){
    if(action==='settings'){closeQuickBrowser();openSettings();return;}
    if(action==='reload'){closeQuickBrowser();loadPlaylist(false,true);return;}
    if(action==='all'){state.mode='all';state.group='';state.search='';}
    else if(action==='favorites'){state.mode='fav';state.group='';state.search='';}
    else if(action==='search'){state.mode='all';state.group='';state.search='';}
    el.searchInput.value=state.search;
    if(action!=='search')hide('searchBox');
    render();closeQuickGroups();
    if(action==='search'){show('searchBox');el.searchInput.focus();}
    else if(state.visible.length)quickFocusChannel();
    else {el.modeFav.focus();toast('В этой категории пока нет каналов',2200);}
  }
  function closeQuickGroups(){
    closeQuickActions();state.quickGroupOpen=false;hide('quickGroupPanel');el.sidebar.classList.remove('quick-group-offset');
    refreshTopline();
  }
  function quickKey(code){
    if(state.quickActionsOpen){
      var actions=el.quickActionsList.querySelectorAll('button'),ai=Array.prototype.indexOf.call(actions,document.activeElement);
      if(ai<0)ai=0;
      if(code===38)actions[Math.max(0,ai-1)].focus();
      else if(code===40)actions[Math.min(actions.length-1,ai+1)].focus();
      else if(code===13&&actions[ai])actions[ai].click();
      else if(code===39){closeQuickActions();var g=el.quickGroupList.querySelector('.quick-group-item.active')||el.quickGroupList.querySelector('button');if(g)g.focus();}
      return true;
    }
    if(state.quickGroupOpen){
      var buttons=el.quickGroupList.querySelectorAll('button'),pos=Array.prototype.indexOf.call(buttons,document.activeElement);
      if(code===38)buttons[Math.max(0,pos-1)].focus();
      else if(code===40)buttons[Math.min(buttons.length-1,pos+1)].focus();
      else if(code===13&&document.activeElement&&document.activeElement.click)document.activeElement.click();
      else if(code===39){closeQuickGroups();quickFocusChannel();}
      else if(code===37){openQuickActions();}
      return true;
    }
    var active=document.activeElement;
    if(active&&active.classList&&active.classList.contains('guide-day')){
      if(code===38)guideDateNavigate('up');else if(code===40)guideDateNavigate('down');
      else if(code===37)guideDateNavigate('left');
      else if(code===13)active.click();return true;
    }
    if(active&&active.hasAttribute&&active.hasAttribute('data-guide-index')){
      if(code===38||code===40)guideNavigate(code===38?'up':'down');
      else if(code===37)quickFocusChannel();
      else if(code===39){var d=el.guideDates.querySelector('.guide-day.active')||el.guideDates.querySelector('.guide-day');if(d)d.focus();}
      else if(code===13)active.click();return true;
    }
    if(code===38||code===40){quickRowNav(code===38?-1:1);return true;}
    if(code===37){openQuickGroups();return true;}
    if(code===39){
      var selected=state.visible[state.selectedVisible];if(selected)selectChannelGuide(selected);
      var row=el.guideRows.querySelector('.guide-onair')||el.guideRows.querySelector('.guide-row');
      if(row)row.focus();else toast('Для этого канала расписание недоступно');return true;
    }
    if(code===13){var ch=state.visible[state.selectedVisible];if(ch)playChannel(ch.num-1);return true;}
    return true;
  }
  function quickRowNav(delta){
    if(!state.visible.length)return;
    focusChannel(Math.max(0,Math.min(state.visible.length-1,state.selectedVisible+delta)));
  }
  function closeArchiveLiveInfo(){
    if(!state.archiveLiveOpen)return;
    state.archiveLiveOpen=false;hide('archiveLivePanel');refreshTopline();
  }
  function updateArchiveLiveInfo(){
    if(!state.archiveLiveOpen)return;
    var ch=state.channels[state.current];if(!ch)return;
    var info=state.epg[ch.key]||{},rows=guideCache[ch.num-1]||gridGuideCache[ch.num-1];
    var parsed=rows?findPrograms(rows):null;
    var current=parsed&&parsed.current?unpackProgram(parsed.current):info.current;
    var next=parsed&&parsed.next?unpackProgram(parsed.next):info.next;
    el.archiveLiveLogo.src=ch.logo||'';
    el.archiveLiveLogo.style.display=ch.logo?'block':'none';
    el.archiveLiveChannel.textContent=ch.num+'. '+ch.name;
    el.archiveLiveGroup.textContent=ch.group||'';
    el.archiveLiveNow.textContent=current?current.name:'Программа текущего эфира недоступна';
    el.archiveLiveNext.textContent=next?'Далее: '+timeLabel(next.start)+' · '+next.name:'Следующая передача: нет данных EPG';
    el.archiveLiveDescription.textContent=current&&current.desc?current.desc:'Описание текущей передачи в XMLTV отсутствует.';
    if(current&&current.end>current.start){
      var length=current.end-current.start,elapsed=Math.max(0,Math.min(length,Date.now()-current.start));
      var remaining=Math.max(0,Math.ceil((length-elapsed)/60000));
      el.archiveLiveTime.textContent=timeLabel(current.start)+'–'+timeLabel(current.end)+' · осталось '+remaining+' мин';
      el.archiveLiveProgress.style.width=Math.round(elapsed/length*100)+'%';
    }else{el.archiveLiveTime.textContent='Время передачи неизвестно';el.archiveLiveProgress.style.width='0%';}
  }
  function openArchiveLiveInfo(){
    if(!state.archive)return;
    closeRecent();closePlaybackGuide();closeQuickBrowser();hideArchiveSeek();resetPlayerOSD();
    state.archiveLiveOpen=true;updateArchiveLiveInfo();show('archiveLivePanel');
    el.archiveLiveGo.focus();refreshTopline();
  }
  function closeRecent(){state.recentOpen=false;hide('recentPanel');refreshTopline();}
  function openRecent(){
    if(state.archive){openArchiveLiveInfo();return;}
    if(state.current<0){showSidebar();return;}
    closeQuickBrowser();closePlaybackGuide();closeTvGrid();hideArchiveSeek();resetPlayerOSD();
    state.recentOpen=true;renderRecent();show('recentPanel');refreshTopline();
    var buttons=el.recentPanel.querySelectorAll('.recent-card');if(buttons.length)buttons[Math.min(recentFocusIndex,buttons.length-1)].focus();
  }
  function recentProgram(index){var ch=state.channels[index];if(!ch)return null;
    var e=state.epg[ch.key];return e&&e.current||null;}
  function renderRecent(){
    var ch=state.channels[state.current];if(!ch)return;
    el.recentTitle.textContent=ch.num+'. '+ch.name;el.recentLogo.src=ch.logo||'';
    el.recentLogo.style.display=ch.logo?'block':'none';
    var curr=recentProgram(state.current),n=state.epg[ch.key]&&state.epg[ch.key].next;
    el.recentNow.textContent=curr?'Сейчас: '+curr.name:'Прямой эфир';
    el.recentNext.textContent=n?'Далее: '+n.name:'';
    el.recentClock.textContent=el.clock.textContent;
    var pct=curr&&curr.end>curr.start?(Date.now()-curr.start)/(curr.end-curr.start)*100:0;
    el.recentProgressFill.style.width=Math.max(0,Math.min(100,pct))+'%';
    el.recentFavorite.querySelector('span:last-child').textContent=state.favorites[ch.key]?'Убрать из избранного':'Добавить в избранное';
    el.recentFavorite.querySelector('span:first-child').textContent=state.favorites[ch.key]?'★':'☆';
    el.recentChannels.textContent='';
    var shown=0;
    for(var i=0;i<state.history.length&&shown<16;i++){
      var key=state.history[i],index=-1;
      for(var nidx=0;nidx<state.channels.length;nidx++)if(state.channels[nidx].key===key){index=nidx;break;}
      if(index<0||index===state.current)continue;
      var past=state.channels[index],card=create('button','recent-card recent-channel-card');
      card.setAttribute('data-recent-index',index);
      var logo=document.createElement('img');logo.src=past.logo||'';logo.alt='';card.appendChild(logo);
      card.appendChild(create('span','recent-channel-name',past.name));
      var showInfo=recentProgram(index);card.appendChild(create('small','recent-channel-program',showInfo?showInfo.name:past.group));
      card.onclick=(function(idx){return function(){playChannel(idx);};})(index);
      el.recentChannels.appendChild(card);shown++;
    }
    if(!shown)el.recentChannels.appendChild(create('span','recent-empty','История появится после переключения каналов'));
  }
  function recentKey(code){
    var buttons=el.recentPanel.querySelectorAll('.recent-card'),pos=Array.prototype.indexOf.call(buttons,document.activeElement);
    if(pos<0)pos=0;
    if(code===37)pos=Math.max(0,pos-1);
    else if(code===39)pos=Math.min(buttons.length-1,pos+1);
    else if(code===38)pos=0;
    else if(code===40)pos=Math.min(buttons.length-1,Math.max(2,pos));
    else if(code===13){
      if(document.activeElement&&document.activeElement.click)document.activeElement.click();return;
    }
    if(buttons[pos]){recentFocusIndex=pos;buttons[pos].focus();buttons[pos].scrollIntoView(false);}
  }
  function closeTvGridGroups(){
    state.gridGroupsOpen=false;hide('tvGridGroupsPanel');gridLeftAt=0;refreshTopline();
  }
  function openTvGridGroups(){
    if(!state.tvGridOpen)return;
    gridLeftAt=0;state.gridGroupsOpen=true;
    var list=el.tvGridGroupsList;list.textContent='';
    var opts=[{label:'Все каналы',group:''}].concat(groups().map(function(g){return {label:g,group:g};}));
    var chosen=null;
    for(var i=0;i<opts.length;i++){
      var opt=opts[i],button=create('button','quick-group-item'+(opt.group===state.gridGroup?' active':''),opt.label);
      button.setAttribute('data-group',opt.group);
      button.onclick=(function(group){return function(){
        var old=state.gridChannels[state.gridIndex];state.gridGroup=group;
        state.gridChannels=state.channels.filter(function(ch){return !group||ch.group===group;});
        state.gridIndex=old?Math.max(0,state.gridChannels.indexOf(old)):0;
        state.gridPending={};closeTvGridGroups();renderTvGrid();
      };})(opt.group);
      list.appendChild(button);if(opt.group===state.gridGroup)chosen=button;
    }
    show('tvGridGroupsPanel');if(chosen)chosen.focus();refreshTopline();
  }
  function tvGridGroupsKey(code){
    var buttons=el.tvGridGroupsList.querySelectorAll('button');if(!buttons.length)return;
    var pos=Array.prototype.indexOf.call(buttons,document.activeElement);if(pos<0)pos=0;
    if(code===38)buttons[Math.max(0,pos-1)].focus();
    else if(code===40)buttons[Math.min(buttons.length-1,pos+1)].focus();
    else if(code===13)buttons[pos].click();
    else if(code===39||code===37)closeTvGridGroups();
  }
  function closeTvGrid(){closeTvGridGroups();state.tvGridOpen=false;hide('tvGrid');refreshTopline();}
  function openTvGrid(){
    closeRecent();closeQuickBrowser();closePlaybackGuide();resetPlayerOSD();hideArchiveSeek();
    state.tvGridOpen=true;gridLeftAt=0;
    var current=state.channels[state.current];
    state.gridGroup=current?current.group:'';
    state.gridChannels=state.channels.filter(function(ch){return current?ch.group===current.group:true;});
    if(!state.gridChannels.length)state.gridChannels=state.channels.slice(0);
    state.gridIndex=Math.max(0,state.gridChannels.indexOf(current));
    state.gridCursor=Math.floor(Date.now()/1800000)*1800000;
    state.gridStart=state.gridCursor-1800000;
    state.gridPending={};show('tvGrid');renderTvGrid();refreshTopline();
  }
  function cacheGridGuide(index,rows){
    gridGuideCache[index]=rows;gridGuideOrder=gridGuideOrder.filter(function(n){return n!==index;});gridGuideOrder.push(index);
    if(gridGuideOrder.length>18)delete gridGuideCache[gridGuideOrder.shift()];
  }
  function requestGridGuide(ch){
    var key=ch.num-1;
    if(gridGuideCache[key]||state.gridPending[key]||!Object.keys(state.epg).length||typeof window.PalmServiceBridge!=='function')return;
    state.gridPending[key]=true;
    var bridge=new window.PalmServiceBridge(),timeout=setTimeout(function(){done(null);},9000),doneCalled=false;
    function done(rows){if(doneCalled)return;doneCalled=true;clearTimeout(timeout);delete state.gridPending[key];
      if(rows)cacheGridGuide(key,rows);if(state.tvGridOpen)renderTvGrid();}
    bridge.onservicecallback=function(txt){try{var r=JSON.parse(txt);done(r.returnValue&&Array.isArray(r.rows)?r.rows:null);}catch(e){done(null);}};
    try{bridge.call('luna://'+SERVICE_ID+'/getGuide',JSON.stringify({index:key}));}catch(e){done(null);}
  }
  function renderTvGrid(){
    if(!state.tvGridOpen)return;
    el.tvGridGroup.textContent=state.gridGroup||'Все каналы';
    var start=state.gridStart,end=start+4*3600000,ticks=el.tvGridTicks;ticks.textContent='';
    for(var i=0;i<=8;i++){
      var d=new Date(start+i*1800000),tick=create('span','tv-grid-tick',pad(d.getHours())+':'+pad(d.getMinutes()));
      tick.style.left=i*12.5+'%';ticks.appendChild(tick);
    }
    el.tvGridRows.textContent='';
    var first=Math.floor(state.gridIndex/8)*8,last=Math.min(state.gridChannels.length,first+8);
    for(var n=first;n<last;n++){
      var ch=state.gridChannels[n],row=create('div','tv-grid-row'+(n===state.gridIndex?' selected':''));
      var label=create('div','tv-grid-channel');
      if(ch.logo){var logo=document.createElement('img');logo.src=ch.logo;logo.alt='';label.appendChild(logo);}
      label.appendChild(create('span','tv-grid-channel-name',ch.name));
      if(state.current===ch.num-1)label.appendChild(create('span','tv-grid-live','▶'));
      row.appendChild(label);
      var strip=create('div','tv-grid-strip'),rows=gridGuideCache[ch.num-1]||guideCache[ch.num-1];
      if(!rows){strip.appendChild(create('span','tv-grid-empty','Читаю EPG…'));requestGridGuide(ch);}
      else{
        var found=false;
        for(var j=0;j<rows.length;j++){
          var r=rows[j];if(r[2]<=start||r[1]>=end)continue;
          var left=Math.max(start,r[1]),right=Math.min(end,r[2]);if(right<=left)continue;
          var block=create('div','tv-grid-program'+(n===state.gridIndex&&state.gridCursor>=r[1]&&state.gridCursor<r[2]?' picked':''),r[0]);
          block.style.left=((left-start)/(end-start)*100)+'%';block.style.width=Math.max(1.5,((right-left)/(end-start)*100))+'%';
          strip.appendChild(block);found=true;
        }
        if(!found)strip.appendChild(create('span','tv-grid-empty','Нет программы на выбранное время'));
      }
      var line=create('div','tv-grid-playhead');line.style.left=((state.gridCursor-start)/(end-start)*100)+'%';strip.appendChild(line);
      row.appendChild(strip);el.tvGridRows.appendChild(row);
    }
    var chosen=state.gridChannels[state.gridIndex];if(!chosen)return;
    var programs=gridGuideCache[chosen.num-1]||guideCache[chosen.num-1],pick=null;
    if(programs)for(var x=0;x<programs.length;x++)if(programs[x][1]<=state.gridCursor&&programs[x][2]>state.gridCursor){pick=programs[x];break;}
    var text=chosen.name+' · '+(pick?timeLabel(pick[1])+'–'+timeLabel(pick[2])+' · '+pick[0]+' · '+(pick[3]||'Описание отсутствует'):'Выбранное время '+timeLabel(state.gridCursor));
    el.tvGridDetails.textContent=text;
  }
  function tvGridKey(code){
    if(code!==37)gridLeftAt=0;
    if(code===38)state.gridIndex=Math.max(0,state.gridIndex-1);
    else if(code===40)state.gridIndex=Math.min(state.gridChannels.length-1,state.gridIndex+1);
    else if(code===37){
      var pressedAt=Date.now();
      if(gridLeftAt&&pressedAt-gridLeftAt<=700){
        state.gridCursor=gridLeftOrigin;gridLeftAt=0;openTvGridGroups();return;
      }
      gridLeftOrigin=state.gridCursor;gridLeftAt=pressedAt;state.gridCursor-=30*60000;
    }
    else if(code===39)state.gridCursor+=30*60000;
    else if(code===13){
      var ch=state.gridChannels[state.gridIndex],rows=ch&&(gridGuideCache[ch.num-1]||guideCache[ch.num-1])||[];
      var selected=null;
      for(var i=0;i<rows.length;i++)if(rows[i][1]<=state.gridCursor&&rows[i][2]>state.gridCursor){selected=rows[i];break;}
      if(!ch)return;
      if(selected&&selected[2]<=Date.now()&&canArchive(ch,selected)){playArchivedProgramme(ch,selected);return;}
      if(!selected||selected[1]<=Date.now()){playChannel(ch.num-1);return;}
      toast('Будущую передачу пока нельзя воспроизвести');return;
    }
    if(state.gridCursor<state.gridStart+30*60000)state.gridStart-=60*60000;
    if(state.gridCursor>state.gridStart+210*60000)state.gridStart+=60*60000;
    renderTvGrid();
  }
  function goBack(){
    if(state.archiveLiveOpen){closeArchiveLiveInfo();return;}
    if(state.tvGridOpen&&state.gridGroupsOpen){closeTvGridGroups();return;}
    if(state.tvGridOpen){closeTvGrid();openRecent();return;}
    if(state.recentOpen){closeRecent();return;}
    if(state.quickMode){
      if(state.quickActionsOpen){closeQuickActions();var g=el.quickGroupList.querySelector('.quick-group-item.active')||el.quickGroupList.querySelector('button');if(g)g.focus();return;}
      if(state.quickGroupOpen){closeQuickGroups();quickFocusChannel();return;}
      var a=document.activeElement;
      if(a&&a.classList&&a.classList.contains('guide-day')){guideDateNavigate('left');return;}
      if(a&&a.hasAttribute&&a.hasAttribute('data-guide-index')){quickFocusChannel();return;}
      closeQuickBrowser();resetPlayerOSD();return;
    }
    if(state.settingsOpen){closeSettings();return;}
    if(state.playbackGuideOpen){closePlaybackGuide();resetPlayerOSD();return;}
    if(state.sidebarOpen){
      // While a channel is playing, BACK always closes the entire channel list.
      // Without playback, BACK also closes the menu rather than changing video.
      if(state.current<0&&!el.searchBox.classList.contains('hidden')){
        hide('searchBox');state.search='';el.searchInput.value='';render();return;
      }
      hideSidebar();resetPlayerOSD();return;
    }
    if(state.archiveSeekOpen){hideArchiveSeek();return;}
    if(!el.playerInfo.classList.contains('hidden')){resetPlayerOSD();return;}
    // No overlay: BACK does not open channels or stop the stream.
  }
  function onKey(e){
    var code=e.keyCode||e.which;
    if(code===461||code===10009||code===27||code===8&&!isEditing(e.target)){
      e.preventDefault();if(e.stopPropagation)e.stopPropagation();goBack();return;
    }
    if(isEditing(e.target)){
      if(code===13){e.preventDefault();e.target.blur();
        if(state.settingsOpen)el.saveSettings.focus();
        else if(e.target===el.searchInput)focusFirstChannel();}
      else if(code===38||code===40){e.preventDefault();
        if(state.settingsOpen)spatialFocus(code===38?'up':'down',e.target);
        else sidebarMove(code===38?'up':'down');}
      return;
    }
    if(state.settingsOpen){
      if(code===37||code===38||code===39||code===40){
        e.preventDefault();spatialFocus(code===37?'left':code===38?'up':code===39?'right':'down');}
      else if(code===13){e.preventDefault();if(document.activeElement&&document.activeElement.click)document.activeElement.click();}
      return;
    }
    if(state.archiveLiveOpen){
      if(code===37||code===38||code===39||code===40||code===13){
        e.preventDefault();if(code===13)el.archiveLiveGo.click();else el.archiveLiveGo.focus();
      }
      return;
    }
    if(state.tvGridOpen){if(code===37||code===38||code===39||code===40||code===13){
      e.preventDefault();if(state.gridGroupsOpen)tvGridGroupsKey(code);else tvGridKey(code);
    }return;}
    if(state.recentOpen){if(code===37||code===38||code===39||code===40||code===13){e.preventDefault();recentKey(code);}return;}
    if(state.quickMode&&state.sidebarOpen){
      if(code===37||code===38||code===39||code===40||code===13){e.preventDefault();quickKey(code);}return;
    }
    if(code===403||code===82){e.preventDefault();var focused=document.activeElement;
      var onList=state.sidebarOpen&&focused&&(focused.getAttribute('data-channel')||focused.getAttribute('data-favorite-channel'));
      toggleFavorite(onList?(+onList-1):state.current);return;}
    if(code===33||code===427){e.preventDefault();zap(1);return;}
    if(code===34||code===428){e.preventDefault();zap(-1);return;}
    if(code===405&&state.archive){e.preventDefault();backToLive();return;}
    if(code===457||code===73){e.preventDefault();if(!state.sidebarOpen){closePlaybackGuide();showPlayerOSD();return;}}
    if(code===13){
      e.preventDefault();
      if(state.archiveSeekOpen){archivePanelNavigation(code);return;}
      if(state.playbackGuideOpen){if(document.activeElement&&document.activeElement.click)document.activeElement.click();return;}
      if(!state.sidebarOpen){openQuickBrowser();return;} // OK: selected channel group (live and archive)
      if(document.activeElement&&document.activeElement.click)document.activeElement.click();
      return;
    }
    if((code>=48&&code<=57)||(code>=96&&code<=105)){
      if(state.sidebarOpen)return;
      channelNumber+=String.fromCharCode(code>=96?code-48:code);
      toast('Канал № '+channelNumber,1500);
      clearTimeout(numberTimer);
      numberTimer=setTimeout(function(){var n=+channelNumber;channelNumber='';
        if(n>0&&n<=state.channels.length)playChannel(n-1);else toast('Канал не найден');},1200);
      return;
    }
    if(code===37||code===38||code===39||code===40){
      e.preventDefault();
      if(!state.sidebarOpen){
        if(state.current<0){showSidebar();return;}
        if(state.archiveSeekOpen){archivePanelNavigation(code);return;}
        if(state.playbackGuideOpen){
          var act=document.activeElement;
          if(act&&act.classList&&act.classList.contains('guide-day')){
            guideDateNavigate(code===38?'up':code===40?'down':code===37?'left':'right');
          }else if(code===38||code===40){
            guideNavigate(code===38?'up':'down');
          }else if(code===37){
            focusGuideDateForSelectedProgramme();
          }
          // RIGHT from a programme keeps the programme/detail panel visible.
          // BACK is the only key that closes the full-screen guide.
          return;
        }
        if(code===38)openPlaybackGuide(); // Up: programme schedule of playing channel.
        else if(code===40){
          if(state.archive)openArchiveSeek(); // Archive: metadata, timeline, play/pause.
          else if(!el.zapCarousel.classList.contains('hidden'))showPlayerOSD(false); // First Down after channel zap: normal info, without carousel.
          else if(!el.playerInfo.classList.contains('hidden'))openRecent(); // Next Down: favorites, TV grid and recent channels.
          else showPlayerOSD(); // First Down: channel information.
        }
        else if(code===39)zap(1); // Right: next channel in playlist.
        else if(code===37)zap(-1); // Left: previous channel in playlist.
        return;
      }
      sidebarMove(code===37?'left':code===38?'up':code===39?'right':'down');
    }
  }
  function bind(){
    var ids=['video','idle','clock','sidebarHeadingText','guideNavHint','toast','loading','loadingText','sidebar','channelCount','playlistName','channels','groups','searchBox','searchInput','settingsModal','settingsTabPlaylists','settingsTabFonts','settingsPlaylistSection','settingsFontSection','playlistProfiles','playlistAdd','playlistDelete','playlistProfileNote','playlistFileNote','playlistFileInfo','fontControls','fontScene','resetFonts','remoteStatus','remoteQr','remoteAddress','remotePin','archiveSeek','archiveSeekTitle','archiveSeekPosition','archiveSeekBar','archiveSeekMarker','archiveSeekTrack','archiveSeekElapsed','archiveSeekTotal','archiveSeekClock','archiveSeekStatus','archiveSeekLogo','archiveSeekChannel','archiveSeekDescription','archiveSeekProgrammeTime','archivePlayPause','archivePlaySymbol','archivePlayLabel','archiveLiveDetails','archiveLiveButton','playlistUrl','epgUrl','playlistTitle','serviceStatus','epgStatus','epgDebug','playerInfo','zapCarousel','zapCarouselItems','playerName','playerEpg','playerNext','playerDescription','playerTimeline','playerTimelineElapsed','playerTimelineFill','playerTimelineTotal','playerTimelineRemaining','playerLogo','playerGroup','playerMode','playerResolution','playerBitrate','playerArchive','playerNetRx','playerNetTx','topline','guidePanel','guideLogo','guideName','guideRange','guideSelectedTime','guideSelectedTitle','guideSelectedDesc','guideRows','guideDates','quickGroupPanel','quickGroupList','quickActionsPanel','quickActionsList','quickActionSettings','quickActionReload','quickActionAll','quickActionFavorites','quickActionSearch','tvGridGroupsPanel','tvGridGroupsList','archiveLivePanel','archiveLiveLogo','archiveLiveChannel','archiveLiveGroup','archiveLiveNow','archiveLiveNext','archiveLiveTime','archiveLiveProgress','archiveLiveDescription','archiveLiveGo','recentPanel','recentLogo','recentTitle','recentNow','recentNext','recentClock','recentProgressFill','recentFavorite','recentGuide','recentChannels','tvGrid','tvGridGroup','tvGridTicks','tvGridRows','tvGridDetails','modeAll','modeFav','modeGroups','searchToggle','settingsButton','closeSettings','saveSettings','refreshEpg'];
    for(var i=0;i<ids.length;i++)el[ids[i]]=id(ids[i]);
    el.quickActionSettings.onclick=function(){quickActionSelect('settings');};
    el.quickActionReload.onclick=function(){quickActionSelect('reload');};
    el.quickActionAll.onclick=function(){quickActionSelect('all');};
    el.quickActionFavorites.onclick=function(){quickActionSelect('favorites');};
    el.quickActionSearch.onclick=function(){quickActionSelect('search');};
    el.archiveLiveGo.onclick=function(){closeArchiveLiveInfo();backToLive();};
    el.recentFavorite.onclick=function(){toggleFavorite(state.current);renderRecent();el.recentFavorite.focus();};
    el.recentGuide.onclick=openTvGrid;
    id('settingsButton').onclick=openSettings;id('closeSettings').onclick=closeSettings;
    el.settingsTabPlaylists.onclick=function(){showSettingsSection('playlists');el.settingsTabPlaylists.focus();};
    el.settingsTabFonts.onclick=function(){showSettingsSection('fonts');el.settingsTabFonts.focus();};
    el.playlistAdd.onclick=beginAddPlaylist;el.playlistDelete.onclick=removePlaylist;
    el.playlistFileInfo.onclick=function(){el.playlistFileNote.textContent='Выбери M3U-файл в браузере телефона или компьютера. Телевизор получит файл через локальную страницу и сохранит его в кэш.';if(el.remoteStatus)el.remoteStatus.scrollIntoView({block:'center'});};
    el.resetFonts.onclick=resetFonts;
    id('saveSettings').onclick=saveSettings;
    id('refreshEpg').onclick=function(){
      if(state.epgLoading){cancelEpg();return;}
      var typed=normalURL(el.epgUrl.value);
      if(!typed){toast('Укажи правильный URL EPG');return;}
      state.playlist.epg=typed;save();loadEpg(true,false);
    };
    id('reloadButton').title='Вручную обновить M3U с сервера';
    id('reloadButton').setAttribute('aria-label','Вручную обновить M3U с сервера');
    id('reloadButton').onclick=function(){loadPlaylist(false,true);};
    id('modeAll').onclick=function(){state.mode='all';state.groupsExpanded=false;render();focusFirstChannel();};
    id('modeFav').onclick=function(){state.mode='fav';state.groupsExpanded=false;render();if(state.visible.length)focusFirstChannel();else el.modeFav.focus();};
    id('modeGroups').onclick=function(){state.groupsExpanded=state.mode==='groups'?!state.groupsExpanded:true;state.mode='groups';render();
      if(state.groupsExpanded&&el.groups.firstChild)focusGroup(0);else el.modeGroups.focus();};
    id('searchToggle').onclick=function(){
      if(el.searchBox.classList.contains('hidden')){show('searchBox');el.searchInput.focus();}
      else{hide('searchBox');state.search='';el.searchInput.value='';render();id('searchToggle').focus();}
    };
    id('searchClear').onclick=function(){el.searchInput.value='';state.search='';render();el.searchInput.focus();};
    el.searchInput.oninput=function(){
      state.search=this.value;clearTimeout(searchTimer);
      searchTimer=setTimeout(function(){render();el.searchInput.focus();},130);
    };
    el.channels.addEventListener('scroll',function(){
      clearTimeout(renderScrollTimer);
      renderScrollTimer=setTimeout(function(){renderWindow(false);},35);
    });
    el.video.onclick=function(){if(state.sidebarOpen)hideSidebar();else showPlayerOSD();};
    el.video.addEventListener('loadedmetadata',function(){updatePlayerInfo();});
    el.video.addEventListener('resize',function(){updatePlayerInfo();});
    el.video.addEventListener('timeupdate',function(){if(state.archiveSeekOpen)updateArchiveSeek();});
    el.video.addEventListener('play',updateArchivePlayButton);
    el.video.addEventListener('pause',updateArchivePlayButton);
    el.archivePlayPause.onclick=toggleArchivePlayback;
    el.archiveLiveDetails.onclick=openArchiveLiveInfo;
    el.archiveLiveButton.onclick=backToLive;
    el.archiveSeekTrack.onclick=function(e){
      if(!state.archive||!state.archiveSeekOpen)return;
      // Pointer/magic-remote click moves preview only; the same 1s debounce applies.
      if(e&&typeof e.clientX==='number'&&e.clientX>0){
        var rect=this.getBoundingClientRect(),percent=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
        state.archiveSeekTarget=archiveClamp(Math.round(archiveLength()*percent));
        state.archiveSeekPending=true;clearTimeout(seekCommitTimer);
        seekCommitTimer=setTimeout(commitArchiveSeek,1000);updateArchiveSeek();resetArchiveHideTimer();
      }
      this.focus();
    };
    el.video.addEventListener('error',function(){
      var err=this.error;if(err)toast((state.archive?'Ошибка архивного потока после перехода: ':'Ошибка видео ')+err.code+': проверь формат потока или кодек.',5700);
    });
    window.addEventListener('keydown',onKey,true);
    updateClock();setInterval(function(){updateClock();if(state.current>=0&&!el.playerInfo.classList.contains('hidden'))updatePlayerInfo();if(state.archiveLiveOpen)updateArchiveLiveInfo();refreshTopline();},15000);
    setInterval(function(){if(state.current>=0)updatePlayerInfo();updateVisibleEpg();refreshEpgNow();},60000);
    // Sample only while the on-screen channel information window is visible.
    setInterval(function(){if(state.current>=0&&!el.playerInfo.classList.contains('hidden'))pollNetworkSpeed();},2000);
    holdGuideService();
    window.addEventListener('contextmenu',function(e){if(e.target!==el.video)e.preventDefault();});
  }
  function init(){
    bind();var old=safeStorageGet();
    restoreProfiles(old);
    state.fontSizes=old.fontSizes&&typeof old.fontSizes==='object'?old.fontSizes:{};
    applyFonts();
    if(old.favorites)state.favorites=old.favorites;
    if(Array.isArray(old.history))state.history=old.history.slice(0,20);
    var activeProfile=profileById(state.activePlaylistId);
    state.resumeKey=activeProfile&&activeProfile.lastKey||old.lastKey||'';
    state.resumeUrl=state.playlist.url;
    state.resumeIndex=(typeof old.last==='number'&&old.lastUrl===state.playlist.url)?old.last:-1;
    if(validPlaylistUrl(state.playlist.url))loadPlaylist(true);else{render();showSidebar();openSettings();}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
}());

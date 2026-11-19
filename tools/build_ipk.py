#!/usr/bin/env python3
"""Build LG webOS TV IPK in Debian ar format without external SDK dependencies."""
from pathlib import Path
import io, json, tarfile, time, shutil, hashlib

ROOT=Path(__file__).resolve().parents[1]
OUT=Path('/mnt/data')
APP_ID='com.steinus.perfecttvwebos'
SERVICE_ID=APP_ID+'.network'
VERSION='0.3.7'
NAME=APP_ID+'_'+VERSION+'_all.ipk'

app_files=['appinfo.json','index.html','app.js','styles.css','icon.png','largeIcon.png']
service_files=['package.json','services.json','service.js','cache.js','config-page.html','LICENSE-THIRD-PARTY']+['qr/'+p.name for p in sorted((ROOT/'service/qr').glob('*.js'))]+['qr/NOTICE.txt']
files={}
for fn in app_files:
    files['usr/palm/applications/'+APP_ID+'/'+fn]=(ROOT/'app'/fn).read_bytes()
for fn in service_files:
    files['usr/palm/services/'+SERVICE_ID+'/'+fn]=(ROOT/'service'/fn).read_bytes()
packageinfo={
    'app':APP_ID,'id':APP_ID,'loc_name':'Perfect TV Lite',
    'package_format_version':2,'vendor':'Community test build',
    'version':VERSION,'services':[SERVICE_ID]
}
files['usr/palm/packages/'+APP_ID+'/packageinfo.json']=(json.dumps(packageinfo,indent=2,ensure_ascii=False)+'\n').encode('utf-8')

ctrl=(f'Package: {APP_ID}\n'
      f'Version: {VERSION}\n'
      'Section: misc\nPriority: optional\nArchitecture: all\nOS: webos\n'
      f'Installed-Size: {(sum(map(len,files.values()))+1023)//1024}\n'
      'Maintainer: Community test build\n'
      'Description: Perfect TV Lite IPTV client for LG webOS TV\n'
      'webOS-Package-Format-Version: 2\nwebOS-Packager-Version: 3.0.5b38\n').encode()

def tar_gz(input_files):
    buff=io.BytesIO()
    with tarfile.open(fileobj=buff,mode='w:gz',format=tarfile.GNU_FORMAT,compresslevel=9) as tf:
        dirs={'.'}
        for fn in input_files:
            parts=fn.split('/')
            for i in range(1,len(parts)):
                dirs.add('/'.join(parts[:i]))
        for dn in sorted(dirs,key=lambda x:(x.count('/'),x)):
            info=tarfile.TarInfo('./' if dn=='.' else './'+dn)
            info.type=tarfile.DIRTYPE;info.mode=0o755;info.mtime=1700000000
            info.uid=info.gid=0;info.uname=info.gname='root'
            tf.addfile(info)
        for fn,content in sorted(input_files.items()):
            info=tarfile.TarInfo('./'+fn)
            info.size=len(content);info.mtime=1700000000
            info.mode=0o644;info.uid=info.gid=0;info.uname=info.gname='root'
            tf.addfile(info,io.BytesIO(content))
    return buff.getvalue()

def ar_member(name,data):
    if len(name)>15:raise ValueError('ar name too long')
    hdr=('%-16s%-12d%-6d%-6d%-8s%-10d`\n'%(name,1700000000,0,0,'100644',len(data))).encode('ascii')
    assert len(hdr)==60
    return hdr+data+(b'\n' if len(data)%2 else b'')

blob=(b'!<arch>\n'+ar_member('debian-binary',b'2.0\n')+
      ar_member('control.tar.gz',tar_gz({'control':ctrl}))+
      ar_member('data.tar.gz',tar_gz(files)))
path=OUT/NAME
path.write_bytes(blob)
print('Built',path,len(blob),'bytes')
print('SHA256',hashlib.sha256(blob).hexdigest())

# Built-in validation to detect missing or misplaced entries.
from subprocess import run, PIPE
result=run(['ar','t',str(path)],stdout=PIPE,check=True,text=True)
assert result.stdout.splitlines()==['debian-binary','control.tar.gz','data.tar.gz']
import subprocess
out=subprocess.check_output(['ar','p',str(path),'data.tar.gz'])
with tarfile.open(fileobj=io.BytesIO(out),mode='r:gz') as tf:
    for filename in files:
        got=tf.extractfile('./'+filename).read()
        assert got==files[filename],filename
    assert json.loads(tf.extractfile('./usr/palm/packages/'+APP_ID+'/packageinfo.json').read())['services']==[SERVICE_ID]
print('Validated:',len(files),'files in IPK including app, network service and packageinfo.')

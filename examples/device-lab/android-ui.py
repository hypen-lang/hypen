"""Drive the installed Gallery app and OS pickers; never replace device drivers."""
import sys, subprocess, re, json, time, os
from pathlib import Path
import xml.etree.ElementTree as ET

ADB = str(Path.home() / 'Library/Android/sdk/platform-tools/adb')
OUT = Path(__file__).parent / os.environ.get('DEVICE_LAB_RESULTS', 'results-2026-09-26')
OUT.mkdir(exist_ok=True)

def adb(*args):
    return subprocess.run([ADB, *args], check=True, capture_output=True, timeout=25).stdout

def snapshot(name='android-current'):
    adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/device-lab-ui.xml')
    xml = adb('shell', 'cat', '/sdcard/device-lab-ui.xml')
    (OUT / (name+'.xml')).write_bytes(xml)
    (OUT / 'screenshots').mkdir(exist_ok=True)
    (OUT / 'screenshots' / (name+'.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
    root = ET.fromstring(xml)
    rows = [{k:n.get(k) for k in ('text','content-desc','resource-id','bounds','clickable')} for n in root.iter('node') if n.get('text') or n.get('content-desc')]
    print(json.dumps(rows, ensure_ascii=False))
    return root

def tap(label, root=None):
    root = root if root is not None else ET.parse(OUT/'android-current.xml')
    matches = [n for n in root.iter('node') if label in (n.get('text'), n.get('content-desc'), n.get('resource-id'))]
    if len(matches) != 1: raise RuntimeError(f'Expected one match for {label}, got {len(matches)}')
    x1,y1,x2,y2=map(int,re.findall(r'\d+',matches[0].get('bounds')))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
    time.sleep(1)

if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'tap':
        root = ET.parse(OUT/'android-current.xml')
        matches = [n for n in root.iter('node') if sys.argv[2] in (n.get('text'), n.get('content-desc'), n.get('resource-id'))]
        if len(matches) != 1: raise RuntimeError(f'Expected one match, got {len(matches)}')
        x1,y1,x2,y2=map(int,re.findall(r'\d+',matches[0].get('bounds')))
        adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
    elif command == 'key': adb('shell','input','keyevent',sys.argv[2])
    elif command == 'text': adb('shell','input','text',sys.argv[2])
    elif command == 'open':
        from urllib.parse import quote
        url=f'ws://10.0.2.2:{sys.argv[2]}/ws?token=device-lab'
        adb('shell','am','start','-a','android.intent.action.VIEW','-d','hypenpreview://connect?url='+quote(url,safe=''),'space.hypen.gallery')
    elif command != 'snapshot': raise RuntimeError('Unknown command')
    time.sleep(0.5)
    snapshot()

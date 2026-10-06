import importlib, sys, time, json, contextlib
from urllib.parse import quote
from pathlib import Path
u=importlib.import_module('android-ui')

def run(port,name):
    evidence=[]
    def capture(step):
        root=u.snapshot('android-'+name+'-'+step)
        texts=[n.get('text') for n in root.iter('node') if n.get('text')]
        evidence.append({'step':step,'text':texts})
        (u.OUT/'android-current.xml').write_bytes((u.OUT/('android-'+name+'-'+step+'.xml')).read_bytes())
        return root
    url=f'ws://10.0.2.2:{port}/ws?token=device-lab'
    u.adb('shell','am','start','-a','android.intent.action.VIEW','-d','hypenpreview://connect?url='+quote(url,safe=''),'space.hypen.gallery')
    time.sleep(2);r=capture('connected')
    u.tap('Query camera',r);r=capture('query')
    u.tap('Pick photo',r);r=capture('gallery-picker')
    u.adb('shell','input','keyevent','4');time.sleep(1);r=capture('gallery-cancel')
    u.tap('Save 96K',r);r=capture('save-consent')
    u.tap('CONTINUE',r);r=capture('save-picker')
    u.tap('SAVE',r);r=capture('save-result')
    u.tap('Record 3s',r);r=capture('record-consent')
    if any(n.get('text')=='CONTINUE' for n in r.iter('node')):
        u.tap('CONTINUE',r);r=capture('record-started')
    if any(n.get('text')=='While using the app' for n in r.iter('node')):
        u.tap('While using the app',r);r=capture('record-permission')
    time.sleep(4);r=capture('record')
    u.tap('UI ping',r);r=capture('ping')
    (u.OUT/('android-'+name+'-evidence.json')).write_text(json.dumps(evidence,indent=2))
    return evidence

if __name__=='__main__':
    for port,name in [(int(sys.argv[1]),sys.argv[2])]:
        with open(u.OUT/('android-'+name+'-driver.log'),'w') as f,contextlib.redirect_stdout(f):
            results=run(port,name)
        for row in results:print(row['step'], ' | '.join(row['text'][-6:]))

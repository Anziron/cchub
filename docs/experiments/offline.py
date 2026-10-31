import sys,os,time,subprocess,signal
ROOT=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,ROOT); sys.argv=['x']
from harness import *
mnt,flag=os.environ['MNT'],os.environ['FLAG']
hasres=lambda o:o.get('type')=='user' and isinstance(o['message'].get('content'),list) and any(b.get('type')=='tool_result' for b in o['message']['content'])
s=Sess('off',cwd=mnt)
s.user('Use the Bash tool exactly once in the foreground to run: cat a.txt . Then reply OK.')
r=s.until(lambda o:isperm(o) or isres(o),90)
if r and isperm(r): s.allow(r,run_in_background=False); s.until(isres,60)
log('baseline',short(tool_results(s.out)[-1:],160))
open(flag,'w').close(); T=time.time(); log('frozen')
time.sleep(2); s.user('Use the Bash tool exactly once in the foreground to run: cat b.txt . Then reply with its content or the error.')
def stepf(o):
    if isperm(o): log('perm while frozen',round(time.time()-T,1)); s.allow(o,run_in_background=False); return False
    return hasres(o) or isres(o)
e=s.until(stepf,170); log('tool result at',round(time.time()-T,1),short(tool_results(s.out)[-1:],260) if e else 'NONE')
log('procs',subprocess.run("ps -eo stat,args | grep -E '[c]at b.txt' | cut -c1-40",shell=True,capture_output=True,text=True).stdout.strip()[:200],'unit',s.active())
if e is None:
    t=time.time(); s.send({'type':'control_request','request_id':'int1','request':{'subtype':'interrupt'}})
    i=s.until(lambda o:o.get('type')=='control_response' or isres(o),30); log('interrupt resp at',round(time.time()-t,1),short(i,170))
    i=s.until(isres,30); log('interrupt result at',round(time.time()-t,1),bool(i))
    log('D-state',subprocess.run("ps -eo stat,args | awk '$1 ~ /^D/' | cut -c1-60",shell=True,capture_output=True,text=True).stdout.strip()[:200])
# cold start in the dead cwd
t=time.time(); c=Sess('cold',cwd=mnt); c.user('Reply with just PONG.'); x=c.until(isres,40); log('cold start in frozen cwd',round(time.time()-t,1),bool(x),'unit',c.active(),'err',open(c.d+'/err').read()[:120])
os.remove(flag); t=time.time(); log('unfrozen at',round(time.time()-T,1))
e2=s.until(isres,120); log('after unfreeze: pending result at',round(time.time()-t,1),bool(e2))
s.user('Use the Bash tool exactly once in the foreground to run: cat c.txt . Then reply OK.')
r=s.until(lambda o:isperm(o) or isres(o),90)
if r and isperm(r): s.allow(r,run_in_background=False); e=s.until(isres,120)
log('recovery',round(time.time()-t,1),short(tool_results(s.out)[-1:],160),'unit',s.active())
x=c.until(isres,30); log('cold after unfreeze',bool(x),'unit',c.active())
c.stop(); s.stop()

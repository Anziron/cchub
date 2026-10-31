import sys,os,time
ROOT=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,ROOT); sys.argv=['x']
from harness import *
mnt,flag=os.environ['MNT'],os.environ['FLAG']
s=Sess('react',cwd=mnt)
import threading
s.user('Use the Bash tool once in the foreground to run: python3 w.py . Then tell me in one sentence whether big.bin is complete and what you would do next.')
T=time.time(); timer=[None]
def freeze():
    open(flag,'w').close(); log('frozen',round(time.time()-T,1))
def step(o):
    if isperm(o):
        s.allow(o,run_in_background=False)
    if o.get('type')=='assistant' and any(b.get('type')=='tool_use' for b in o['message']['content']) and not timer[0]:
        timer[0]=threading.Timer(5,freeze); timer[0].start()
    return isres(o)
r=s.until(step,170); log('turn end',round(time.time()-T,1),bool(r))
for b in tool_results(s.out): log('tool',str(b.get('content'))[:230],b.get('is_error'))
log('model says:',short(r and r.get('result'),360))
if os.path.exists(flag): os.remove(flag)
s.stop()

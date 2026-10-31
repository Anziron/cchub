import sys,os,json,glob,time,shutil
ROOT=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,ROOT); sys.argv=['x']
import harness as H
from harness import *
H.BASE[:]=[a for a in H.BASE if a!='--no-session-persistence']
s=Sess('cli'); 
def turn(t,to=60):
    s.user(t); seen=[]
    r=s.until(lambda o:(seen.append(o) or False) or isres(o) or isperm(o),to)
    return r,seen
r,e=turn('Reply with just OK.'); sid=r['session_id']; print('base',short(r.get('result'),40),[o['message'].get('model') for o in e if o.get('type')=='assistant'][:1],flush=True)
def jc(): 
    f=glob.glob(f'/root/.claude/projects/*/{sid}.jsonl')[0]; L=[json.loads(l) for l in open(f)]
    return f,L
s.send({'type':'control_request','request_id':'m1','request':{'subtype':'set_model','model':'sonnet'}})
x=s.until(lambda o:o.get('type')=='control_response',20); print('set_model',short(x,200),flush=True)
r,e=turn('Reply with just OK.'); print('after set_model',[o['message'].get('model') for o in e if o.get('type')=='assistant'][:1],short(r and r.get('result'),30),flush=True)
for cmd in ['/model haiku','/config','/context','/usage']:
    n0=len(jc()[1]); t=time.time(); r,e=turn(cmd,40)
    n1=len(jc()[1]) if True else 0
    f,L=jc(); added=L[n0:]
    print(cmd,'->',round(time.time()-t,1),'s type',r and r.get('type'),'subtype',r and r.get('subtype'),'text',short(r and r.get('result'),110) if r and isres(r) else short(r,160),flush=True)
    print('   events',[o.get('type') for o in e][:8],'jsonl+',[(o.get('type'),str((o.get('message') or {}).get('content'))[:50]) for o in added if o.get('type') in('user','assistant')][:3],flush=True)
    if r and isperm(r): s.allow(r)
r,e=turn('Reply with just OK.',40); print('final model',[o['message'].get('model') for o in e if o.get('type')=='assistant'][:1],flush=True)
r,e=turn('What was the last slash command I ran, if you can see any? Answer in ten words.',40); print('sees commands:',short(r and r.get('result'),120),flush=True)
s.stop(); f,_=jc(); os.remove(f); d=os.path.dirname(f); shutil.rmtree(d); print('cleaned',flush=True)

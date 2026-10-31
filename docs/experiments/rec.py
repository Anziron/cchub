import sys,os,json,glob,time,subprocess
ROOT=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,ROOT); sys.argv=['x']
import harness as H
from harness import *
H.BASE[:]=[a for a in H.BASE if a!='--no-session-persistence']
base=list(H.BASE)
H.BASE.append('--include-partial-messages')
def turn(s,t):
    s.user(t)
    while True:
        r=s.until(lambda o:isperm(o) or isres(o),120)
        if not r or isres(r): return r
        s.allow(r)
def stats(p):
    L=[l for l in open(p) if l.strip()]; O=[json.loads(l) for l in L]; c={}
    for o,l in zip(O,L):
        k=o.get('type'); e=c.setdefault(k,[0,0]); e[0]+=1; e[1]+=len(l)
    return O,c
s=Sess('rec'); r=turn(s,'Use the Bash tool once to run: echo hi . Then write a 150 word paragraph about rivers.'); time.sleep(1)
O,c=stats(s.out); sid=next(o['session_id'] for o in O if o.get('session_id')); log('stream by type',c)
f=glob.glob(f'/root/.claude/projects/*/{sid}.jsonl'); log('jsonl found',len(f))
J=[json.loads(l) for l in open(f[0]) if l.strip()]; jt={}
for o in J: jt[o.get('type')]=jt.get(o.get('type'),0)+1
log('jsonl types',jt)
su={o['uuid'] for o in O if o.get('uuid') and o.get('type') in('assistant','user')}; ju={o['uuid'] for o in J if o.get('uuid') and o.get('type') in('assistant','user')}
log('uuid stream',len(su),'jsonl',len(ju),'common',len(su&ju))
sm={(o['message'].get('id')) for o in O if o.get('type')=='assistant'}; jm={(o['message'].get('id')) for o in J if o.get('type')=='assistant'}
log('assistant message.id stream',len(sm),'jsonl',len(jm),'common',len(sm&jm))
st=[(b.get('tool_use_id')) for o in O if o.get('type')=='user' and isinstance(o['message'].get('content'),list) for b in o['message']['content'] if b.get('type')=='tool_result']
jtr=[(b.get('tool_use_id')) for o in J if o.get('type')=='user' and isinstance(o['message'].get('content'),list) for b in o['message']['content'] if b.get('type')=='tool_result']
log('tool_result ids equal',st==jtr,len(st))
s.stop(); time.sleep(1); log('jsonl bytes',os.path.getsize(f[0]),'out bytes',os.path.getsize(s.out))
H.BASE[:]=base+['--resume',sid]
t=time.time(); s2=Sess('rec2'); r=turn(s2,'What command did I ask you to run earlier? Reply with just the command.'); log('resume with fifo',round(time.time()-t,1),short(r and r.get('result'),80))
O2,_=stats(s2.out); log('same session',any(o.get('session_id')==sid for o in O2),'replayed history lines',sum(1 for o in O2 if o.get('type')=='assistant'))
s2.stop(); time.sleep(1); log('session files for sid',len(glob.glob(f'/root/.claude/projects/*/{sid}*')))
for p in glob.glob(f'/root/.claude/projects/*/{sid}.jsonl'):
    log('removing own test session',os.path.basename(os.path.dirname(p))[-30:]); os.remove(p)

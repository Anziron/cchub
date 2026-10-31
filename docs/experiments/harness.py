import json,os,subprocess,sys,time,signal
ROOT=os.path.dirname(os.path.abspath(__file__))
BASE=['claude','-p','--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio','--model','haiku','--no-session-persistence']
def log(*a): print(*a,flush=True)
def short(o,n=420):
    s=json.dumps(o,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'
class Sess:
    def __init__(s,name,mode='default',cwd=None):
        s.name=name; s.d=f'{ROOT}/{name}'; subprocess.run(['rm','-rf',s.d]); os.makedirs(s.d)
        s.fifo=s.d+'/in'; s.out=s.d+'/out'; os.mkfifo(s.fifo); open(s.out,'w').close(); s.pos=0;s.buf=''; s.hold=os.open(s.fifo,os.O_RDWR)
        s.unit='cchub-exp-'+name
        cmd=' '.join(BASE+['--permission-mode',mode])
        env=[f'-E{k}={os.environ[k]}' for k in ('PATH','HOME') ]
        subprocess.run(['systemd-run','-q','--collect','--unit='+s.unit,'-p','WorkingDirectory='+(cwd or s.d),*env,'/bin/sh','-c',f'exec {cmd} <>{s.fifo} >>{s.out} 2>>{s.d}/err'],check=True)
    def fd(s): return os.open(s.fifo,os.O_RDWR)
    def send(s,o):
        f=s.fd(); os.write(f,(json.dumps(o)+'\n').encode()); os.close(f)
    def user(s,t): s.send({'type':'user','message':{'role':'user','content':t}})
    def events(s):
        with open(s.out) as f:
            f.seek(s.pos); d=f.read(); s.pos=f.tell()
        s.buf+=d; *ls,s.buf=s.buf.split('\n')
        for l in ls:
            if l.strip(): yield json.loads(l)
    def until(s,pred,timeout=120):
        t=time.time()
        while time.time()-t<timeout:
            for o in s.events():
                if s.hold is not None: os.close(s.hold); s.hold=None
                if pred(o): return o
            time.sleep(.1)
        log('TIMEOUT',s.name); return None
    def allow(s,req,**over):
        i=dict(req['request'].get('input',{})); i.update(over)
        s.send({'type':'control_response','response':{'subtype':'success','request_id':req['request_id'],'response':{'behavior':'allow','updatedInput':i}}})
    def active(s): return subprocess.run(['systemctl','is-active',s.unit],capture_output=True,text=True).stdout.strip()
    def stop(s):
        subprocess.run(['systemctl','stop',s.unit],capture_output=True)
isperm=lambda o:o.get('type')=='control_request' and o['request'].get('subtype')=='can_use_tool'
isres=lambda o:o.get('type')=='result'
def tool_results(path):
    return [b for o in map(json.loads,filter(str.strip,open(path))) if o.get('type')=='user' and isinstance(o['message'].get('content'),list) for b in o['message']['content'] if b.get('type')=='tool_result']

def survive():
    s=Sess('survive'); s.send({'type':'control_request','request_id':'i1','request':{'subtype':'initialize'}})
    fake=subprocess.Popen([sys.executable,'-I','-c',"import os,time,sys;f=os.open(sys.argv[1],os.O_RDWR);r=open(sys.argv[2]);time.sleep(9999)",s.fifo,s.out])
    s.user('Use the Bash tool exactly once to run: sleep 25; echo done > marker1 . Then reply OK.')
    r=s.until(isperm); log('perm',short(r)); s.allow(r,run_in_background=False); time.sleep(3)
    fake.send_signal(signal.SIGKILL); fake.wait(); log('fake hubd killed; unit',s.active(),'marker',os.path.exists(s.d+'/marker1'))
    t=time.time(); r=s.until(isres,90); log('turn ended after kill',round(time.time()-t,1),'marker',os.path.exists(s.d+'/marker1'),'is_error',r and r.get('is_error'))
    s.user('Use the Bash tool exactly once to run: echo two > marker2 . Then reply OK.')
    r=s.until(isperm); log('perm arrives with no hubd; waiting 10s'); time.sleep(10); s.allow(r); r=s.until(isres); log('reattach ok','marker2',os.path.exists(s.d+'/marker2'),'unit',s.active()); s.stop()

def baseline():
    d=ROOT+'/pipe'; subprocess.run(['rm','-rf',d]); os.makedirs(d)
    code='''import subprocess,sys,json,time
p=subprocess.Popen(sys.argv[1:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
print(p.pid,flush=True)
p.stdin.write((json.dumps({"type":"user","message":{"role":"user","content":"Use the Bash tool exactly once to run: sleep 20; echo done > marker1 . Then reply OK."}})+"\\n").encode());p.stdin.flush()
for l in p.stdout:
    o=json.loads(l)
    if o.get("type")=="control_request":
        p.stdin.write((json.dumps({"type":"control_response","response":{"subtype":"success","request_id":o["request_id"],"response":{"behavior":"allow","updatedInput":o["request"]["input"]}}})+"\\n").encode());p.stdin.flush()
        time.sleep(3);print("ready",flush=True);time.sleep(9999)
'''
    f=subprocess.Popen([sys.executable,'-I','-c',code]+BASE+['--permission-mode','default'],cwd=d,stdout=subprocess.PIPE,text=True)
    pid=int(f.stdout.readline()); f.stdout.readline(); f.kill(); f.wait(); t=time.time()
    alive=lambda:os.path.exists(f'/proc/{pid}')
    log('pipe mode: parent killed, claude alive',alive())
    while alive() and time.time()-t<45: time.sleep(1)
    log('pipe mode: claude alive after',round(time.time()-t),'s:',alive(),'marker',os.path.exists(d+'/marker1'))
    if alive(): os.kill(pid,9)

def ask():
    s=Sess('ask'); s.user('Call the AskUserQuestion tool once with one question "Pick a color" and options Red and Blue. After the answer, reply with just the chosen color.')
    r=s.until(isperm,90); log('ASK req',short(r,1200))
    q=r['request']['input']['questions'][0]['question']
    s.allow(r,answers={q:'Blue'}); e=s.until(isres,90); log('ASK result',short(e and e.get('result'))); log('ASK tool_result',short(tool_results(s.out)[-1:],500)); s.stop()

def plan():
    s=Sess('plan','plan'); s.user('Plan only: creating a file hello.txt. Immediately call ExitPlanMode with a one line plan, without any other tool.')
    p=lambda o:isperm(o) and o['request']['tool_name']=='ExitPlanMode'
    r=s.until(p,120); log('PLAN req1',short(r,500))
    s.send({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':{'behavior':'deny','message':'Plan rejected: use name hi.txt instead'}}})
    r=s.until(lambda o:p(o) or isres(o),90); log('PLAN after deny',short(r,300)); log('PLAN deny tool_result',short(tool_results(s.out)[-1:],300))
    if r and isperm(r):
        s.allow(r); e=s.until(lambda o:isres(o) or isperm(o),90); log('PLAN after allow',short(e,300)); log('PLAN allow tool_result',short(tool_results(s.out)[-1:],400))
    s.stop()

def deny():
    s=Sess('deny'); s.user('Use the Bash tool exactly once to run: echo x > marker . If it is refused, do not retry; reply REFUSED.')
    r=s.until(isperm); log('DENY suggestions',short(r['request'].get('permission_suggestions'),400))
    s.send({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':{'behavior':'deny','message':'not now'}}})
    e=s.until(isres,90); log('DENY text',short(e and e.get('result'),120),'marker',os.path.exists(s.d+'/marker')); log('DENY tool_result',short(tool_results(s.out)[-1:],300)); s.stop()

def interrupt():
    s=Sess('intr'); s.user('Use the Bash tool exactly once in the foreground to run: python3 long59.py . Then reply OK.'); open(s.d+'/long59.py','w').write("import time; time.sleep(59); open('marker','w').close()\n")
    r=s.until(lambda o:isperm(o) or isres(o),100); log('INT first',short(r,250))
    if not isperm(r): s.stop(); return
    s.allow(r,run_in_background=False); time.sleep(4); log('INT sleep running',subprocess.run(['pgrep','-f','long59.py'],capture_output=True,text=True).stdout.split()); t=time.time()
    s.send({'type':'control_request','request_id':'int1','request':{'subtype':'interrupt'}})
    seen=[]
    def stop(o):
        if o.get('type') in('control_response','result','user'): log('INT ev',round(time.time()-t,1),short(o,330))
        return isres(o)
    e=s.until(stop,40); log('INT done',round(time.time()-t,1),'marker',os.path.exists(s.d+'/marker'))
    log('INT sleep leftover',subprocess.run(['pgrep','-f','long59.py'],capture_output=True,text=True).stdout.split(),'unit',s.active())
    s.user('Reply with just the word PONG.'); e=s.until(isres,60); log('INT followup',short(e and e.get('result'),60)); s.stop()

for n in sys.argv[1:]:
    log('=====',n)
    try: globals()[n]()
    except Exception as x: log('ERR',n,repr(x))

import socket,threading,os,sys,time
host=sys.argv[1]; flag=sys.argv[2]
l=socket.socket(); l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); l.bind(('127.0.0.1',2299)); l.listen(8)
def pump(a,b):
    while True:
        while os.path.exists(flag): time.sleep(.2)
        try: d=a.recv(65536)
        except OSError: break
        if not d: break
        while os.path.exists(flag): time.sleep(.2)
        try: b.sendall(d)
        except OSError: break
    for x in (a,b):
        try:x.shutdown(2)
        except OSError:pass
while True:
    c,_=l.accept()
    while os.path.exists(flag): time.sleep(.2)
    u=socket.create_connection((host,22))
    threading.Thread(target=pump,args=(c,u),daemon=True).start(); threading.Thread(target=pump,args=(u,c),daemon=True).start()

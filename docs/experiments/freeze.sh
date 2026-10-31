#!/bin/bash
# 用单独的测试挂载验证：断网时探测不会被缓存骗过，以及写到一半断网的后果。
S=${S:?请设置 S 为实验目录，里面要有 exp/fwd.py 和构建好的 work/target/debug/hubd}
H=$S/work/target/debug/hubd; M=$S/offmnt2; F=$S/frozen; K=$S/kh2
IP=$(awk -F'\t' '$1=="pc-home"{print $2}' /etc/cc/devices.tsv); U=$(awk -F'\t' '$1=="pc-home"{print $3}' /etc/cc/devices.tsv)
rm -f $F $S/dd.rc; : > $K; mkdir -p $M; cd $S/exp
python3 -I fwd.py $IP $F & FW=$!
timeout 1 tail -f /dev/null
sshfs -p 2299 -o IdentityFile=/root/.ssh/id_ed25519_hub,BatchMode=yes,UserKnownHostsFile=$K,StrictHostKeyChecking=accept-new,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,kernel_cache,dir_cache=yes,dcache_timeout=120,entry_timeout=120,attr_timeout=120,max_conns=4,idmap=user "$U@127.0.0.1:/D:/frame/buspi/cchub/.cc/offline-test" $M; echo mount=$?
bgprobe(){ $H --probe $M & P=$!; s=$SECONDS; for i in $(seq 1 7); do kill -0 $P 2>/dev/null || break; timeout 1 tail -f /dev/null; done
  if kill -0 $P 2>/dev/null; then echo "$1: hung after $((SECONDS-s))s; state=$(awk '{print $3}' /proc/$P/stat)"; kill -9 $P; timeout 1 tail -f /dev/null; echo "  after SIGKILL state=$(awk '{print $3}' /proc/$P/stat 2>/dev/null || echo gone)"; else wait $P; echo "$1: rc=$? $((SECONDS-s))s"; fi; }
stat -c 'warm a.txt size=%s' $M/a.txt; bgprobe online
touch $F; echo "--- A idle freeze"
timeout 4 stat -c 'cached stat ok size=%s' $M/a.txt; echo "stat rc=$?"
bgprobe frozen-idle
rm -f $F; s=$SECONDS; for i in $(seq 1 90); do timeout 6 $H --probe $M && { echo "recovered +$((SECONDS-s))s"; break; }; done
echo "--- B write interrupted"
(dd if=/dev/zero of=$M/big.bin bs=1M count=200 2>$S/dd.err; echo "dd rc=$?" > $S/dd.rc) & DD=$!
timeout 2 tail -f /dev/null; touch $F; echo frozen-mid-write
s=$SECONDS; for i in $(seq 1 75); do kill -0 $DD 2>/dev/null || break; timeout 1 tail -f /dev/null; done; echo "dd after +$((SECONDS-s))s: $(cat $S/dd.rc 2>/dev/null || echo still-running)"; tail -1 $S/dd.err | cut -c1-90
rm -f $F; s=$SECONDS; for i in $(seq 1 60); do kill -0 $DD 2>/dev/null || break; timeout 1 tail -f /dev/null; done; echo "after unfreeze +$((SECONDS-s))s: $(cat $S/dd.rc 2>/dev/null || echo still-running)"; timeout 20 ls -la $M/big.bin 2>&1 | cut -c14-70
fusermount -uz $M; kill $FW; wait $FW 2>/dev/null; rm -f $K; echo mounts=$(mount | grep -c offmnt2)

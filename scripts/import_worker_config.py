#!/usr/bin/env python3
"""Secret-safe HA Supervisor option importer."""
import argparse, base64, json, os, pathlib, socket, ssl, struct, tempfile
from dataclasses import dataclass
from urllib.parse import urlparse

class ImportError(RuntimeError): pass
PAIR=(("kamino","KAMINO_INDEXER_TOKEN","OBSERVATION_HUB_TOKEN"),("onre","ONRE_INDEXER_TOKEN","OBSERVATION_HUB_TOKEN"),("velocity","VELOCITY_INDEXER_TOKEN","OBSERVATION_HUB_TOKEN"),("squads","SQUADS_INDEXER_TOKEN","KELVARA_OBSERVATION_HUB_TOKEN"))
VELOCITY_PROGRAM='vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P'; VELOCITY_QUOTE='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
def parse_env(text):
    return {k:v for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#') and '=' in line for k,v in [line.split('=',1)]}
def render_env(values): return ''.join(f'{k}={v}\n' for k,v in values.items())
def _required(o,s,k):
    v=o.get(s,{}).get(k)
    if not isinstance(v,str) or not v.strip(): raise ImportError(f'missing:{s}:{k}')
    return v
def import_options(options,existing):
    values=parse_env(existing); status={}; active_tokens={}; active_sources={}
    onre_idle=(options.get('onre',{}).get('TARGETS_JSON','[]')=='[]'
               and not (options.get('onre',{}).get('SOLANA_RPC_PRIMARY') or '').strip())
    squads=options.get('squads',{})
    squads_enabled=all((squads.get(k) or '').strip()
                        for k in ('SQUADS_SUBJECT_ADDRESS','SQUADS_MULTISIG_ADDRESS'))
    inactive={'onre': onre_idle, 'squads': not squads_enabled}
    for worker,hub_key,worker_key in PAIR:
        if inactive.get(worker):
            values.pop(f'INDEXER_{worker.upper()}_TOKEN',None)
            continue
        hub=_required(options,'hub',hub_key); value=_required(options,worker,worker_key)
        if hub != value: raise ImportError(f'mismatch:{worker}')
        status[f'{worker}_pair_equal']=True; values[f'INDEXER_{worker.upper()}_TOKEN']=value
        indexer_id=f'{worker}-mainnet'; active_tokens[indexer_id]=value; active_sources[indexer_id]=indexer_id
    values['INDEXER_TOKENS_JSON']=json.dumps(active_tokens,separators=(',',':'))
    values['OBSERVATION_PRODUCER_SOURCES_JSON']=json.dumps(active_sources,separators=(',',':'))
    for scope,key,default in [('kamino','TARGETS_JSON',None),('onre','TARGETS_JSON','[]')]:
        raw=options.get(scope,{}).get(key,default)
        try:
            parsed=json.loads(raw)
            if not isinstance(parsed,list) or (scope=='kamino' and not parsed): raise ValueError
        except Exception: raise ImportError(f'invalid:{scope}:{key}') if raw else ImportError(f'missing:{scope}:{key}')
        values[f'{scope.upper()}_TARGETS_JSON']=raw
    status['onre_idle']=json.loads(values['ONRE_TARGETS_JSON'])==[] and not (options.get('onre',{}).get('SOLANA_RPC_PRIMARY') or '').strip()
    values['VELOCITY_PROGRAM_ID']=VELOCITY_PROGRAM; values['QUOTE_MINT_ADDRESS']=VELOCITY_QUOTE; values['SOLANA_RPC_URL']=_required(options,'velocity','SOLANA_RPC_URL')
    squads=options.get('squads',{}); enabled=all((squads.get(k) or '').strip() for k in ('SQUADS_SUBJECT_ADDRESS','SQUADS_MULTISIG_ADDRESS')); status['squads_enabled']=enabled
    if not enabled:
        values.update(SQUADS_SUBJECT_ADDRESS='',SQUADS_MULTISIG_ADDRESS='')
    return Result(render_env(values),status,'mapped keys; pair booleans only')
@dataclass
class Result: text:str; status:dict; diagnostic:str
def _exact(source,n):
    data=b''
    while len(data)<n:
        part=source.read(n-len(data))
        if not part: raise ImportError('websocket_closed')
        data+=part
    return data
def _frame(source):
    a,b=_exact(source,2); n=b&127
    if n==126:n=struct.unpack('!H',_exact(source,2))[0]
    elif n==127:n=struct.unpack('!Q',_exact(source,8))[0]
    mask=_exact(source,4) if b&128 else b''; p=_exact(source,n)
    return a&15, bytes(x^mask[i%4] for i,x in enumerate(p)) if mask else p
def _send(sock,obj):
    p=json.dumps(obj,separators=(',',':')).encode(); m=os.urandom(4); n=len(p)
    h=bytes([0x81])+((bytes([0x80|n]) if n<126 else bytes([0xFE])+struct.pack('!H',n)) if n<=65535 else bytes([0xFF])+struct.pack('!Q',n))
    sock.sendall(h+m+bytes(x^m[i%4] for i,x in enumerate(p)))
def _recv(source,sock):
    fragments=[]
    while True:
        op,p=_frame(source)
        if op==9:_send_control(sock,10,p); continue
        if op==8: raise ImportError('websocket_closed')
        if op in (1,0): fragments.append(p)
        if op in (1,2) or (op==0 and fragments):
            return json.loads(b''.join(fragments))
def _send_control(sock,op,p): sock.sendall(bytes([0x80|op,0x80|len(p)])+ (m:=os.urandom(4))+bytes(x^m[i%4] for i,x in enumerate(p)))
def _ws_request(url,token,endpoint):
    u=urlparse(url if '://' in url else 'http://'+url); scheme={'http':'ws','https':'wss','ws':'ws','wss':'wss'}.get(u.scheme)
    if not scheme: raise ImportError('invalid_hass_url')
    host=u.hostname; port=u.port or (443 if scheme=='wss' else 80); raw=socket.create_connection((host,port),timeout=10)
    if scheme=='wss': raw=ssl.create_default_context().wrap_socket(raw,server_hostname=host)
    source=raw.makefile('rb'); key=base64.b64encode(os.urandom(16)).decode(); raw.sendall((f'GET /api/websocket HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    status=source.readline()
    while source.readline() not in (b'\r\n',b'\n',b''): pass
    if b' 101 ' not in status: raise ImportError('websocket_handshake_failed')
    _recv(source,raw); _send(raw,{'type':'auth','access_token':token})
    if _recv(source,raw).get('type')!='auth_ok': raise ImportError('ha_auth_failed')
    _send(raw,{'id':1,'type':'supervisor/api','endpoint':endpoint,'method':'get'}); result=_recv(source,raw); raw.close()
    if not result.get('success'): raise ImportError('supervisor_read_failed')
    return result.get('result',{}).get('options',{})
def load_credentials():
    token=os.environ.get('HASS_TOKEN'); url=os.environ.get('HASS_URL','http://homeassistant.local:8123')
    if not token:
        p=pathlib.Path.home()/'.hermes/.env'
        if p.exists(): e=parse_env(p.read_text()); token=e.get('HASS_TOKEN'); url=e.get('HASS_URL',url)
    if not token: raise ImportError('missing_hass_credentials')
    return token,url
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--env-file',default='.env'); ap.add_argument('--output',default='.env');
    for n,d in [('hub','kelvara_observation_hub'),('kamino','kelvara_indexer_kamino'),('onre','kelvara_indexer_onre'),('velocity','kelvara_indexer_velocity'),('squads','kelvara_indexer_squads')]: ap.add_argument('--'+n+'-slug',default=d)
    a=ap.parse_args(); token,url=load_credentials(); scopes={n:_ws_request(url,token,f'/addons/local_{getattr(a,n+"_slug")}/info') for n in ('hub','kamino','onre','velocity','squads')}; src=pathlib.Path(a.env_file); result=import_options(scopes,src.read_text() if src.exists() else '')
    dst=pathlib.Path(a.output); dst.parent.mkdir(parents=True,exist_ok=True); fd,tmp=tempfile.mkstemp(dir=dst.parent,prefix=f'.{dst.name}.',text=True); os.fchmod(fd,0o600)
    with os.fdopen(fd,'w') as f: f.write(result.text); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,dst); print(json.dumps({'status':result.status,'keys':sorted(parse_env(result.text))},separators=(',',':')))
if __name__=='__main__':
    try: main()
    except ImportError as e: print(f'import failed: {e}',file=__import__('sys').stderr); raise SystemExit(1)

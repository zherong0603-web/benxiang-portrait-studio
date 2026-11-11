#!/usr/bin/env python3
"""New creation API against disposable loopback D1/R2. Samples are test fixtures, not generated output."""
import json, sys, uuid, urllib.request, urllib.error, urllib.parse
from pathlib import Path
base=sys.argv[1].rstrip('/')
u=urllib.parse.urlparse(base)
if u.scheme!='http' or u.hostname not in ('127.0.0.1','localhost') or u.username or u.password or u.path or u.query or u.fragment:raise SystemExit('Loopback origin required')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None
http=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
owner='creation-http-'+str(uuid.uuid4()); other=owner+'-other'; passed=[]
def call(path,method='GET',data=None,actor=owner,headers=None):
 h={'Origin':base}
 if actor:h.update({'oai-authenticated-user-id':actor,'oai-authenticated-user-email':actor+'@fixture.invalid'})
 if isinstance(data,dict):data=json.dumps(data).encode();h['Content-Type']='application/json'
 if headers:h.update(headers)
 try:
  with http.open(urllib.request.Request(base+path,method=method,data=data,headers=h),timeout=40) as r:raw=r.read();status=r.status
 except urllib.error.HTTPError as e:raw=e.read();status=e.code
 try:result=json.loads(raw)
 except (ValueError,UnicodeError):result=raw
 return status,result
def check(name,reply,status):
 assert reply[0]==status,(name,reply[0],reply[1]);passed.append(name);return reply[1]
def upload(path,filename):
 boundary='portrait'+uuid.uuid4().hex
 fields={'consentVersion':'portrait-consent-v1','sourceNote':'HTTP regression fixture; not generated image or likeness evidence'}
 body=b''
 for k,v in fields.items():body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
 content=(Path(__file__).resolve().parents[2]/'public/samples'/filename).read_bytes()
 body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: image/webp\r\n\r\n'.encode()+content+f'\r\n--{boundary}--\r\n'.encode()
 return call(path,'POST',body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
try:
 check('creation authentication',call('/api/creations',actor=None),401)
 initial=check('creation list',call('/api/creations'),200)
 assert not initial['sessions'] and not initial['capability']['configured']
 refs=[]
 for i,name in enumerate(['business.webp','elegant.webp','editorial.webp']):
  # Deliberately distinct fictional samples exercise storage only, not multi-image identity.
  photo=check('reference upload '+str(i+1),upload('/api/studio',name),201)['photo']
  refs.append({'id':photo['id'],'role':'anchor' if i==0 else 'angle'})
 payload={'idempotencyKey':str(uuid.uuid4()),'variant':'A','styleIds':['blue-business','warm-editorial'],'countPerStyle':1,'references':refs,'consentVersion':'portrait-consent-v1'}
 check('foreign references rejected',call('/api/creations','POST',payload,other),400)
 session=check('session persisted',call('/api/creations','POST',payload),201)['session'];sid=session['id'];path='/api/creations/'+sid
 assert len(session['jobs'])==2 and len(session['slots'])==2 and session['expectedCount']==2
 assert all(not any(k in slot for k in ['prompt','promptVersion','photography']) for slot in session['slots'])
 assert all(not any(k in job for k in ['prompt','frozenPrompts']) for job in session['jobs'])
 retry=check('session retry idempotent',call('/api/creations','POST',payload),201)['session'];assert retry['id']==sid
 check('same key changed input conflicts',call('/api/creations','POST',{**payload,'countPerStyle':2}),409)
 check('foreign session inaccessible',call(path,actor=other),404)
 check('cross-site mutation denied',call(path,'POST',{'action':'cancel'},headers={'Origin':'https://other.invalid'}),403)
 check('provider disabled honestly',call(path,'POST',{'action':'queue'}),503)
 restored=check('session restored',call(path),200)['session'];assert [s['id'] for s in restored['slots']]==[s['id'] for s in session['slots']]
 assert all(not any(k in slot for k in ['prompt','promptVersion','photography']) for slot in restored['slots'])
 check('unauthenticated worker denied',call('/api/generation/worker','POST',{'action':'claim'},actor=None),503)
 jid=session['jobs'][0]['id']
 imported=check('existing real import retained',upload('/api/jobs/'+jid+'/results','business.webp'),201)['job']
 rid=imported['results'][0]['id']
 after=check('manual output appears in creation',call(path),200)['session'];assert rid in [r['id'] for r in after['results']]
 check('choice saved',call(path,'POST',{'action':'choice','assetId':rid,'revealed':True,'favorite':True,'selected':True}),200)
 result=next(r for r in check('choice survives refresh',call(path),200)['session']['results'] if r['id']==rid)
 assert result['revealed'] and result['favorite'] and result['selected']
 check('foreign choice denied',call(path,'POST',{'action':'choice','assetId':rid,'favorite':True},other),404)
 check('real private result download',call('/api/assets/'+rid+'?download=1'),200)
 check('foreign download denied',call('/api/assets/'+rid,actor=other),404)
 check('cancel durable',call(path,'POST',{'action':'cancel'}),200)
 assert check('cancel survives refresh',call(path),200)['session']['status']=='cancelled'
 check('delete session',call(path,'DELETE'),200)
 check('deleted session unavailable',call(path),404)
 check('deleted result unavailable',call('/api/assets/'+rid),404)
finally:
 check('all fixtures removed',call('/api/studio','DELETE',{'confirm':'DELETE_ALL'}),200)
print(json.dumps({'passed':len(passed),'checks':passed},ensure_ascii=False,indent=2))

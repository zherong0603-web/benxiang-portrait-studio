#!/usr/bin/env python3
"""Isolated local-only integration checks. Test assets are deleted at completion."""
import json,urllib.request,urllib.error,uuid,sys,io,zipfile,time
from pathlib import Path
base=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4173'
if urllib.parse.urlparse(base).hostname not in ('127.0.0.1','localhost','terminal.local'):raise SystemExit('Local test URLs only')
owner='portrait-test-'+str(uuid.uuid4());other=owner+'-other';passed=[]
def request(path,method='GET',data=None,who=owner,extra=None,restart_retries=0):
 original_data=data
 h={}
 if who:h.update({'oai-authenticated-user-id':who,'oai-authenticated-user-email':who+'@sites.test'})
 if isinstance(data,dict):data=json.dumps(data).encode();h['Content-Type']='application/json'
 if extra:h.update(extra)
 req=urllib.request.Request(base+path,data=data,headers=h,method=method)
 try:
  with urllib.request.urlopen(req,timeout=40) as r:raw=r.read();status=r.status
 except urllib.error.HTTPError as e:
  raw=e.read();status=e.code
  # The local Wrangler runtime can restart during a rapid sequence. Retry only
  # the idempotent delivery-state action, never image uploads.
  if status==503 and b'worker restarted mid-request' in raw and isinstance(original_data,dict) and original_data.get('action')=='complete' and restart_retries<2:
   time.sleep(.3);return request(path,method,original_data,who,extra,restart_retries+1)
 try:return status,json.loads(raw)
 except:return status,raw

def expect(name,status,result,code):
 assert status==code,(name,status,result);passed.append(name);return result

def upload(path,file='elegant.webp',who=owner):
 boundary='portrait-'+str(uuid.uuid4());content=(Path(__file__).resolve().parents[2]/'public/samples'/file).read_bytes()
 raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="consentVersion"\r\n\r\nportrait-consent-v1\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.webp"\r\nContent-Type: image/webp\r\n\r\n'.encode()+content+f'\r\n--{boundary}--\r\n'.encode())
 return request(path,'POST',raw,who,{'Content-Type':'multipart/form-data; boundary='+boundary})

try:
 s,r=request('/api/studio',who=None);expect('anonymous collection denied',s,r,401)
 s,r=request('/api/skill',who=None);expect('anonymous Skill denied',s,r,401)
 s,r=request('/api/studio');expect('empty owner collection',s,r,200);assert r['jobs']==[] and r['photos']==[] and not r['provider']['configured']
 s,r=upload('/api/studio');photo=expect('private photo upload',s,r,201)['photo']
 s,r=request(photo['url']);expect('owner photo read',s,r,200);assert isinstance(r,bytes)
 s,r=request(photo['url'],who=None);expect('anonymous photo denied',s,r,401)
 s,r=request(photo['url'],who=other);expect('other owner photo denied',s,r,404)
 payload={'consentVersion':'portrait-consent-v1','idempotencyKey':str(uuid.uuid4()),'title':'Integration test','styleId':'blue-elegant','count':1,'references':[{'id':photo['id'],'role':'anchor'}],'notes':'Natural smile'}
 s,r=request('/api/studio','POST',payload,extra={'Origin':'https://untrusted.invalid'});expect('cross-origin mutation denied',s,r,403)
 s,r=request('/api/studio','POST',{**payload,'references':[{'id':photo['id'],'role':'angle'}]});expect('identity anchor required',s,r,400)
 s,r=request('/api/studio','POST',{**payload,'count':13});expect('output count bounded',s,r,400)
 s,r=request('/api/studio','POST',payload,who=other);expect('foreign reference denied',s,r,400)
 s,r=request('/api/studio','POST',payload);job=expect('persisted job creation',s,r,201)['job'];jid=job['id'];assert job['status']=='ready' and len(job['references'])==1 and not job['results']
 s,r=request('/api/studio','POST',payload);expect('idempotent task retry',s,r,201);assert r['job']['id']==jid
 s,r=request('/api/studio');expect('state readback',s,r,200);assert len(r['jobs'])==1
 s,r=request('/api/studio',who=other);expect('owner collection isolation',s,r,200);assert r['jobs']==[] and r['photos']==[]
 s,r=request('/api/jobs/'+jid+'/export',who=other);expect('foreign export denied',s,r,404)
 s,r=request('/api/jobs/'+jid+'/export');expect('owned task export closed',s,r,403)
 s,r=request('/api/jobs/'+jid,'POST',{'action':'generate'});expect('unconfigured generator honest',s,r,503)
 s,r=request('/api/jobs/'+jid,'POST',{'action':'complete'});expect('empty task cannot deliver',s,r,409)
 s,r=request(photo['url'],'DELETE');expect('referenced original retained',s,r,409)
 s,r=upload('/api/jobs/'+jid+'/results');j=expect('real result import',s,r,201)['job'];rid=j['results'][0]['id'];resultUrl=j['results'][0]['url'];assert j['status']=='review' and j['results'][0]['source']=='manual'
 s,r=upload('/api/jobs/'+jid+'/results');expect('result count bounded',s,r,409)
 s,r=request('/api/jobs/'+jid,'POST',{'action':'complete'});expect('unreviewed output cannot deliver',s,r,409)
 s,r=request('/api/jobs/'+jid+'/results','PATCH',{'resultId':rid,'qa':'accepted'},who=other);expect('foreign review denied',s,r,404)
 s,r=request('/api/jobs/'+jid+'/results','PATCH',{'resultId':rid,'qa':'accepted'});expect('individual review saved',s,r,200)
 s,r=request('/api/jobs/'+jid,'POST',{'action':'complete'});j=expect('reviewed task delivered',s,r,200)['job'];assert j['status']=='completed'
 s,r=request('/api/jobs/'+jid+'/results','PATCH',{'resultId':rid,'qa':'rejected'});expect('delivered review immutable',s,r,409)
 s,r=request('/api/jobs/'+jid,'POST',{'action':'revise','notes':'Retain face proportions','idempotencyKey':str(uuid.uuid4())});revision=expect('versioned revision',s,r,201)['job'];assert revision['parent_id']==jid and revision['status']=='ready' and revision['references']==j['references'] and not revision['results']
 s,r=request('/api/skill');expect('customer Skill export is closed',s,r,403)
 s,r=request('/api/jobs/'+jid,'DELETE');expect('job and results deletion',s,r,200)
 s,r=request(resultUrl);expect('deleted result unavailable',s,r,404)
 s,r=request(photo['url']);expect('original retained after job deletion',s,r,200)
finally:
 s,r=request('/api/studio','DELETE',{'confirm':'DELETE_ALL'});expect('account-wide cleanup',s,r,200)
 if 'photo' in locals():
  s,r=request(photo['url']);expect('deleted original unavailable',s,r,404)
print(json.dumps({'passed':len(passed),'checks':passed},ensure_ascii=False,indent=2))

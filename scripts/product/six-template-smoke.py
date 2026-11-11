#!/usr/bin/env python3
"""Isolated local HTTP checks. Fictional fixtures prove storage/flow, never likeness or new generation."""
import hashlib, json, sys, uuid, urllib.request, urllib.error, urllib.parse
from pathlib import Path

base = sys.argv[1].rstrip('/')
origin = urllib.parse.urlsplit(base)
if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or origin.path or origin.query or origin.fragment or origin.username or origin.password:
    raise SystemExit('Only a loopback origin is accepted')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
owner = 'six-http-' + uuid.uuid4().hex
other = owner + '-other'
passed = []
root = Path(__file__).resolve().parents[2]
sample = (root / 'public/samples/six-v1/F02.jpg').read_bytes()

def call(path, method='GET', data=None, actor=owner, extra=None):
    headers = {'Origin': base}
    if actor:
        headers.update({'oai-authenticated-user-id': actor, 'oai-authenticated-user-email': actor + '@fixture.invalid'})
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if extra:
        headers.update(extra)
    try:
        with http.open(urllib.request.Request(base + path, method=method, data=data, headers=headers), timeout=40) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        raw = json.loads(raw)
    except (ValueError, UnicodeError):
        pass
    return status, raw

def expect(name, reply, status):
    assert reply[0] == status, (name, reply)
    passed.append(name)
    return reply[1]

def upload(path):
    boundary = 'six' + uuid.uuid4().hex
    note = 'Engineering fixture: fictional sample; no new model request and no likeness acceptance.'
    fields = {'consentVersion': 'portrait-consent-v1', 'sourceNote': note}
    body = b''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode() for key, value in fields.items())
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fictional-fixture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
    body += sample + f'\r\n--{boundary}--\r\n'.encode()
    return call(path, 'POST', body, extra={'Content-Type': 'multipart/form-data; boundary=' + boundary})

try:
    expect('home points to original experience', call('/', actor=None), 307)
    for variant in 'ABCD':
        page = expect('experience ' + variant + ' URL returns shared initial SSR (hydrated layout unverified)', call('/experience?v=' + variant), 200)
        assert isinstance(page, bytes) and b'F02' in page
    expect('legacy studio remains reachable', call('/studio'), 200)
    for code in ['M01', 'M02', 'M03', 'F01', 'F02', 'F04']:
        image = expect('fictional sample served ' + code, call('/samples/six-v1/' + code + '.jpg', actor=None), 200)
        assert image == (root / ('public/samples/six-v1/' + code + '.jpg')).read_bytes()
    expect('private creations require login', call('/api/creations', actor=None), 401)
    initial = expect('generation remains disabled', call('/api/creations'), 200)
    assert initial['capability']['configured'] is False
    photo = expect('original upload saved privately', upload('/api/studio'), 201)['photo']
    expect('other user cannot read original', call(photo['url'], actor=other), 404)
    for count in [1, 2, 3]:
        codes = ['F02', 'F01', 'F04'][:count]
        payload = {'idempotencyKey': str(uuid.uuid4()), 'variant': 'D', 'styleIds': codes, 'countPerStyle': 1,
                   'references': [{'id': photo['id'], 'role': 'anchor'}], 'consentVersion': 'portrait-consent-v1'}
        session = expect(f'{count} style session persisted', call('/api/creations', 'POST', payload), 201)['session']
        sid = session['id']
        path = '/api/creations/' + sid
        assert session['expectedCount'] == count and len(session['slots']) == count
        assert all(not any(k in slot for k in ['prompt', 'promptVersion', 'photography']) for slot in session['slots'])
        assert all(not any(k in job for k in ['prompt', 'frozenPrompts']) for job in session['jobs'])
        retried = expect(f'{count} style idempotent retry', call('/api/creations', 'POST', payload), 201)['session']
        assert retried['id'] == sid
        expect(f'{count} style changed retry conflicts', call('/api/creations', 'POST', {**payload, 'notes': 'changed'}), 409)
        expect(f'{count} style foreign access denied', call(path, actor=other), 404)
        expect(f'{count} style unconfigured start is honest', call(path, 'POST', {'action': 'queue'}), 503)
        for position, job in enumerate(session['jobs'][:2]):
            jid = job['id']
            expect(f'{count} style export closed {position}', call('/api/jobs/' + jid + '/export'), 403)
            expect(f'{count} style empty delivery rejected {position}', call('/api/jobs/' + jid, 'POST', {'action': 'complete'}), 409)
            imported = expect(f'{count} style explicit fixture import {position}', upload('/api/jobs/' + jid + '/results'), 201)['job']
            result = imported['results'][0]
            assert result['source'] == 'manual' and 'Engineering fixture' in result['source_note']
            expect(f'{count} style unreviewed delivery rejected {position}', call('/api/jobs/' + jid, 'POST', {'action': 'complete'}), 409)
            expect(f'{count} style fixture review {position}', call(path, 'POST', {'action': 'review', 'assetId': result['id'], 'qa': 'accepted', 'note': 'Storage test fixture only; not a likeness decision.'}), 200)
            expect(f'{count} style fixture delivery {position}', call('/api/jobs/' + jid, 'POST', {'action': 'complete'}), 200)
            expect(f'{count} style choice saved {position}', call(path, 'POST', {'action': 'choice', 'assetId': result['id'], 'revealed': True, 'favorite': True, 'selected': True}), 200)
            raw = expect(f'{count} style private download {position}', call(result['url'] + '?download=1'), 200)
            assert hashlib.sha256(raw).digest() == hashlib.sha256(sample).digest()
            expect(f'{count} style foreign download denied {position}', call(result['url'], actor=other), 404)
            expect(f'{count} style anonymous download denied {position}', call(result['url'], actor=None), 401)
        restored = expect(f'{count} style refresh restores exact session', call(path), 200)['session']
        assert restored['styleIds'] == codes and [s['id'] for s in restored['slots']] == [s['id'] for s in session['slots']]
        assert all(not any(k in slot for k in ['prompt', 'promptVersion', 'photography']) for slot in restored['slots'])
        assert all(r['selected'] and r['favorite'] and r['revealed'] for r in restored['results'])
        if count < 3:
            assert restored['status'] == 'completed' and len(restored['results']) == count
        else:
            assert restored['status'] != 'completed' and len(restored['results']) == 2
            expect('three style partial session cancels durably', call(path, 'POST', {'action': 'cancel'}), 200)
            assert expect('cancel status survives reload', call(path), 200)['session']['status'] == 'cancelled'
        expect(f'{count} style private group deletion', call(path, 'DELETE'), 200)
        expect(f'{count} style deleted group unavailable', call(path), 404)
        for result in restored['results']:
            expect(f'{count} style deleted bytes inaccessible ' + result['id'], call(result['url']), 404)
    for bad in [[], ['F02'] * 2, ['F02', 'blue-business'], ['M01', 'M02', 'F01', 'F02']]:
        expect('invalid selection rejected ' + repr(bad), call('/api/creations', 'POST', {**payload, 'idempotencyKey': str(uuid.uuid4()), 'styleIds': bad}), 400)
finally:
    expect('isolated fixture account cleaned', call('/api/studio', 'DELETE', {'confirm': 'DELETE_ALL'}), 200)
print(json.dumps({'passed': len(passed), 'checks': passed, 'scope': 'engineering fixtures, no payment or model call'}, ensure_ascii=False, indent=2))

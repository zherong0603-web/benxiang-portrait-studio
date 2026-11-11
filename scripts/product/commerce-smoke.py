#!/usr/bin/env python3
"""Local HTTP/D1/R2 regression, with no real or simulated successful payment.

Run against an isolated Wrangler runtime, never a deployed Site:
  PORTRAIT_SMOKE_OPERATOR=portrait-test-operator python3 scripts/product/commerce-smoke.py http://127.0.0.1:4173

Runtime requirements: COMMERCE_MODE=test, a valid nonempty COMMERCE_CATALOG_JSON,
COMMERCE_OPERATOR_IDS containing PORTRAIT_SMOKE_OPERATOR, and no payment keys.
The platform identity headers are local test fixtures, not production login proof.
Style samples exercise bytes/storage only; they are not generated portraits or
evidence of identity consistency. Verified-paid fulfillment is tested separately
with explicit domain SQL fixtures, not by a pretend HTTP payment-success route.
"""

import io
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path


CONSENT = 'portrait-consent-v1'
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4173'
parsed = urllib.parse.urlparse(BASE)
if (parsed.scheme not in ('http', 'https') or
        parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or
        parsed.username or parsed.password or parsed.path not in ('', '/') or
        parsed.query or parsed.fragment):
    raise SystemExit('Only an explicit loopback origin is allowed; no deployed URLs, credentials, or path prefixes.')
BASE = BASE.rstrip('/')
OPERATOR = os.environ.get('PORTRAIT_SMOKE_OPERATOR', 'portrait-test-operator')
OWNER = 'portrait-commerce-smoke-' + str(uuid.uuid4())
OTHER = OWNER + '-other'
if OPERATOR in (OWNER, OTHER):
    raise SystemExit('Operator fixture must be a distinct identity.')
PASSED = []
SAMPLE = (Path(__file__).resolve().parents[2] / 'public/samples/elegant.webp').read_bytes()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Disable environment proxies as well as redirects: every request stays loopback.
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


@dataclass
class Reply:
    status: int
    data: object
    headers: dict


def request(path, method='GET', data=None, who=OWNER, extra=None):
    if not path.startswith('/') or path.startswith('//') or urllib.parse.urlsplit(path).scheme:
        raise AssertionError('Only relative local API paths may be requested')
    headers = {}
    if who:
        headers.update({'oai-authenticated-user-id': who,
                        'oai-authenticated-user-email': who + '@sites.test'})
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if extra:
        headers.update(extra)
    for attempt in range(3):
        req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with HTTP.open(req, timeout=40) as response:
                raw, status = response.read(), response.status
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as error:
            raw, status = error.read(), error.code
            response_headers = {key.lower(): value for key, value in error.headers.items()}
        # Re-loader retries are read-only. Never retry an upload after an unknown outcome.
        if method == 'GET' and status == 503 and b'worker restarted mid-request' in raw and attempt < 2:
            time.sleep(0.25)
            continue
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            body = raw
        return Reply(status, body, response_headers)
    raise AssertionError('Unreachable request retry state')


def expect(name, reply, status):
    if reply.status != status:
        detail = repr(reply.data)[:1200]
        raise AssertionError(f'{name}: expected HTTP {status}, received {reply.status}: {detail}')
    PASSED.append(name)
    return reply.data


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    PASSED.append(name)


def upload(path, who=OWNER, consent=CONSENT, content=SAMPLE, mime='image/webp', source=None):
    boundary = 'portrait-commerce-' + str(uuid.uuid4())
    pieces = []
    fields = {'consentVersion': consent, 'sourceNote': source}
    for key, value in fields.items():
        if value is not None:
            pieces.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode())
    extension = 'png' if mime == 'image/png' else 'webp'
    pieces.extend([(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="local-fixture.{extension}"\r\nContent-Type: {mime}\r\n\r\n').encode(), content,
                   (f'\r\n--{boundary}--\r\n').encode()])
    return request(path, 'POST', b''.join(pieces), who,
                   {'Content-Type': 'multipart/form-data; boundary=' + boundary})


def png(width, height):
    """A valid, very compressible RGB PNG for declared-dimension rejection tests."""
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
    compressor = zlib.compressobj()
    row = b'\x00' + b'\x00\x00\x00' * width
    compressed = []
    for _ in range(height):
        compressed.append(compressor.compress(row))
    compressed.append(compressor.flush())
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', b''.join(compressed)) + chunk(b'IEND', b''))


def payload(photo, count=1, title='Local smoke task'):
    return {'idempotencyKey': str(uuid.uuid4()), 'title': title, 'styleId': 'blue-elegant',
            'count': count, 'references': [{'id': photo['id'], 'role': 'anchor'}],
            'notes': 'Fictional sample fixture; this is not a generated quality evaluation.',
            'consentVersion': CONSENT}


def create_job(photo, count=1, title='Local smoke task', who=OWNER):
    body = payload(photo, count, title)
    result = expect(title + ' persisted', request('/api/studio', 'POST', body, who), 201)['job']
    return result, body


def cleanup_identity(who, name):
    result = expect(name + ' account cleanup', request('/api/studio', 'DELETE', {'confirm': 'DELETE_ALL'}, who), 200)
    check(name + ' cleanup has explicit storage outcome', isinstance(result.get('cleanupPending'), bool))
    expect(name + ' cleanup retry endpoint', request('/api/privacy/cleanup', 'POST', who=who), 200)
    state = expect(name + ' state after cleanup', request('/api/studio', who=who), 200)
    check(name + ' has no remaining photos/jobs/pending files',
          state['photos'] == [] and state['jobs'] == [] and state['privacy']['pendingDeletions'] == 0)


def run():
    expect('anonymous studio denied', request('/api/studio', who=None), 401)
    expect('anonymous orders denied', request('/api/orders', who=None), 401)
    expect('anonymous cleanup denied', request('/api/privacy/cleanup', 'POST', who=None), 401)
    state = expect('fresh isolated owner', request('/api/studio'), 200)
    check('fresh owner has no state and no automatic generator',
          state['photos'] == [] and state['jobs'] == [] and state['provider']['configured'] is False)
    listing = expect('commerce configuration read', request('/api/orders'), 200)
    check('runtime is explicitly test mode', listing['commerce']['mode'] == 'test')
    check('payment channel is disabled; no provider requests will be made', listing['commerce']['configured'] is False)
    check('runtime has a real configured test catalog', isinstance(listing['catalog'], list) and bool(listing['catalog']))
    selected = min(listing['catalog'], key=lambda package: package['count'])
    terms = listing['commerce']['termsVersion']
    operator_listing = expect('configured operator can read fulfillment queue', request('/api/orders?scope=operator', who=OPERATOR), 200)
    check('operator fixture is configured as operator', operator_listing['commerce']['operator'] is True)
    expect('customer cannot enumerate operator queue', request('/api/orders?scope=operator'), 403)

    expect('upload without photo consent rejected', upload('/api/studio', consent=None), 400)
    expect('outdated photo consent rejected', upload('/api/studio', consent='outdated'), 400)
    expect('single-side dimension over 8192 rejected', upload('/api/studio', content=png(8193, 1), mime='image/png'), 400)
    expect('canvas over 24 megapixels rejected', upload('/api/studio', content=png(6000, 4001), mime='image/png'), 400)
    expect('MIME content mismatch rejected', upload('/api/studio', content=png(1, 1), mime='image/webp'), 400)
    state = expect('rejected uploads have no saved records', request('/api/studio'), 200)
    check('rejected uploads did not create photos', not state['photos'])
    photo = expect('authorized private reference upload', upload('/api/studio'), 201)['photo']
    read = request(photo['url'])
    expect('owner reference bytes readable', read, 200)
    check('reference remains private and non-sniffable', read.headers.get('cache-control') == 'private, no-store' and read.headers.get('x-content-type-options') == 'nosniff')
    expect('anonymous private image denied', request(photo['url'], who=None), 401)
    expect('other customer private image denied', request(photo['url'], who=OTHER), 404)
    expect('unpaid operator private image denied', request(photo['url'], who=OPERATOR), 404)
    other_photo = expect('other customer private upload', upload('/api/studio', who=OTHER), 201)['photo']

    missing_consent = payload(photo)
    missing_consent.pop('consentVersion')
    expect('job without consent rejected', request('/api/studio', 'POST', missing_consent), 400)
    invalid_anchor = payload(photo)
    invalid_anchor['references'][0]['role'] = 'angle'
    expect('job requires identity anchor', request('/api/studio', 'POST', invalid_anchor), 400)
    expect('foreign reference cannot create task', request('/api/studio', 'POST', payload(photo), OTHER), 400)
    expect('cross-origin mutation denied', request('/api/studio', 'POST', payload(photo), extra={'Origin': 'https://untrusted.invalid'}), 403)
    free, free_payload = create_job(photo, title='Original manual path')
    free_id = free['id']
    retried = expect('manual task creation idempotent', request('/api/studio', 'POST', free_payload), 201)['job']
    check('manual retry preserved identity and snapshot', retried['id'] == free_id and retried['references'] == free['references'])
    expect('empty manual task cannot complete', request('/api/jobs/' + free_id, 'POST', {'action': 'complete'}), 409)
    expect('unconfigured generation stays unavailable', request('/api/jobs/' + free_id, 'POST', {'action': 'generate'}), 503)
    expect('referenced photo cannot be removed', request(photo['url'], 'DELETE'), 409)
    exported = expect('owned task export closed', request('/api/jobs/' + free_id + '/export'), 403)
    check('export refusal exposes no snapshot', 'prompt' not in exported and 'references' not in exported)
    expect('foreign prompt export denied', request('/api/jobs/' + free_id + '/export', who=OTHER), 404)
    expect('manual result without consent rejected', upload('/api/jobs/' + free_id + '/results', consent=None), 400)
    source_note = 'Local regression fixture, fictional style sample; not AI quality evidence.'
    imported = expect('original manual result import preserved', upload('/api/jobs/' + free_id + '/results', source=source_note), 201)['job']
    result = imported['results'][0]
    check('import provenance retained', imported['status'] == 'review' and result['source'] == 'manual' and result['source_note'] == source_note)
    expect('manual result count bounded', upload('/api/jobs/' + free_id + '/results'), 409)
    expect('unreviewed manual result cannot complete', request('/api/jobs/' + free_id, 'POST', {'action': 'complete'}), 409)
    expect('other user cannot mark QA', request('/api/jobs/' + free_id + '/results', 'PATCH', {'resultId': result['id'], 'qa': 'accepted'}, OTHER), 404)
    expect('manual per-image QA preserved', request('/api/jobs/' + free_id + '/results', 'PATCH', {'resultId': result['id'], 'qa': 'accepted'}), 200)
    completed = expect('original manual completion preserved', request('/api/jobs/' + free_id, 'POST', {'action': 'complete'}), 200)['job']
    check('manual completion is not a paid order', completed['status'] == 'completed' and not completed.get('commerce'))
    download = request(result['url'] + '?download=1')
    expect('private result download', download, 200)
    check('download bytes equal imported fixture', download.data == SAMPLE)
    check('download headers protect and attach image', download.headers.get('content-type') == 'image/webp' and download.headers.get('content-disposition', '').startswith('attachment;') and download.headers.get('cache-control') == 'private, no-store' and download.headers.get('x-content-type-options') == 'nosniff')
    expect('completed manual QA immutable', request('/api/jobs/' + free_id + '/results', 'PATCH', {'resultId': result['id'], 'qa': 'rejected'}), 409)
    revision = expect('original revision creates immutable new task', request('/api/jobs/' + free_id, 'POST', {'action': 'revise', 'notes': 'Local revision test', 'idempotencyKey': str(uuid.uuid4()), 'consentVersion': CONSENT}), 201)['job']
    check('revision retains identity without copying outputs', revision['parent_id'] == free_id and revision['references'] == completed['references'] and not revision['results'])
    skill = request('/api/skill')
    expect('customer Skill export is closed', skill, 403)
    check('closed Skill export has no ZIP download header', not skill.headers.get('content-disposition') and 'zip' not in skill.headers.get('content-type', ''))

    commercial, _ = create_job(photo, selected['count'], 'Commercial order snapshot')
    other_job, _ = create_job(other_photo, selected['count'], 'Other customer isolation', OTHER)
    order_input = {'jobId': commercial['id'], 'packageId': selected['id'], 'idempotencyKey': str(uuid.uuid4()), 'termsVersion': terms}
    expect('order requires current terms', request('/api/orders', 'POST', {**order_input, 'termsVersion': 'old'}), 400)
    expect('order cannot use foreign task', request('/api/orders', 'POST', {**order_input, 'jobId': other_job['id']}), 404)
    expect('finished manual task cannot become order', request('/api/orders', 'POST', {**order_input, 'jobId': free_id}), 409)
    order = expect('test order created from configured catalog', request('/api/orders', 'POST', {**order_input, 'amountMinor': 1, 'paymentStatus': 'paid'}), 201)['order']
    order_id = order['id']
    check('server ignores client amount and paid claims', order['mode'] == 'test' and order['amountMinor'] == selected['amountMinor'] and order['paymentStatus'] == 'unpaid' and order['fulfillmentStatus'] == 'awaiting_payment' and order['paidAt'] is None)
    retry = expect('commercial creation retry idempotent', request('/api/orders', 'POST', order_input), 201)['order']
    check('commercial retry returned same order', retry['id'] == order_id)
    expect('same idempotency key cannot change job', request('/api/orders', 'POST', {**order_input, 'jobId': free_id}), 409)
    expect('duplicate order for same job rejected', request('/api/orders', 'POST', {**order_input, 'idempotencyKey': str(uuid.uuid4())}), 409)
    expect('other customer cannot read order', request('/api/orders/' + order_id, who=OTHER), 404)
    expect('operator cannot read unpaid customer order', request('/api/orders/' + order_id, who=OPERATOR), 404)
    expect('operator cannot start unpaid customer order', request('/api/orders/' + order_id, 'POST', {'action': 'start'}, OPERATOR), 404)
    expect('operator cannot deliver unpaid customer order', request('/api/orders/' + order_id, 'POST', {'action': 'deliver'}, OPERATOR), 404)
    expect('customer cannot start commercial fulfillment', request('/api/orders/' + order_id, 'POST', {'action': 'start'}), 403)
    expect('customer cannot claim commercial paid', request('/api/orders/' + order_id, 'POST', {'action': 'paid'}), 400)
    expect('customer cannot import commercial results before payment', upload('/api/jobs/' + commercial['id'] + '/results'), 403)
    expect('operator cannot import unpaid customer results', upload('/api/jobs/' + commercial['id'] + '/results', who=OPERATOR), 404)
    expect('commercial manual completion cannot bypass order delivery', request('/api/jobs/' + commercial['id'], 'POST', {'action': 'complete'}), 409)
    expect('active unpaid order task cannot be deleted', request('/api/jobs/' + commercial['id'], 'DELETE'), 409)
    expect('checkout without provider keys is unavailable', request('/api/orders/' + order_id + '/checkout', 'POST'), 503)
    after_checkout = expect('order read after disabled checkout', request('/api/orders/' + order_id), 200)
    assert 'prompt' not in after_checkout['job'] and 'frozenPrompts' not in after_checkout['job']
    check('disabled checkout did not imply payment or fulfillment', after_checkout['order']['paymentStatus'] == 'unpaid' and after_checkout['order']['paidAt'] is None and after_checkout['order']['fulfillmentStatus'] == 'awaiting_payment' and after_checkout['job']['commerce']['canFulfill'] is False)
    operator_queue = expect('operator queue after unpaid order', request('/api/orders?scope=operator', who=OPERATOR), 200)
    check('unpaid customer order absent from operator queue', all(item['id'] != order_id for item in operator_queue['orders']))
    cancelled = expect('unpaid test order cancellable', request('/api/orders/' + order_id, 'POST', {'action': 'cancel'}), 200)['order']
    check('cancellation remains nonpaid', cancelled['paymentStatus'] == 'cancelled' and cancelled['paidAt'] is None)
    restored = expect('manual import restored after order cancellation', upload('/api/jobs/' + commercial['id'] + '/results', source=source_note), 201)['job']
    restored_id = restored['results'][0]['id']
    expect('manual QA restored after cancellation', request('/api/jobs/' + commercial['id'] + '/results', 'PATCH', {'resultId': restored_id, 'qa': 'accepted'}), 200)
    removed = expect('cancelled order task deletable', request('/api/jobs/' + commercial['id'], 'DELETE'), 200)
    check('deletion reports storage cleanup outcome', isinstance(removed['cleanupPending'], bool))
    expect('deleted result immediately inaccessible', request(restored['results'][0]['url']), 404)
    expect('cleanup is repeatable', request('/api/privacy/cleanup', 'POST'), 200)
    cancelled_readback = expect('cancelled order retained without removed task', request('/api/orders/' + order_id), 200)
    check('cancelled financial record no longer points at deleted task', cancelled_readback['order']['jobId'] is None and cancelled_readback['job'] is None)
    expect('delete-all needs explicit confirmation', request('/api/studio', 'DELETE', {'confirm': 'no'}), 400)
    cleanup_identity(OWNER, 'owner')
    expect('owner deleted original inaccessible', request(photo['url']), 404)
    expect('owner deleted manual result inaccessible', request(result['url']), 404)
    expect('owner cleanup leaves other customer bytes intact', request(other_photo['url'], who=OTHER), 200)
    other_state = expect('other customer state remains isolated', request('/api/studio', who=OTHER), 200)
    check('other customer task survives owner cleanup', any(item['id'] == other_job['id'] for item in other_state['jobs']))
    own_orders = expect('owner transaction identity removed after delete-all', request('/api/orders'), 200)
    check('anonymized order no longer appears to owner', own_orders['orders'] == [])


failure = None
cleanup_errors = []
try:
    run()
except Exception as error:
    failure = f'{type(error).__name__}: {error}'
finally:
    # Identities are unique to this run; operator data is deliberately untouched.
    for identity, name in ((OWNER, 'final owner'), (OTHER, 'final other')):
        try:
            cleanup_identity(identity, name)
        except Exception as error:
            cleanup_errors.append(f'{name}: {type(error).__name__}: {error}')

print(json.dumps({'status': 'failed' if failure or cleanup_errors else 'passed',
                  'base': BASE, 'passed': len(PASSED), 'checks': PASSED,
                  'failure': failure, 'cleanupErrors': cleanup_errors,
                  'scope': 'Local HTTP with isolated real D1/R2; no provider network calls, no paid HTTP fixture, no generation quality claim.'},
                 ensure_ascii=False, indent=2))
sys.exit(1 if failure or cleanup_errors else 0)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLoopback,
  isPrivateOrLoopback,
  validateReceiverHost,
  receiverBaseUrl,
  listInternalAddresses,
  isSamePcAddress,
} from '../src/shared/address.js';

test('사설 주소 판별: 허용되는 주소', () => {
  const allowed = [
    '127.0.0.1', '127.0.0.2', '127.255.255.255', '::1',
    '10.0.0.0', '10.0.0.1', '10.255.255.255',
    '172.16.0.0', '172.16.0.1', '172.20.10.2', '172.31.255.255',
    '192.168.0.0', '192.168.0.5', '192.168.255.255',
    '169.254.0.0', '169.254.1.1', '169.254.255.255',
    '::ffff:127.0.0.1', '::ffff:192.168.0.5', '::FFFF:10.1.2.3', '::ffff:172.16.0.9',
    '::ffff:169.254.3.4', '::ffff:c0a8:0005', '::ffff:7f00:1',
  ];
  for (const address of allowed) {
    assert.equal(isPrivateOrLoopback(address), true, `허용해야 함: ${address}`);
  }
});

test('사설 주소 판별: 거절되는 주소', () => {
  const rejected = [
    '8.8.8.8', '1.1.1.1', '9.255.255.255', '11.0.0.1', '126.255.255.255', '128.0.0.1',
    '172.15.255.255', '172.15.0.1', '172.32.0.0', '172.32.0.1', '171.16.0.1', '173.16.0.1',
    '192.167.255.255', '192.169.0.1', '191.168.0.1', '193.168.0.1',
    '169.253.255.255', '169.255.0.1', '168.254.0.1', '170.254.0.1',
    '0.0.0.0', '255.255.255.255', '100.64.0.1', '224.0.0.1',
    '::ffff:8.8.8.8', '::ffff:172.32.0.1', '::ffff:0808:0808', '::ffff:11.0.0.1',
    '::', '::2', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', '2001:db8::1',
    '::ffff:', '::ffff:1.2.3', '1::ffff:192.168.0.5',
    '', ' ', 'localhost', 'example.com', '192.168.0', '192.168.0.5.1', '192.168.0.256',
    '192.168.0.-1', '192.168.0.5 ', ' 192.168.0.5', '192.168.0.5:80', '192.168.00.5',
    '0x7f.0.0.1', '010.0.0.1', '1e1.0.0.1', '10.0.0.1/8',
    null, undefined, 0, 2130706433, {}, [],
  ];
  for (const address of rejected) {
    assert.equal(isPrivateOrLoopback(address), false, `거절해야 함: ${JSON.stringify(address)}`);
  }
});

test('같은 PC 주소(되돌이 주소) 판별', () => {
  for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback(address), true, address);
  }
  for (const address of ['192.168.0.5', '10.0.0.1', '::ffff:192.168.0.5', '128.0.0.1', '', null, 'localhost']) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

test('받는 쪽 주소: 같은 PC 주소와 사설 IPv4만 받아들인다', () => {
  const accepted = [
    '127.0.0.1', '127.0.0.9', '10.0.0.7', '172.16.5.4', '172.31.0.1', '192.168.0.10', '169.254.10.20',
  ];
  for (const input of accepted) {
    assert.deepEqual(validateReceiverHost(input), { ok: true, host: input }, input);
  }
  // 앞뒤 빈칸은 실수로 들어가기 쉬우므로 떼고 받는다.
  assert.deepEqual(validateReceiverHost('  192.168.0.10 \n'), { ok: true, host: '192.168.0.10' });
});

test('받는 쪽 주소: 이름·공인 주소·포트·경로·IPv6·빈 값은 한국어 이유와 함께 거절한다', () => {
  const rejected = [
    '', '   ', 'localhost', 'LOCALHOST', 'example.com', 'receiver.local', 'my-laptop',
    '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '0.0.0.0',
    '255.255.255.255', '100.64.0.1',
    '127.0.0.1:4180', '192.168.0.10:80', '192.168.0.10:', 'http://192.168.0.10', 'https://192.168.0.10',
    '//192.168.0.10', '192.168.0.10/', '192.168.0.10/sheet', '192.168.0.10?x=1', '192.168.0.10#a',
    'user@192.168.0.10', '192.168.0.10@8.8.8.8', '8.8.8.8#@192.168.0.10', '192.168.0.10\\@8.8.8.8',
    '::1', '[::1]', '::ffff:192.168.0.10', '[::ffff:192.168.0.10]', 'fe80::1',
    '192.168.0', '192.168.0.10.1', '192.168.0.256', '192.168.00.10', '0300.0250.0.012',
    '0xC0.0xA8.0.10', '3232235530', '192.168.0.1 0', '192.168.0.10\n8.8.8.8', '192.168.0.１０',
    '127.1', '10.1',
    null, undefined, 127, {}, ['127.0.0.1'],
  ];
  for (const input of rejected) {
    const result = validateReceiverHost(input);
    assert.equal(result.ok, false, `거절해야 함: ${JSON.stringify(input)}`);
    assert.equal(result.host, undefined);
    assert.equal(typeof result.reason, 'string');
    assert.match(result.reason, /[가-힣]/, `한국어 이유가 있어야 함: ${JSON.stringify(input)}`);
  }
});

test('받는 쪽 주소 만들기: 포트는 설정값으로 고정이고, 받아들일 수 없는 주소는 만들지 않는다', () => {
  assert.equal(receiverBaseUrl('127.0.0.1', 4180), 'http://127.0.0.1:4180');
  assert.equal(receiverBaseUrl(' 192.168.0.10 ', 4180), 'http://192.168.0.10:4180');
  assert.throws(() => receiverBaseUrl('8.8.8.8', 4180), /[가-힣]/);
  assert.throws(() => receiverBaseUrl('example.com', 4180), /[가-힣]/);
  assert.throws(() => receiverBaseUrl('192.168.0.10:9999', 4180), /[가-힣]/);
  assert.throws(() => receiverBaseUrl('127.0.0.1', '4180/x'));
  assert.throws(() => receiverBaseUrl('127.0.0.1', 0));
  assert.throws(() => receiverBaseUrl('127.0.0.1', 70000));
});

test('이 PC의 내부 주소 찾기: 사설 IPv4만, 전부, 되돌이 주소는 빼고', () => {
  const fake = () => ({
    lo: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    wifi: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.0.10', family: 'IPv4', internal: false },
    ],
    hotspot: [{ address: '172.20.10.2', family: 'IPv4', internal: false }],
    wan: [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
    direct: [{ address: '169.254.7.7', family: 'IPv4', internal: false }],
    lan: [{ address: '10.0.0.3', family: 4, internal: false }],
    dup: [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
    broken: undefined,
  });
  // 자동으로 붙는 169.254 주소는 맨 뒤에 둔다(입력할 주소로 먼저 보이지 않게).
  assert.deepEqual(listInternalAddresses(fake), ['192.168.0.10', '172.20.10.2', '10.0.0.3', '169.254.7.7']);
  assert.deepEqual(listInternalAddresses(() => ({})), []);
  const real = listInternalAddresses();
  assert.ok(Array.isArray(real));
  for (const address of real) {
    assert.equal(isPrivateOrLoopback(address), true);
    assert.equal(isLoopback(address), false);
  }
});

test('같은 PC에서 온 요청인지 판별', () => {
  const own = ['192.168.0.10'];
  assert.equal(isSamePcAddress('127.0.0.1', own), true);
  assert.equal(isSamePcAddress('::1', own), true);
  assert.equal(isSamePcAddress('192.168.0.10', own), true);
  assert.equal(isSamePcAddress('::ffff:192.168.0.10', own), true);
  assert.equal(isSamePcAddress('192.168.0.11', own), false);
  assert.equal(isSamePcAddress('8.8.8.8', own), false);
  assert.equal(isSamePcAddress(undefined, own), false);
});

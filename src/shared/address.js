// 주소 규칙 (명세 7, 8.3, 11-3·5)
//
// - 요청을 보낸 쪽 주소가 같은 PC 또는 사설 주소인지 판별한다.
// - 발표자가 입력한 받는 쪽 주소를 확인한다(같은 PC 주소 또는 사설 IPv4 글자만 허용).
// - 이 PC의 내부 주소를 찾는다.

import os from 'node:os';

/**
 * 엄격한 IPv4 읽기. '192.168.0.5' 같은 십진수 네 마디만 받는다.
 * 앞에 0이 붙은 마디(010), 16진수, 빈칸, 포트가 붙은 것은 모두 거절한다
 * (프로그램마다 다르게 읽을 수 있는 표기를 아예 받지 않기 위해서다).
 * @param {unknown} text
 * @returns {[number, number, number, number] | null}
 */
export function parseIPv4(text) {
  if (typeof text !== 'string') return null;
  const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return /** @type {[number, number, number, number]} */ (parts);
}

/**
 * 'IPv4를 담은 IPv6'(::ffff:192.168.0.5 또는 ::ffff:c0a8:5)에서 IPv4 부분을 꺼낸다.
 * 그런 모양이 아니면 null.
 */
function mappedIPv4(text) {
  const match = /^::ffff:(.+)$/i.exec(text);
  if (!match) return null;
  const rest = match[1];
  const dotted = parseIPv4(rest);
  if (dotted) return dotted;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** 주소 글자에서 IPv4 네 마디를 얻는다(그냥 IPv4이거나 IPv4를 담은 IPv6). 아니면 null. */
function toIPv4(address) {
  if (typeof address !== 'string') return null;
  return parseIPv4(address) || mappedIPv4(address);
}

function isLoopbackParts(parts) {
  return parts[0] === 127;
}

function isPrivateParts([a, b]) {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 같은 PC를 가리키는 주소(127.0.0.0/8, ::1)인가.
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopback(address) {
  if (address === '::1') return true;
  const parts = toIPv4(address);
  return parts !== null && isLoopbackParts(parts);
}

/**
 * 요청을 보낸 쪽 주소가 "같은 PC 또는 사설 주소"인가 (명세 7).
 * 허용: 127.x, ::1, 10.x, 172.16~31.x, 192.168.x, 169.254.x (IPv4를 담은 IPv6 포함).
 * 그 밖의 모든 값(공인 주소, 다른 IPv6, 이름, 문자열이 아닌 값)은 false.
 * @param {unknown} address 예: req.socket.remoteAddress
 * @returns {boolean}
 */
export function isPrivateOrLoopback(address) {
  if (address === '::1') return true;
  const parts = toIPv4(address);
  if (parts === null) return false;
  return isLoopbackParts(parts) || isPrivateParts(parts);
}

const HOST_REASONS = Object.freeze({
  empty: '받는 쪽 주소가 비어 있습니다. 예: 127.0.0.1 또는 192.168.0.10',
  extra: '주소에는 숫자와 점만 적어 주세요. 포트 번호나 http:// 같은 글자는 넣지 않습니다. 포트는 받는 쪽 포트로 고정되어 있습니다.',
  ipv6: '이 칸에는 숫자 네 마디로 된 주소만 넣을 수 있습니다. 예: 192.168.0.10',
  name: '이름으로 된 주소는 받지 않습니다. 숫자 네 마디로 된 주소를 넣어 주세요. 예: 127.0.0.1 또는 192.168.0.10',
  shape: '주소 모양이 맞지 않습니다. 0~255 사이의 숫자 네 마디를 점으로 이어 적어 주세요. 예: 192.168.0.10',
  public: '같은 PC 주소(127.x)나 내부 주소(10.x, 172.16~31.x, 192.168.x, 169.254.x)만 받습니다. 인터넷 주소로는 보내지 않습니다.',
});

/**
 * 발표자가 입력한 받는 쪽 주소 확인 (명세 8.3).
 * 같은 PC 주소 또는 사설 IPv4 글자만 받아들인다. 앞뒤 빈칸은 떼고 본다.
 * 이름(localhost 포함), 공인 주소, 포트·http://·경로가 붙은 것, IPv6, 빈 값은 거절한다.
 * 포트는 이 입력에서 오지 않는다(설정의 받는 쪽 포트로 고정).
 * @param {unknown} input
 * @returns {{ok: true, host: string} | {ok: false, reason: string}}
 */
export function validateReceiverHost(input) {
  if (typeof input !== 'string') return { ok: false, reason: HOST_REASONS.empty };
  const text = input.trim();
  if (text === '') return { ok: false, reason: HOST_REASONS.empty };

  const parts = parseIPv4(text);
  if (parts === null) {
    if (/^[0-9.]+$/.test(text)) return { ok: false, reason: HOST_REASONS.shape };
    if (/^\[?[0-9a-fA-F.:%]*::?[0-9a-fA-F.:%]*\]?$/.test(text) && (text.match(/:/g) || []).length >= 2) {
      return { ok: false, reason: HOST_REASONS.ipv6 };
    }
    if (/^[A-Za-z0-9.-]+$/.test(text)) return { ok: false, reason: HOST_REASONS.name };
    return { ok: false, reason: HOST_REASONS.extra };
  }
  if (!isLoopbackParts(parts) && !isPrivateParts(parts)) {
    return { ok: false, reason: HOST_REASONS.public };
  }
  return { ok: true, host: parts.join('.') };
}

/**
 * 앱 서버가 데이터를 보낼 받는 쪽 주소를 만든다: 'http://<확인된 주소>:<포트>'.
 * 주소가 validateReceiverHost를 통과하지 못하면 한국어 이유를 담아 예외를 던진다.
 * 보내기 직전에 반드시 이 함수를 거치면 "인터넷 주소로는 보내지 않는다"가 지켜진다.
 * @param {unknown} host 발표자가 입력한 주소
 * @param {number} port 설정의 받는 쪽 포트(1~65535 정수)
 * @returns {string} 끝에 '/'가 없는 주소
 */
export function receiverBaseUrl(host, port) {
  const checked = validateReceiverHost(host);
  if (!checked.ok) throw new Error(checked.reason);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`받는 쪽 포트가 올바르지 않습니다: ${String(port)}`);
  }
  return `http://${checked.host}:${port}`;
}

/**
 * 이 PC의 내부 주소(사설 IPv4)를 모두 찾는다. 같은 PC 주소(127.x)는 뺀다.
 * 찾은 순서대로 돌려주되, 연결이 없을 때 자동으로 붙는 169.254.x는 맨 뒤에 둔다.
 * @param {() => NodeJS.Dict<os.NetworkInterfaceInfo[]>} [networkInterfaces] 검사용으로 바꿔 끼울 수 있다
 * @returns {string[]}
 */
export function listInternalAddresses(networkInterfaces = os.networkInterfaces) {
  const found = [];
  const linkLocal = [];
  for (const entries of Object.values(networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      const parts = parseIPv4(entry.address);
      if (parts === null || !isPrivateParts(parts)) continue;
      const list = parts[0] === 169 ? linkLocal : found;
      if (!found.includes(entry.address) && !linkLocal.includes(entry.address)) list.push(entry.address);
    }
  }
  return [...found, ...linkLocal];
}

/**
 * 요청을 보낸 주소가 이 PC 자신인가(접속 기록의 "같은 PC / 다른 기기" 표시용).
 * 같은 PC 주소이거나 이 PC의 내부 주소와 같으면 true.
 * 주의: 표시용이다. "같은 PC에서만 허용"을 판단할 때는 스위치가 넘겨주는 info.local을 쓴다.
 * @param {unknown} address
 * @param {string[]} [ownAddresses] 이 PC의 내부 주소(기본: 지금 찾은 값)
 * @returns {boolean}
 */
export function isSamePcAddress(address, ownAddresses = listInternalAddresses()) {
  if (isLoopback(address)) return true;
  const parts = toIPv4(address);
  if (parts === null) return false;
  return ownAddresses.includes(parts.join('.'));
}

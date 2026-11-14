// 받는 쪽 주소 설정 하나 (명세 5.4, 8.3, 11-5).
// 두 앱과 진행 화면이 이 값 하나를 함께 읽는다. 바꿀 수 있는 것은 주소(host)뿐이고,
// 같은 PC 주소 또는 사설 IPv4만 받아들인다. 포트는 처음 정한 받는 쪽 포트로 고정이다.

import { receiverBaseUrl, validateReceiverHost } from '../shared/address.js';

export const DEFAULT_RECEIVER_HOST = '127.0.0.1';

/**
 * @param {{port: number, host?: string}} options port: 받는 쪽 포트(1~65535). host: 처음 값(기본 127.0.0.1)
 * @returns {{
 *   get(): {host: string, port: number},
 *   base(): string,
 *   set(input: unknown): {ok: true, host: string} | {ok: false, reason: string},
 * }}
 */
export function createReceiverAddress({ port, host = DEFAULT_RECEIVER_HOST } = {}) {
  // 처음 값도 같은 확인을 거친다(올바르지 않으면 한국어 이유를 담아 예외).
  receiverBaseUrl(host, port);
  let current = validateReceiverHost(host).host;

  return {
    /** 지금 값. 앱의 getReceiverBase로 그대로 쓸 수 있다. */
    get() {
      return { host: current, port };
    },
    /** 'http://<주소>:<포트>'. 만들 때마다 다시 확인한다. */
    base() {
      return receiverBaseUrl(current, port);
    },
    /** 주소를 바꾼다. 받아들일 수 없으면 바꾸지 않고 이유를 돌려준다. */
    set(input) {
      const checked = validateReceiverHost(input);
      if (!checked.ok) return checked;
      current = checked.host;
      return checked;
    },
  };
}

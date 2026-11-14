// 포트와 실행 설정 (명세 3). 환경 변수로 바꿀 수 있다(검사용).

/** 기본 포트. */
export const DEFAULT_PORTS = Object.freeze({
  console: 4170, // 진행 화면
  app1: 4173, // 1번 앱
  app2: 4174, // 2번 앱
  receiver: 4180, // 받는 쪽
});

function readPort(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`환경 변수 ${name}의 값이 올바르지 않습니다: "${raw}". 0~65535 사이의 숫자를 넣어 주세요.`);
  }
  return Number(raw);
}

/**
 * 환경 변수에서 설정을 읽는다.
 *   CONSOLE_PORT(4170), APP1_PORT(4173), APP2_PORT(4174), RECEIVER_PORT(4180), DEMO_NO_BROWSER(1이면 브라우저를 열지 않음)
 * 포트 값이 숫자가 아니거나 범위를 벗어나면 한국어 설명을 담아 예외를 던진다. 0은 "빈 포트 자동 선택"이다.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{consolePort: number, app1Port: number, app2Port: number, receiverPort: number, noBrowser: boolean}}
 */
export function readConfig(env = process.env) {
  return {
    consolePort: readPort(env, 'CONSOLE_PORT', DEFAULT_PORTS.console),
    app1Port: readPort(env, 'APP1_PORT', DEFAULT_PORTS.app1),
    app2Port: readPort(env, 'APP2_PORT', DEFAULT_PORTS.app2),
    receiverPort: readPort(env, 'RECEIVER_PORT', DEFAULT_PORTS.receiver),
    noBrowser: env.DEMO_NO_BROWSER === '1',
  };
}

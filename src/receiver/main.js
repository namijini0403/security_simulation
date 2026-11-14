// 받는 쪽 프로그램 실행 (npm run receiver)
//
// 실행하면 같은 PC에서만 열리는 받는 쪽을 띄우고 기본 브라우저로 받는 쪽 화면을 연다.
// 다른 기기 접속은 받는 쪽 화면의 스위치로만 켠다.

import { readConfig } from '../shared/config.js';
import { ensureNodeVersion, exitOnStartupError, openBrowser } from '../shared/http.js';
import { createReceiver } from './server.js';

function fail(message) {
  console.error(`\n[시작하지 못했습니다]\n${message}\n`);
  process.exit(1);
}

async function main() {
  if (!ensureNodeVersion()) return;

  let config;
  try {
    config = readConfig();
  } catch (error) {
    fail(error && error.message ? error.message : '실행 설정을 읽지 못했습니다.');
    return;
  }

  const receiver = createReceiver({ port: config.receiverPort });
  let opened;
  try {
    opened = await receiver.listen();
  } catch (error) {
    // 일부만 뜬 채로 계속 돌지 않는다: 모두 닫고 한국어로 알린 뒤 끝낸다.
    await receiver.close().catch(() => {});
    exitOnStartupError(error);
    return;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n받는 쪽 프로그램을 끝냅니다. 다른 기기 접속도 함께 닫힙니다.');
    // 정리가 늦어져도 프로그램이 남지 않게 한다.
    setTimeout(() => process.exit(0), 3000).unref();
    receiver.close().then(() => process.exit(0), () => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, stop);
    } catch {
      // 이 운영체제에 없는 신호는 건너뛴다.
    }
  }

  const screen = `${opened.url}/`;
  console.log([
    '',
    '받는 쪽 프로그램이 시작되었습니다. (교육용 실습 / 100% 합성 데이터 / 실제 개인정보 입력 금지)',
    '실제 온라인 표·AI 서비스가 아니라 교육용으로 흉내 낸 프로그램입니다.',
    '',
    `  받는 쪽 화면: ${screen}`,
    '',
    '지금은 이 PC에서만 열립니다. 다른 기기에서 보내게 하려면 받는 쪽 화면에서 "다른 기기 접속"을 켜세요.',
    '끝내려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.',
    '',
  ].join('\n'));

  if (!openBrowser(screen) && !config.noBrowser) {
    console.log(`브라우저를 자동으로 열지 못했습니다. 브라우저 주소창에 ${screen} 을 직접 입력해 주세요.\n`);
  }
}

main().catch((error) => {
  fail(`프로그램을 시작하지 못했습니다.${error && error.message ? ` (원인: ${error.message})` : ''}\n창을 닫고 다시 실행해 주세요.`);
});

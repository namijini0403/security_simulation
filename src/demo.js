// 시연 프로그램 (npm run demo): 진행 화면 + 똑같이 생긴 성적 관리 앱 두 개 (명세 3, 7, 11, 12)
//
//   - 1번 앱과 2번 앱은 접속 스위치 하나에 등록한다. 실행 직후에는 같은 PC(127.0.0.1)에서만 열리고,
//     진행 화면에서 확인을 거쳐 스위치를 켰을 때만 같은 연결의 다른 기기에서도 열린다.
//   - 진행 화면은 스위치에 등록하지 않고 127.0.0.1에만 연다. 어떤 경우에도 다른 기기에서 열리지 않는다.
//   - 셋 중 하나라도 열지 못하면 이미 연 것을 모두 닫고 한국어로 알린 뒤 끝낸다.
//
// 이 파일을 불러오는 것만으로는 아무 일도 일어나지 않는다. 직접 실행했을 때만 main()이 돈다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccessSwitch } from './shared/access-switch.js';
import { readConfig } from './shared/config.js';
import { ensureNodeVersion, exitOnStartupError, listen, openBrowser as openDefaultBrowser } from './shared/http.js';
import { createGradeApp } from './app/server.js';
import { FIXED_NOTICE } from './console/content.js';
import { createReceiverAddress } from './console/receiver-address.js';
import { createConsole } from './console/server.js';

/** 두 앱의 설정. 다른 것은 checkPermission과 쿠키 이름뿐이다. */
const APPS = Object.freeze([
  Object.freeze({ key: 'app1', label: '1번 앱', checkPermission: false, cookieName: 'gsid_a' }),
  Object.freeze({ key: 'app2', label: '2번 앱', checkPermission: true, cookieName: 'gsid_b' }),
]);

/**
 * 시연 프로그램을 띄운다.
 * 셋(1번 앱, 2번 앱, 진행 화면) 중 하나라도 열지 못하면 이미 연 것을 모두 닫고 거절한다
 * (오류에 code('EADDRINUSE' 등)와 port가 들어 있다).
 *
 * @param {object} [options]
 * @param {{console?: number, app1?: number, app2?: number, receiver?: number}} [options.ports]
 *   포트. 생략한 것은 환경 변수(readConfig)에서 읽는다. 0이면 빈 포트 자동 선택(받는 쪽 포트는 0일 수 없다)
 * @param {Record<string, string | undefined>} [options.env] 환경 변수(기본 process.env)
 * @param {string} [options.receiverHost] 받는 쪽 주소의 처음 값(기본 127.0.0.1)
 * @param {number} [options.limitMs] 다른 기기 접속이 자동으로 꺼지기까지의 시간(기본 30분)
 * @param {number} [options.warningMs] 알림을 시작하는 남은 시간(기본 2분)
 * @param {() => number} [options.now] 스위치와 진행 화면의 시계(기본 Date.now)
 * @param {object} [options.switchOptions] createAccessSwitch에 그대로 넘길 나머지 값(검사용)
 * @param {boolean | ((url: string) => boolean)} [options.openBrowser] false면 브라우저를 열지 않는다.
 *   함수를 주면 그 함수로 연다. 기본은 기본 브라우저(환경 변수 DEMO_NO_BROWSER=1이면 열지 않음)
 * @param {(line: string) => void} [options.log] 안내문을 내보낼 곳(기본 console.log)
 * @param {string} [options.appPublicDir] 앱 화면 파일 폴더(검사용)
 * @param {string} [options.consolePublicDir] 진행 화면 파일 폴더(검사용)
 * @param {number} [options.forwardTimeoutMs] 앱이 받는 쪽을 기다리는 시간
 * @param {number} [options.receiverCacheMs] createConsole의 같은 이름 값(아래 셋도 같다)
 * @param {number} [options.receiverTimeoutMs]
 * @param {number} [options.receiverWaitMs]
 * @param {number} [options.actionWaitMs]
 * @param {object} [options.consoleOptions] createConsole에 그대로 넘길 나머지 값
 * @returns {Promise<{
 *   ports: {console: number, app1: number, app2: number},
 *   urls: {console: string, app1: string, app2: string},
 *   sw: object, apps: {app1: object, app2: object}, console: object, receiverAddress: object,
 *   browserOpened: boolean, close: () => Promise<void>,
 * }>}
 */
export async function startDemo(options = {}) {
  const {
    env = process.env,
    ports = {},
    receiverHost,
    limitMs,
    warningMs,
    now,
    switchOptions = {},
    openBrowser = true,
    log = console.log,
    appPublicDir,
    consolePublicDir,
    forwardTimeoutMs,
    consoleOptions = {},
  } = options;

  // 포트를 모두 직접 받았으면 환경 변수는 읽지 않는다.
  const given = ['console', 'app1', 'app2', 'receiver'].every((name) => ports[name] !== undefined);
  const config = given ? {} : readConfig(env);
  const wanted = {
    console: ports.console ?? config.consolePort,
    app1: ports.app1 ?? config.app1Port,
    app2: ports.app2 ?? config.app2Port,
    receiver: ports.receiver ?? config.receiverPort,
  };
  if (!Number.isInteger(wanted.receiver) || wanted.receiver < 1 || wanted.receiver > 65535) {
    throw Object.assign(
      new Error(`환경 변수 RECEIVER_PORT의 값이 올바르지 않습니다: "${wanted.receiver}". 받는 쪽 포트는 1~65535 사이의 숫자여야 합니다.`),
      { code: 'BAD_CONFIG' },
    );
  }

  // 받는 쪽 주소 설정 하나를 두 앱과 진행 화면이 함께 쓴다(진행 화면만 바꿀 수 있다).
  const receiverAddress = createReceiverAddress({ port: wanted.receiver, ...(receiverHost === undefined ? {} : { host: receiverHost }) });

  const switchConfig = { ...switchOptions };
  if (limitMs !== undefined) switchConfig.limitMs = limitMs;
  if (warningMs !== undefined) switchConfig.warningMs = warningMs;
  if (now !== undefined) switchConfig.now = now;
  const sw = createAccessSwitch(switchConfig);

  const apps = {};
  for (const item of APPS) {
    apps[item.key] = createGradeApp({
      label: item.label,
      checkPermission: item.checkPermission,
      cookieName: item.cookieName,
      getReceiverBase: () => receiverAddress.get(),
      ...(appPublicDir === undefined ? {} : { publicDir: appPublicDir }),
      ...(forwardTimeoutMs === undefined ? {} : { forwardTimeoutMs }),
    });
  }

  let consoleApp = null;
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        if (consoleApp) await consoleApp.close().catch(() => {});
        await sw.close().catch(() => {}); // 스위치를 끄고 두 앱의 문을 모두 닫는다.
      })();
    }
    return closing;
  };

  try {
    const opened = {};
    // 두 앱만 스위치에 등록한다.
    for (const item of APPS) {
      opened[item.key] = (await sw.listen({ name: item.key, port: wanted[item.key], handler: apps[item.key].handler })).port;
    }
    const urls = {
      app1: `http://127.0.0.1:${opened.app1}`,
      app2: `http://127.0.0.1:${opened.app2}`,
    };

    const passed = {};
    for (const name of ['receiverCacheMs', 'receiverTimeoutMs', 'receiverWaitMs', 'actionWaitMs']) {
      if (options[name] !== undefined) passed[name] = options[name];
    }
    consoleApp = createConsole({
      apps: APPS.map((item) => ({
        key: item.key,
        label: item.label,
        app: apps[item.key],
        baseUrl: urls[item.key],
        checkPermission: item.checkPermission,
      })),
      accessSwitch: sw,
      receiverAddress,
      ...(consolePublicDir === undefined ? {} : { publicDir: consolePublicDir }),
      ...(now === undefined ? {} : { now }),
      ...consoleOptions,
      ...passed,
    });
    // 진행 화면: 스위치에 등록하지 않고 127.0.0.1에만 연다(명세 11-4).
    opened.console = await listen(consoleApp.server, wanted.console, '127.0.0.1');
    urls.console = `http://127.0.0.1:${opened.console}`;

    const screen = `${urls.console}/`;
    log([
      '',
      `시연 프로그램이 시작되었습니다. (${FIXED_NOTICE})`,
      '',
      `  진행 화면: ${screen}`,
      `  1번 앱: ${urls.app1}/`,
      `  2번 앱: ${urls.app2}/`,
      `  받는 쪽 주소(처음 값): ${receiverAddress.base()}`,
      '',
      '지금은 이 PC에서만 열립니다. 다른 기기에서 두 앱을 열게 하려면 진행 화면에서 "다른 기기 접속"을 켜세요.',
      '진행 화면은 어떤 경우에도 이 PC에서만 열립니다.',
      '끝내려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.',
      '',
    ].join('\n'));

    let browserOpened = false;
    if (typeof openBrowser === 'function') browserOpened = Boolean(openBrowser(screen));
    else if (openBrowser !== false) browserOpened = openDefaultBrowser(screen, { env });

    return { ports: opened, urls, sw, apps, console: consoleApp, receiverAddress, browserOpened, close };
  } catch (error) {
    // 일부만 뜬 채로 계속 돌지 않는다: 이미 연 것을 모두 닫는다.
    await close();
    throw error;
  }
}

function fail(message) {
  console.error(`\n[시작하지 못했습니다]\n${message}\n`);
  process.exit(1);
}

/** npm run demo의 본체. */
export async function main() {
  if (!ensureNodeVersion()) return;

  let demo;
  try {
    demo = await startDemo();
  } catch (error) {
    if (error && typeof error.port === 'number' && typeof error.code === 'string') {
      exitOnStartupError(error); // 포트가 이미 쓰이고 있음 등: 어떤 포트인지와 할 일을 알린다.
    } else {
      fail(error && error.message ? error.message : '프로그램을 시작하지 못했습니다. 창을 닫고 다시 실행해 주세요.');
    }
    return;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n시연 프로그램을 끝냅니다. 다른 기기 접속도 함께 닫힙니다.');
    // 정리가 늦어져도 프로그램이 남지 않게 한다.
    setTimeout(() => process.exit(0), 3000).unref();
    demo.close().then(() => process.exit(0), () => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, stop);
    } catch {
      // 이 운영체제에 없는 신호는 건너뛴다.
    }
  }

  if (!demo.browserOpened && process.env.DEMO_NO_BROWSER !== '1') {
    console.log(`브라우저를 자동으로 열지 못했습니다. 브라우저 주소창에 ${demo.urls.console}/ 을 직접 입력해 주세요.\n`);
  }
}

/** 이 파일을 직접 실행했는가(다른 파일이 불러온 것이 아닌가). */
function isMainModule() {
  if (!process.argv[1]) return false;
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(real(fileURLToPath(import.meta.url)), real(process.argv[1]));
}

if (isMainModule()) {
  main().catch((error) => {
    fail(`프로그램을 시작하지 못했습니다.${error && error.message ? ` (원인: ${error.message})` : ''}\n창을 닫고 다시 실행해 주세요.`);
  });
}

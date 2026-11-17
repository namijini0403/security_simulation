# 요청과 응답

세 가지 HTTP 표면이 있다: 성적 관리 앱(1번·2번 앱 동일), 받는 쪽, 진행 화면. 이용자는 각 화면의 스크립트, 앱 서버(받는 쪽을 부른다), 진행 화면 서버(받는 쪽과 두 앱을 부른다), 그리고 검사다.

## 공통 약속

- 평문 HTTP. 본문과 응답은 JSON(UTF-8)이다. 본문이 없는 요청은 빈 본문으로 보낸다(빈 본문은 `{}`로 읽는다).
- 오류 응답은 항상 `{ "error": "<한국어 설명>" }`이다. 설명은 화면에 그대로 보여 줄 수 있는 문장이다.
- 모든 JSON 응답에 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`가 붙는다.
- 경로의 물음표 뒤는 진행 화면의 상태 읽기 말고는 읽지 않는다.
- 접속 스위치가 처리기보다 먼저 답하는 경우(스위치에 등록된 서버 = 두 앱과 받는 쪽):
  - 다른 기기 쪽 문으로 왔는데 스위치가 꺼져 있다 → 응답 없이 연결이 끊긴다.
  - 보낸 주소가 같은 PC·사설 주소가 아니다 → 403 `{error}`.
  - 처리 중 예기치 않은 오류 → 500 `{error}`.

## 성적 관리 앱

기본 주소 `http://127.0.0.1:4173`(1번 앱), `http://127.0.0.1:4174`(2번 앱). 두 앱의 경로·입력·출력은 같고, 누가 200을 받는지만 다르다.

**로그인 상태**: 로그인에 성공하면 쿠키가 내려온다(1번 앱 `gsid_a`, 2번 앱 `gsid_b`; `Path=/; HttpOnly; SameSite=Lax`). 이후 요청에 그 쿠키를 실어 보낸다. 이용자가 역할이나 학생을 직접 알릴 방법은 없다.

**학생 기록**(아래에서 "기록"): `{ id, name, className, ratings: { 국어, 수학, 사회, 과학, 영어 }, comment, guardianName, guardianPhone }`. 항목 순서도 이대로다. 평가 값은 `잘함`·`보통`·`노력요함`.

**권한에 따른 거절**(아래 표에서 "권한 거절"): 로그인이 필요한데 없으면 401 "로그인이 필요합니다.", 로그인했지만 허용되지 않으면 403 "이 요청을 할 수 있는 권한이 없습니다.". 1번 앱에서는 `GET /api/me`와 `GET /api/students/:id`의 401만 나온다. 권한 거절은 404·400보다 먼저 나온다.

| 요청 | 입력 | 성공 | 오류 |
|---|---|---|---|
| `POST /api/login` | `{ loginId, password }` | 200 `{ role, loginId, studentId }` + 쿠키. `role`은 `parent`/`teacher`, 담임의 `studentId`는 `null` | 401 틀림(글자가 아닌 값·빠진 항목 포함) · 400 본문이 JSON이 아니거나 4KB 초과 |
| `POST /api/logout` | 없음 | 200 `{ ok: true }` + 쿠키 삭제. 로그인하지 않았어도 200 | 없음 |
| `GET /api/me` | 없음 | 200 `{ role, loginId, studentId }` | 401 로그인 안 함(두 앱 모두) |
| `GET /api/app` | 없음 | 200 `{ label }` — `1번 앱` 또는 `2번 앱` | 없음 |
| `GET /api/roster` | 없음 | 200 `[{ id, name }]` (지워진 학생 제외) | 권한 거절 |
| `GET /api/students/:id` | 없음 | 200 기록 | 권한 거절 · 404 없는 번호(지워진 학생 포함) |
| `GET /api/students` | 없음 | 200 기록 배열 | 권한 거절 |
| `PUT /api/students/:id/ratings` | `{ ratings: { 과목: 값, … } }` 과목 일부만 보내도 된다 | 200 바뀐 기록 | 권한 거절 · 404 없는 번호 · 400 `ratings`가 없거나 비었거나, 5개 과목이 아닌 이름·세 값이 아닌 값이 있음(아무것도 바뀌지 않는다) · 400 본문이 JSON이 아니거나 4KB 초과 |
| `POST /api/students/:id/ai-draft` | 없음 | 200 `{ draft }` | 권한 거절 · 404 없는 번호 · 502 받는 쪽에 닿지 못했거나 초안을 받지 못함 |
| `DELETE /api/students/:id` | 없음 | 200 `{ ok: true }` | 권한 거절 · 404 없는 번호(이미 지운 학생 포함) |
| `GET /`, `GET /teacher`, `GET /neighbor`, 화면 폴더의 파일 | 없음 | 200 파일 (`/teacher`는 `/`와 같은 파일) | 404 |

- `/api/` 아래에서 위 표에 없는 경로나 방식은 404 "요청한 주소를 찾을 수 없습니다."다.
- `PUT …/ratings`의 본문에서 `ratings` 말고 다른 항목은 읽지 않는다.
- `PUT …/ratings`는 받는 쪽으로의 전송이 끝나기 전에 대답한다. 응답의 200은 "앱에 저장됨"만 뜻한다.
- 머리글 `X-Demo-Screen: neighbor`를 붙이면 그 요청이 진행 화면의 '가져간 것' 집계에 들어간다. 응답은 달라지지 않는다.
- 응답 어디에도 그 앱이 권한을 확인하는 앱인지 알려 주는 항목은 없다.
- `GET /teacher`는 두 앱 모두 로그인 없이 메인 화면 파일을 내준다. 쿠키를 주지 않고, 이 주소로 열었다는 사실은 그 뒤의 어떤 요청의 결과도 바꾸지 않는다. 그 화면은 명단을 `GET /api/roster`로, 누른 학생의 기록을 `GET /api/students`(반 전체 기록)에서 찾아 그린다. 새 요청은 없다. `/teacher/`, `/Teacher`, `POST /teacher`는 404다.

## 받는 쪽

기본 주소 `http://127.0.0.1:4180`. 로그인이 없다.

### 다른 기기도 쓸 수 있는 다섯 요청

| 요청 | 입력 | 성공 | 오류 |
|---|---|---|---|
| `GET /api/ping` | 없음 | 200 `{ ok: true, service: "receiver" }` | 없음 |
| `POST /sheet/rows` | 학생 기록 하나(7개 항목 전부, 다른 항목 없음) | 200 `{ ok: true }` | 400 가상 데이터 모양이 아님 · 400 JSON이 아니거나 16KB 초과 · 507 가득 참(2,000개) |
| `POST /ai/draft` | `{ id, name, ratings, comment }` (4개 항목 전부, 다른 항목 없음) | 200 `{ draft }` — 미리 써 둔 문장. `[사전 작성된 모의 응답]`으로 시작한다 | 위와 같음 |
| `GET /api/received` | 없음 | 200 `{ sheet: [항목], ai: [항목] }` 받은 순서 | 없음 |
| `POST /api/clear` | 없음 | 200 `{ ok: true }` | 없음 |

- `항목`은 `{ receivedAt, from, payload }`다. `receivedAt`은 ISO 형식 시각, `from`은 보낸 쪽 주소, `payload`는 받은 본문 그대로.
- "가상 데이터 모양": `id`가 `TEST-1001`~`TEST-1020`, `name`이 `가상학생NN`, (온라인 표는) `className`이 `6학년 가상반`, `guardianName`이 `가상보호자NN`, `guardianPhone`이 `010-XXXX-00NN`이고 NN이 `id`와 같다. `ratings`는 정확히 5개 과목에 세 값 중 하나. `comment`는 그 `id`의 가상 기록에 들어 있는 문장과 글자까지 같아야 한다(다른 글은 400). 곧, 받는 본문이 가상 기록과 다를 수 있는 곳은 `ratings`의 다섯 값뿐이다.
- 거절한 본문은 저장하지 않는다. 400의 설명은 무엇이 맞지 않았는지 알려 준다(빠진 항목 수, 정해지지 않은 항목 수 등).
- 방식이 다르면 405, 없는 경로는 404다.

### 같은 PC에서만 되는 것

`127.0.0.1` 문으로 들어온 요청만 받는다. 다른 기기 쪽 문으로 오면 403이다. 스위치 조작은 그에 더해 Host가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`이고 다른 사이트에서 온 요청이 아니어야 한다(아니면 403).

| 요청 | 입력 | 성공 | 오류 |
|---|---|---|---|
| `GET /`, `/index.html`, `/receiver.css`, `/receiver.js` | 없음 | 200 파일 | 403 |
| `GET /local/switch` | 없음 | 200 스위치 상태 | 403 |
| `POST /local/switch/on` | `{ confirmed: true }` | 200 스위치 상태 | 400 확인 값이 없거나 참이 아님 · 403 |
| `POST /local/switch/extend` | 없음 | 200 스위치 상태 | 409 꺼져 있음 · 403 |
| `POST /local/switch/off` | 없음 | 200 스위치 상태(이미 꺼져 있어도 200) | 403 |
| `POST /local/switch/dismiss` | 없음 | 200 스위치 상태("자동으로 꺼졌습니다" 알림을 닫는다) | 403 |

스위치 상태: `{ on, remainingMs, limitMs, warning, autoOff, autoOffMessage, addresses, openAddresses, noInternalAddress, guidance, failures, port }`. `addresses`는 이 PC의 내부 주소 전부, `openAddresses`는 지금 실제로 다른 기기에서 열 수 있는 주소(진행 화면의 받는 쪽 주소 칸에 넣을 값), `failures`는 열지 못한 주소에 대한 한국어 설명이다.

## 진행 화면

기본 주소 `http://127.0.0.1:4170`. 이 PC에서만 연결된다.

**접근 조건**(모든 요청): Host가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`가 아니면 403. `/api/` 아래는 그에 더해 `Origin`이 있으면 이 화면의 주소와 같아야 하고 `Sec-Fetch-Site`가 있으면 `same-origin` 또는 `none`이어야 한다(아니면 403). 두 머리글이 모두 없는 요청(브라우저가 아닌 이용자)은 Host만 맞으면 된다.

**동작 요청의 응답 모양**: 성공하면 200 `{ …덧붙는 값, state }`, 거절하면 `{ error, state }`와 4xx다. 어느 쪽이든 `state`(아래 "화면 상태")가 함께 온다. 본문은 2KB 이하의 JSON 객체여야 하고 아니면 400 `{error}`(이때는 `state`가 없다). 방식이 `POST`가 아니면 405, 없는 경로는 404다.

| 요청 | 입력 | 성공 때 덧붙는 값 | 거절 |
|---|---|---|---|
| `GET /api/state` | `?since=<접속 기록 번호>&limit=<줄 수>` (둘 다 선택. `limit` 기본 200, 최대 500) | 화면 상태 그 자체 | 400 `since`·`limit`이 0 이상의 숫자가 아님 · 405 |
| `POST /api/step` | `{ to: "next" \| "prev" \| "<단계 id>" }` | 없음 | 409 첫 단계에서 `prev`, 마지막 단계에서 `next` · 400 없는 단계 |
| `POST /api/switch` | `{ action: "on", confirmed: true }` \| `{ action: "extend" \| "off" \| "dismiss" }` | 없음 | 400 `on`인데 확인 값이 없거나 참이 아님 · 409 꺼져 있는데 `extend` · 400 모르는 동작 |
| `POST /api/receiver` | `{ action: "set", host }` | 없음 | 400 받아들일 수 없는 주소(이유가 `error`에 온다. 값은 바뀌지 않는다) |
| `POST /api/receiver` | `{ action: "ping" }` | `ping` — 아래 | 없음. **연결에 실패해도 200**이고 `ping.ok`가 `false`다 |
| `POST /api/reveal` | 없음 | 없음(결과는 `state.reveal`) | 409 이미 보내는 중 · 409 전체 초기화하는 중 |
| `POST /api/part2` | `{ action: "next" \| "context" \| "reset" }` \| `{ action: "choose", which: "first" \| "second", choice: "refer" \| "talk" \| "observe" }` | 없음 | 409 순서 위반·없는 선택지(이유가 `error`에 온다) · 400 모르는 동작 |
| `POST /api/reset` | 없음 | `receiverCleared`(참/거짓), `notice`(지우지 못했을 때의 문장 또는 `null`), `receiverAnswered`(지우기 요청에 대답이 왔는가), `receiverStatus`(대답이 왔다면 실제로 받은 결과 번호, 아니면 `null`), `reason`(지우지 못한 이유의 문장 또는 `null`) | 409 이미 초기화하는 중. **받는 쪽을 지우지 못해도 200**이다 |
| `GET /`, 화면 폴더의 파일 | 없음 | 200 파일(콘텐츠 보안 정책 머리글 포함) | 404 · 405 |

단계 id: `start`, `scene1`, `scene2`, `scene3`, `scene4`, `reveal`, `part2`, `closing`.

`ping`: `{ ok, at, time, base, status, message, causes }`. `causes`는 실패했을 때 `{ cause, action }` 다섯 개, 성공하면 빈 배열이다.

### 화면 상태

`GET /api/state`와 모든 동작 응답의 `state`.

| 항목 | 내용 |
|---|---|
| `now` | 서버 시각(밀리초) |
| `fixedNotice` | 상단 고정 표시 문장 |
| `revealed` | 공개했는가 |
| `step` | `{ index, total, id, hasPrev, hasNext, current: { id, label, title, subtitle, say[], guide[], live[] } }`. `live`는 지금 상태에 따라 덧붙는 문장 |
| `steps` | 단계 단추용 목록 `[{ id, label, title, subtitle }]` |
| `switch` | `{ on, remainingMs, limitMs, warning, warningMessage, autoOff, autoOffMessage, localOnlyMessage, scope, confirmWarning, addresses, noInternalAddress, guidance, secondLaptopHint, apps[], failures[] }`. `apps[]`는 앱마다 `{ key, label, port, localUrl, localNeighborUrl, urls[], neighborUrls[] }`이고 `urls`·`neighborUrls`는 꺼져 있으면 빈 배열이다 |
| `accessLog` | `{ epoch, latestId, total, entries[] }`. `entries`는 `since`보다 번호가 큰 줄 가운데 가장 최근 `limit`줄. `epoch`는 전체 초기화 때마다 바뀐다 — 바뀌었으면 이용자는 가진 줄을 버리고 처음부터 다시 받아야 한다 |
| `accessLog.entries[]` | `{ id, at, time, app, appKey, appNo, clientAddress, samePc, otherDevice, sourceLabel, notice, loginId, loginLabel, method, path, request, status, fromNeighborScreen }`. **공개 뒤에만** `permissionChecked`, `permissionLabel`이 더해진다 |
| `taken` | 앱마다 `{ appKey, app, studentCount, students[], rosterCount, rosterLabel, rosterViews, roster[] }` |
| `receiver` | `{ host, port, base, location, locationLabel, reachable, checkedAt, status, error, help[], sheet[], ai[], sheetCount, aiCount, failedTransfers[], ping }`. `reachable`은 받는 쪽이 받은 것을 실제로 알려 주었으면 `true`, 닿지 못했거나 대답을 읽지 못했으면 `false`, 아직 묻는 중이면 `null`. `sheet`·`ai`는 받는 쪽이 준 항목 그대로이며 가장 최근 300개까지, 전체 개수는 `sheetCount`·`aiCount`. **`reachable`이 `true`가 아니면 `sheet`·`ai`는 빈 목록이고 `sheetCount`·`aiCount`는 `null`이다**(0이 아니다: 개수를 모른다는 뜻이다). 화면은 `null`을 "확인하지 못함"으로 적는다 |
| `reveal` | 공개 전: `{ revealed: false, running }`. 공개 뒤: `{ revealed: true, running, runCount, ranAt, ranTime, attempts[], apps[], notes[], comparisonNotice, realRequestNote, appWithoutCheck, appWithCheck }`. `attempts[]`는 `{ no, title, method, path, request, loginId, sent, results: { app1: { status, body, error }, app2: { … } } }`이고 `status`가 `null`이면 대답을 받지 못한 것이다 |
| `part2` | `{ stage, stageNo, stageCount, subject, journal[], facts, ai, choices, firstChoice, contextTotal, contexts[], noContextNote, secondChoice, comparison, explanation }`. 아직 열지 않은 것은 `null`(또는 빈 배열)이다 |
| `closing` | 마무리 단계일 때만 `{ sentences: [{ no, text, emphasis }] }`, 그 밖에는 `null` |
| `lastReset` | 마지막 전체 초기화 `{ at, time, receiverCleared, notice, receiverAnswered, receiverStatus, reason }` 또는 `null`. 뒤의 다섯 값은 `POST /api/reset`의 응답과 같다 |

- 상태 읽기는 받는 쪽에 닿지 못해도 늦어지지 않는다. 받는 쪽 질의가 0.3초 안에 끝나지 않으면 직전 결과를 싣고, 새 결과는 다음 읽기에 반영된다. 받는 쪽에는 1초에 한 번을 넘겨 묻지 않는다.
- 공개 전의 `state`에는 어느 앱이 권한을 확인하는지 알 수 있는 항목이 없다.

## 프로그램 시작의 약속

| 상황 | 글자 창에 나오는 것 | 종료 번호 |
|---|---|---|
| 정상 시작 | 각 화면의 주소, "지금은 이 PC에서만 열립니다", 끝내는 방법 | (계속 실행) |
| 포트가 이미 쓰이고 있음 | `[시작하지 못했습니다]` + 어떤 포트인지 + 먼저 실행한 창을 닫으라는 안내 | 1 |
| 포트 환경 변수가 올바르지 않음 | `[시작하지 못했습니다]` + 어떤 변수의 어떤 값인지 | 1 |
| Node.js가 22보다 낮음 | `[시작하지 못했습니다]` + 지금 버전과 필요한 버전 | 1 |
| 창 닫기, Ctrl+C | "…프로그램을 끝냅니다. 다른 기기 접속도 함께 닫힙니다." | 0 |

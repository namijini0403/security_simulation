#!/bin/bash
# 시연 프로그램 실행 파일 (macOS, 더블클릭용)
#
# 하는 일: 이 파일이 있는 폴더로 가서 Node.js를 찾고, 22 이상인지 확인한 뒤 프로그램을 실행한다. 그것뿐이다.
# 하지 않는 일: 네트워크와 방화벽 설정을 바꾸지 않는다. 관리자 권한(sudo)을 요청하지 않는다.
#               아무것도 내려받거나 설치하지 않는다.
#
# 이 파일은 UTF-8, 줄 끝 LF로 저장한다. 실행 권한(chmod +x)이 있어야 더블클릭으로 열린다.

PROGRAM="src/demo.js"
NAME="시연 프로그램"
REQUIRED=22

# 창이 바로 닫히지 않게, 읽을 시간을 준다.
wait_and_exit() {
  echo
  read -n 1 -s -r -p "이 창은 아무 키나 누르면 닫힙니다." _ 2>/dev/null
  echo
  exit "$1"
}

# 주어진 명령이 Node.js이고 몇 버전인지(앞자리 숫자) 알려 준다. 실행할 수 없으면 아무것도 내지 않는다.
major_of() {
  "$@" -e 'process.stdout.write(String(parseInt(process.versions.node, 10)))' 2>/dev/null
}

NODE_CMD=()   # 찾은 Node.js를 실행하는 명령
OLD_VERSION="" # 22보다 낮은 Node.js만 있을 때 그 버전

# 후보 하나를 살펴본다. 22 이상이면 채택한다.
consider() {
  [ "${#NODE_CMD[@]}" -gt 0 ] && return
  local major
  major="$(major_of "$@")"
  case "$major" in
    ''|*[!0-9]*) return ;;
  esac
  if [ "$major" -ge "$REQUIRED" ]; then
    NODE_CMD=("$@")
  elif [ -z "$OLD_VERSION" ]; then
    OLD_VERSION="$("$@" --version 2>/dev/null)"
  fi
}

cd "$(dirname "$0")" 2>/dev/null || {
  echo
  echo "[시작하지 못했습니다]"
  echo "이 파일이 있는 폴더로 들어가지 못했습니다."
  echo "내려받은 폴더 전체를 바탕 화면이나 문서 폴더로 옮긴 뒤 다시 더블클릭해 주세요."
  wait_and_exit 1
}

if [ ! -f "$PROGRAM" ]; then
  echo
  echo "[시작하지 못했습니다]"
  echo "프로그램 파일을 찾지 못했습니다. 이 파일 옆에 src 폴더가 있어야 합니다."
  echo
  echo " - 압축을 모두 푼 뒤, 풀린 폴더 안에 있는 이 파일을 더블클릭해 주세요."
  echo " - 이 파일만 다른 곳으로 옮겼다면, 원래 폴더에 다시 넣어 주세요."
  wait_and_exit 1
fi

# 1. PATH에 있는 node
if command -v node >/dev/null 2>&1; then
  consider node
fi

# 2. 흔한 설치 위치: Homebrew(Apple 실리콘 / Intel), 공식 설치 파일, Volta
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
  [ -x "$candidate" ] && consider "$candidate"
done

# 3. fnm (Node.js 버전 관리 도구): 기본 버전
for fnm in "$(command -v fnm 2>/dev/null)" /opt/homebrew/bin/fnm /usr/local/bin/fnm "$HOME/.local/share/fnm/fnm" "$HOME/.fnm/fnm"; do
  [ -n "$fnm" ] && [ -x "$fnm" ] && consider "$fnm" exec --using=default node
done

# 4. nvm, fnm이 내려받아 둔 버전들
for candidate in \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node \
  "$HOME"/.fnm/node-versions/*/installation/bin/node; do
  [ -x "$candidate" ] && consider "$candidate"
done

if [ "${#NODE_CMD[@]}" -eq 0 ]; then
  echo
  echo "[시작하지 못했습니다]"
  if [ -n "$OLD_VERSION" ]; then
    echo "이 컴퓨터의 Node.js가 너무 오래된 버전입니다. (지금 버전: $OLD_VERSION)"
  else
    echo "이 컴퓨터에서 Node.js를 찾지 못했습니다."
  fi
  echo "이 프로그램은 Node.js $REQUIRED 이상이 있어야 실행됩니다."
  echo
  echo "설치 방법"
  echo "  1. 브라우저에서 Node.js 공식 사이트 https://nodejs.org 를 엽니다."
  echo "  2. \"LTS\"라고 적힌 macOS 설치 파일을 내려받아 실행합니다."
  echo "     설치 화면에서는 설정을 바꾸지 않고 계속 넘기면 됩니다."
  echo "  3. 설치가 끝나면 이 창을 닫고 이 파일을 다시 더블클릭합니다."
  echo
  echo "자세한 안내는 같은 폴더의 README.md 에 있습니다."
  wait_and_exit 1
fi

echo
echo "$NAME을 시작합니다. 이 창은 발표가 끝날 때까지 닫지 마세요."
echo "끝낼 때는 이 창에서 control + C 를 누르거나 창을 닫으면 됩니다."

"${NODE_CMD[@]}" "$PROGRAM"
status=$?

echo
if [ "$status" -eq 0 ] || [ "$status" -eq 130 ]; then
  echo "$NAME이 끝났습니다."
  status=0
else
  echo "$NAME이 시작되지 못했거나 도중에 멈췄습니다. 위에 나온 안내를 읽어 주세요."
fi
wait_and_exit "$status"

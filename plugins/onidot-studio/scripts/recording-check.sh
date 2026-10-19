#!/bin/sh
# The independent connection adapter inspects bounded local metadata; no transcript is sent.
unavailable() {
  printf '%s\n' '{"suppressOutput":false,"systemMessage":"onidot 완료 기록의 누락 확인이 불가합니다. Studio의 공통 연결 도구 onidot-connect를 확인하세요. 시작 안내의 최종 답변 전 기록 검토를 따르고, knowledge_remember 응답의 id/version으로 성공을 확인하지 못한 내용은 미저장으로 알리세요."}'
}
case "${1:-}" in
  claude|codex) client=$1 ;;
  *) unavailable; exit 0 ;;
esac
if [ -n "${ONIDOT_CONNECT_BIN:-}" ]; then
  helper=$ONIDOT_CONNECT_BIN
elif command -v onidot-connect >/dev/null 2>&1; then
  helper=onidot-connect
elif command -v onidot-studio >/dev/null 2>&1; then
  helper=onidot-studio
else
  exit 0
fi
policy=${0%/*}/recording-review.txt
if command -v "$helper" >/dev/null 2>&1; then
  if output=$("$helper" recording-check --client "$client" --review-file "$policy" 2>/dev/null); then
    if [ -n "$output" ]; then
      printf '%s\n' "$output"
      exit 0
    fi
  fi
fi
# 헬퍼 없음·미지원(rc=2)·실행 실패·빈 출력은 AI가 할 조치가 없는 환경 문제이므로 턴마다 알리지 않는다.
exit 0

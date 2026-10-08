#!/bin/sh
# The local oni command inspects tool metadata; this bridge never sends transcripts.
unavailable() {
  printf '%s\n' '{"suppressOutput":false,"systemMessage":"onidot 완료 기록의 누락 확인이 불가합니다. oni recording-check 기능이 포함된 oni와 플러그인을 함께 업데이트하세요. onidot-guide의 최종 답변 전 기록 검토를 따르고, remember 응답의 id/version으로 성공을 확인하지 못한 내용은 미저장으로 알리세요."}'
}
case "${1:-}" in
  claude|codex) client=$1 ;;
  *) unavailable; exit 0 ;;
esac
if command -v oni >/dev/null 2>&1; then
  if output=$(oni recording-check --client "$client" 2>/dev/null); then
    if [ -n "$output" ]; then
      printf '%s\n' "$output"
      exit 0
    fi
  fi
fi
unavailable
exit 0

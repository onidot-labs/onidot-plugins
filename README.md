# onidot Plugins

onidot-studio AI 플러그인 `onidot@onidot`의 원본·생성기·설치 카탈로그·패키징을 소유한다. 서버는 onidot-studio, 공통 인증은 onidot-platform이 소유한다. 작업 기준과 결과는 [W1-22P](https://labs.onidot.com/w/0rsx2c7fbz8qm/pages/0rtx2argyggsq)에 있다.

## 설치와 연결

현재 패키지 버전은 **0.15.7**이다. 플러그인은 인스턴스 주소를 고정하지 않는다. MCP 연결은 클라이언트 설정에 `onidot-<별칭>`으로 등록한다. 집 셀프호스팅 `onidot-dev`·회사 로컬 `onidot-work`는 예시이며 URL은 사용자가 선택한다.

```sh
codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git
codex plugin add onidot@onidot
claude plugin marketplace add onidot-labs/onidot-plugins
claude plugin install onidot@onidot --scope user
```

설치·등록의 명령, 기대 결과, 확인 방법은 [setup-onidot](source/skills/setup-onidot/SKILL.md)를 따른다. Codex inline MCP 목록은 비워 두고 사용자 설정에 연결별로 등록한다. Claude 패키지는 스킬과 command hooks를 제공하며 계정 커넥터나 독립 MCP 중 한 경로로 연결한다. 루트 `.mcp.json`은 생성하지 않는다. 플러그인 homepage의 `https://onidot.com`은 제품 안내 링크이며 서버·OAuth 주소가 아니다.

기존 Codex git marketplace는 `codex plugin marketplace upgrade onidot` 후 재설치한다. 선택적 공유 OAuth helper의 현재 기본 설치 경로는 `${CODEX_HOME:-$HOME/.codex}/plugins/cache/onidot/onidot/0.15.7/scripts/oauth-helper.mjs`다. helper는 별칭·앱 URL·MCP URL·scope를 명시해야 하며 연결별로 상태와 갱신 잠금을 분리한다. 비밀값·OAuth 로그인과 권한 승인은 사람이 직접 수행한다.

서버 계약은 `list_spaces`·`spaceId`·`scope="SPACE"`·`skill://onidot/`·`oni_pat_/oni_at_/oni_rt_`·Onidot 헤더다. OAuth scope는 `onidot:wiki:*`이며 서버는 옛 이름 `doraft:wiki:*`도 받는다. 옛 `dft_` 토큰은 재사용하지 않는다. 새 연결의 초기화 정체·READ/WRITE 모드와 실제 `list_spaces`·`get_page`를 검증한 뒤 해당 옛 로컬 등록만 제거한다. 다른 플러그인·grant·문서는 삭제하지 않는다.

`npm run verify:codex -- --alias <별칭> --mcp-url <선택한 MCP URL>`은 설치·등록·선택한 서버의 OAuth resource를 비교한다. 실제 인증·문서 조회 성공은 별도로 검증한다.

## 완료 전 자율 기록과 hooks

일반 작업에서도 최종 답변 전 의미 있는 새 배움을 선별하고 `recall`로 중복 확인 후 `remember` 응답의 `id`·`version`으로 저장 성공을 확인한다. 저장 대상이 없으면 기록하지 않는다. 읽기 전용·미노출·실패는 미저장으로 보고하며 로컬 메모리로 대체하지 않는다.

Claude Code는 `claude/hooks.json`, Codex는 `codex/hooks.json`을 각 manifest에 명시해 SessionStart·Stop command를 사용한다. 양쪽에서 자동 탐지하는 `hooks/hooks.json`은 생성하지 않으므로 완료 검사를 중복 수행하지 않는다. Codex는 `PLUGIN_ROOT`, Claude는 `CLAUDE_PLUGIN_ROOT`를 사용한다. 검사는 `oni recording-check --client claude|codex`를 사용하며, **이 기능이 포함된 oni와 함께 업데이트**해야 한다(출시번호 미정). Node/Python 및 추가 LLM 호출은 필요하지 않으며 대화 원문을 네트워크로 보내지 않는다. oni 미설치·구버전이면 고정된 누락 확인 불가 안내와 공통 지침의 기록 검토 절차를 제공하고 중단하거나 저장 성공으로 판단하지 않는다.

Codex의 새 hooks는 사용자가 `/hooks`에서 정의를 검토하고 trust해야 실행된다. 이 신뢰 절차는 우회하지 않으며 사용자 설정 파일을 자동 수정하지 않는다. hooks를 지원하지 않는 앱에서는 공통 지침만 적용하므로 완료 훅 실행을 보장하지 않는다. 자세한 계약은 [Codex hooks](https://learn.chatgpt.com/docs/hooks), [플러그인 lifecycle hooks](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks), [Claude hooks](https://code.claude.com/docs/en/hooks)를 따른다.

## 디렉터리와 정본

- `source/products.json`, `source/wiki.json`: 제품 ID `wiki`, 설치 이름 `onidot`, 버전과 안내 정보의 정본이다. 인스턴스 URL을 넣지 않는다.
- `source/skills/`: 배포 스킬의 유일한 원본이다. 서버의 활성 지침은 manifest/context로 조회한다.
- `source/runtime/`: 연결별로 매개변수화한 선택적 OAuth helper다.
- `scripts/`, `test/`: 생성·패키징·진단과 계약 시험을 둔다.
- `plugins/`, `server-resources/`, `catalog.json`, `.agents/plugins/`, `.claude-plugin/`: `npm run generate`의 생성물이다. 직접 수정하지 않는다. 서버는 고정 commit·SHA256을 검증해 스킬을 반입한다.
- `dist/`: `npm run package`가 생성하는 ZIP·SHA256SUMS이며 git에서 제외한다.

```sh
npm run generate
npm test
npm run package
```

이 저장소에는 onidot 제품만 둔다. 다른 제품의 planned 항목을 설치 목록에 넣지 않고 클라이언트별 플러그인 이름 변형을 만들지 않는다. 생성기는 레포 외부에 쓰지 않는다. 새 배포본을 검증하기 전 기존 사용자 설치를 변경하지 않는다.

## 로컬 릴리스 검증

기억 요청 없는 자율 기록과 새 세션 회상을 실제 모델 클라이언트에서 시험할 때는 `test/fixtures/recording-mcp.mjs`를 격리 stdio MCP로 사용한다. Node 표준 라이브러리만 사용하며 운영 서버나 인증에 연결하지 않는다. `ONIDOT_RECORDING_FIXTURE_DIR`에는 별도 시험 디렉터리, `ONIDOT_RECORDING_GUIDE_FILE`에는 검증할 기본 지침 파일을 명시한다. 디렉터리는 0700, 저장 파일은 0600이며 `ONIDOT_RECORDING_FIXTURE_MODE=write|read|fail`로 쓰기·읽기 전용·저장 실패를 재현한다. 이 fixture는 실제 모델 클라이언트의 도구 선택·저장·회상 검증용이며 실제 backend 검증을 대체하지 않는다. `node --test test/recording-mcp-fixture.test.mjs`로 프로토콜을 시험한다.

자동 verify Actions는 실행하지 않는다(#11). clean commit에서 `npm run verify:local`로 기존 시험·생성물 일치와 패키징을 검증한다. 로컬 결과는 서버 배포 권한이나 실제 클라이언트 설치·OAuth 검증의 대체물이 아니다. 푸시·태그·릴리스는 명시 요청 범위에 따른다.

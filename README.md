# onidot Plugins

onidot-studio AI 플러그인 `onidot@onidot`의 원본·생성기·설치 카탈로그·패키징을 소유한다. 서버는 onidot-studio, 공통 인증은 onidot-platform이 소유한다. 작업 기준과 결과는 [W1-22P](https://labs.onidot.com/w/0rsx2c7fbz8qm/pages/0rtx2argyggsq)에 있다.

## 설치와 연결

현재 패키지 버전은 **0.14.0**이다. 플러그인은 인스턴스 주소를 고정하지 않는다. MCP 연결은 클라이언트 설정에 `onidot-<별칭>`으로 등록한다. 집 셀프호스팅 `onidot-dev`·회사 로컬 `onidot-work`는 예시이며 URL은 사용자가 선택한다.

```sh
codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git
codex plugin add onidot@onidot
claude plugin marketplace add onidot-labs/onidot-plugins
claude plugin install onidot@onidot --scope user
```

설치·등록의 명령, 기대 결과, 확인 방법은 [setup-onidot](source/skills/setup-onidot/SKILL.md)를 따른다. Codex inline MCP 목록은 비워 두고 사용자 설정에 연결별로 등록한다. Claude 패키지는 스킬만 제공하며 계정 커넥터나 독립 MCP 중 한 경로로 연결한다. 루트 `.mcp.json`은 생성하지 않는다. 플러그인 homepage의 `https://onidot.com`은 제품 안내 링크이며 서버·OAuth 주소가 아니다.

기존 Codex git marketplace는 `codex plugin marketplace upgrade onidot` 후 재설치한다. 선택적 공유 OAuth helper의 현재 기본 설치 경로는 `${CODEX_HOME:-$HOME/.codex}/plugins/cache/onidot/onidot/0.14.0/scripts/oauth-helper.mjs`다. helper는 별칭·앱 URL·MCP URL·scope를 명시해야 하며 연결별로 상태와 갱신 잠금을 분리한다. 비밀값·OAuth 로그인과 권한 승인은 사람이 직접 수행한다.

서버 계약은 `list_spaces`·`spaceId`·`scope="SPACE"`·`skill://onidot/`·`oni_pat_/oni_at_/oni_rt_`·Onidot 헤더다. OAuth scope `doraft:wiki:*`는 유지한다. 옛 `dft_` 토큰은 재사용하지 않는다. 새 연결의 초기화 정체·READ/WRITE 모드와 실제 `list_spaces`·`get_page`를 검증한 뒤 해당 옛 로컬 등록만 제거한다. 다른 플러그인·grant·문서는 삭제하지 않는다.

`npm run verify:codex -- --alias <별칭> --mcp-url <선택한 MCP URL>`은 설치·등록·선택한 서버의 OAuth resource를 비교한다. 실제 인증·문서 조회 성공은 별도로 검증한다.

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

자동 verify Actions는 실행하지 않는다(#11). clean commit에서 `npm run verify:local`로 기존 시험·생성물 일치와 패키징을 검증한다. 로컬 결과는 서버 배포 권한이나 실제 클라이언트 설치·OAuth 검증의 대체물이 아니다. 푸시·태그·릴리스는 명시 요청 범위에 따른다.

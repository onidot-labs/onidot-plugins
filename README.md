# Doraft Plugins

Doraft 제품별 AI 플러그인의 **유일한 원본·배포 레포**다. 서버·공통 Platform OAuth는 [doraft](https://github.com/doraft-labs/doraft)가 제공한다. [명세·수용 기준](https://wiki.doraft.com/w/0rhp3csshy8qm/pages/0rqvnznezfgpz)을 따른다. 저장소는 현재 private다.

| 제품 | 설치 ID | 상태 | MCP |
| --- | --- | --- | --- |
| Doraft Wiki | doraft-wiki@doraft | 0.11.0 | https://mcp.doraft.com/wiki |
| Doraft Notes | doraft-notes@doraft | 개발 예정·설치 불가 | 미공개 |

같은 제품은 모든 클라이언트에서 같은 이름을 쓴다. 제품 전체를 묶은 만능 플러그인이나 Codex/Claude 접미사 변형을 만들지 않는다. 로그인은 Doraft Platform에 공통으로 하고 권한·토큰 대상은 제품별로 분리한다.

## 설치

### Codex

```sh
codex plugin marketplace add https://github.com/doraft-labs/doraft-plugins.git
codex plugin add doraft-wiki@doraft
node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/doraft/doraft-wiki/0.11.0/scripts/oauth-helper.mjs" login
```

로컬 macOS/Linux에서 Node.js 24 이상이 필요하다. 공유 OAuth helper가 여러 작업의 갱신을 직렬화한다. 기존 0.8.0 사용자는 helper 로그인 성공 후 `codex mcp logout doraft-wiki`로 이전 로컬 네이티브 인증을 제거하고 새 작업을 시작한다. Windows·원격 실행은 이 helper 경로를 검증하지 않았다. 플러그인에 스킬과 원격 MCP가 함께 있다. 같은 제품을 `codex mcp add`나 `doraft setup`으로 또 등록하지 않는다. CLI 로그인 성공 후 실제 작업에서 list_workspaces와 문서 조회를 확인한다.

### Claude 웹·Desktop·모바일·Code

기본 연결은 계정의 사용자 지정 원격 커넥터 **Doraft Wiki** 하나다. URL은 `https://mcp.doraft.com/wiki`, 인증은 OAuth다. 웹에서 추가한 커넥터를 같은 계정의 Desktop·모바일에서도 사용한다. Code CLI는 claude.ai 구독 인증으로 로그인한 경우 계정 연결을 불러온다. 서버는 작업 스킬도 MCP 리소스로 제공한다.

Code에 로컬 스킬 패키지도 필요하면 다음을 사용한다. 이 패키지는 MCP를 추가하지 않는다. 계정 플러그인 동기화로 같은 스킬을 이미 받으면 다시 설치하지 않는다.

```sh
claude plugin marketplace add doraft-labs/doraft-plugins
claude plugin install doraft-wiki@doraft --scope user
```

API 키·클라우드 제공자 인증 등 계정 커넥터를 못 쓰는 Code 환경은 같은 제품의 독립 MCP를 user scope로 등록할 수 있다. 기존 계정 커넥터와 함께 등록하지 않는다. 새 플러그인 이름을 만들지 않는다. 일반 모바일 채팅은 원격 커넥터 지원 범위이며 플러그인 파일 전체 실행을 보장하지 않는다. 모바일 Cowork의 플러그인 지원과 일반 채팅 지원을 구분한다.

### GPT 웹

사용자 지정 앱 이름 **Doraft Wiki**, URL `https://mcp.doraft.com/wiki`, OAuth로 연결한다. 이 계정 앱은 로컬 Codex 설치·인증과 별개다. 같은 이름에 주소만 다른 앱을 남기지 않는다.

## 이전 설치 교체

먼저 `codex plugin marketplace list --json` 또는 `claude plugin marketplace list`로 doraft가 가리키는 곳을 확인한다. 이전 모노레포·로컬 worktree 경로이면 Doraft 플러그인과 doraft marketplace만 제거한 뒤 위 주소로 재설치한다. 다른 플러그인은 건드리지 않는다. 기존 OAuth가 유효하면 재사용하며 토큰을 클라이언트 간 복사하지 않는다. URL이 구주소인 클라우드 앱은 정상 연결을 검증한 뒤 제거한다.

`npm run verify:codex`는 로컬 설치 manifest·버전·운영 OAuth resource를 확인한다. 설치, 인증, 도구 노출, 실제 조회·저장은 서로 다른 검증 단계다.

## 개발과 릴리스

- source/: 제품 카탈로그와 공통 스킬 원본
- .github/workflows/: PR과 main에서 회귀 테스트·생성물·패키지 자동 검사
- scripts/ 및 test/: 생성·패키징·설치 진단과 계약 테스트
- plugins/: 동일 제품의 Codex·Claude manifest와 스킬
- .agents/plugins/ 및 .claude-plugin/: 클라이언트별 카탈로그
- server-resources/: 제품 서버가 버전·해시를 확인해 반입하는 스킬 산출물
- dist/: npm run package가 만드는 제품별 ZIP 및 SHA256SUMS(git 제외)

```sh
npm run generate
npm test
npm run package
```

새 제품은 source/products.json에서 planned로 시작한다. 서버 MCP와 OAuth 계약을 검증한 뒤 released로 전환하고 source/<product>.json을 추가한다. 릴리스 커밋·태그를 고정한 뒤 서버에서 명시적으로 반입하며, 플러그인 생성기가 서버 repo에 직접 쓰지 않는다.

공식 지원 근거: [Claude 원격 커넥터](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude 플러그인](https://support.claude.com/en/articles/13837440-use-plugins-in-claude), [Claude Code 플러그인](https://code.claude.com/docs/en/plugins), [Codex 플러그인](https://developers.openai.com/codex/plugins).

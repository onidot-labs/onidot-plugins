---
name: setup-doraft-wiki
description: Doraft Wiki 플러그인의 원격 MCP 연결, 브라우저 OAuth, Workspace 권한 선택, 연결 오류를 안내합니다. 사용자가 Doraft Wiki를 연결하거나 인증을 복구하려 할 때 사용합니다.
---

# Doraft Wiki 연결

Wiki 앱의 연결만 다룬다. 별도 Platform 플러그인은 필요하지 않다. 제품의 정식 이름은 **Doraft Wiki**, 설치 ID는 `doraft-wiki@doraft`다. 유일한 소스·배포 레포는 `https://github.com/doraft-labs/doraft-plugins`다. 같은 제품에 `(MCP)`, `Codex`, `Claude` 등의 이름 변형을 만들지 않는다. Codex와 Claude는 MCP를 받는 경로가 다르다(이슈 #223): Codex는 이 플러그인에 원격 MCP가 포함되어 있고, Claude는 이 플러그인에서 스킬만 받으며 MCP는 claude.ai 사용자 지정 커넥터로 별도 연결한다.

## 설치와 중복 확인

- Codex: `codex plugin marketplace add https://github.com/doraft-labs/doraft-plugins.git` → `codex plugin add doraft-wiki@doraft`. 이전 같은 이름 marketplace가 있으면 위치를 확인한 뒤 Doraft 항목만 교체한다.
- Claude Code의 스킬 패키지: `claude plugin marketplace add doraft-labs/doraft-plugins` → `claude plugin install doraft-wiki@doraft --scope user`. MCP는 아래 계정 커넥터가 제공한다. 계정 플러그인 동기화로 이미 같은 스킬을 받으면 로컬 스킬 패키지를 중복 설치하지 않는다.
- Claude 웹·Desktop·모바일: 계정 설정에서 **Doraft Wiki**라는 이름으로 원격 커넥터 하나를 연결한다. 모바일에서 직접 추가 UI가 없으면 웹에서 설정한 같은 계정의 커넥터를 사용한다. 일반 모바일 채팅의 모든 플러그인 파일 실행을 보장하지 않는다.
- GPT 웹의 앱도 이름은 **Doraft Wiki**, URL은 같은 canonical 주소를 쓴다. 이 클라우드 앱이 로컬 Codex 플러그인 인증을 대신한다고 가정하지 않는다. Codex에서 구주소 `codex_apps` 연결을 재인증하거나 대신 호출하지 않는다.
- Notes 등 다른 제품은 별도 플러그인이다. Wiki 설치가 다른 제품의 권한을 추가하지 않는다. 미출시 제품의 MCP 주소를 추측해 등록하지 않는다.

## Codex

0.9.0부터 로컬 macOS/Linux Codex는 공유 OAuth helper로 갱신을 한 번만 수행한다. Node.js 24 이상과 `http_headers_helper`를 지원하는 Codex가 필요하다. 원격 실행 및 Windows에서는 이 helper 경로를 검증하지 않았다. 지원되지 않는 환경에서 설치·연결 성공을 주장하지 않는다. Claude와 GPT 웹의 계정 OAuth는 별개다.

1. `codex plugin add doraft-wiki@doraft`로 설치하고 출력의 installedPath를 확인한다. 아래 경로는 기본 Codex 캐시 기준이다. CODEX_HOME을 바꾸면 같은 위치를 사용한다.
2. `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/doraft/doraft-wiki/0.12.0/scripts/oauth-helper.mjs" login`으로 브라우저 OAuth를 시작한다. 인가 서버는 `https://api.doraft.com`, 토큰 대상은 `https://mcp.doraft.com/wiki`다. 사용자에게 승인받은 Workspace 범위만 선택한다.
3. 같은 명령의 `login`을 `status`로 바꾸어 저장 상태를 확인한다. `headers`는 비밀 헤더를 출력하므로 진단용으로 실행하거나 출력 내용을 공유하지 않는다. 토큰은 private 런타임 파일에 저장되며 다른 클라이언트의 토큰을 복사하지 않는다.
4. 이전 0.8.0 네이티브 OAuth가 있으면 새 helper 로그인 성공 후 `codex mcp logout doraft-wiki`로 기존 로컬 인증만 제거한다. 네이티브 인증이 남으면 helper보다 우선하여 갱신 경쟁이 계속될 수 있다. 서버의 다른 grant를 철회하지 않는다. 이후 새 작업에서 실제 `list_workspaces`와 페이지 조회를 확인한다.
5. `OAUTH_REFRESH_UNCERTAIN_RELOGIN_REQUIRED`는 갱신 응답 유실로 재사용을 막은 상태다. `login`을 다시 실행한다. 프로세스가 종료되면 SQLite 운영체제 잠금이 자동 해제된다. `OAUTH_REFRESH_LOCKED`는 다른 프로세스가 실행 중일 수 있으므로 잠금 파일을 삭제하지 않는다.
6. 사용자가 서버 연결을 철회했거나 권한을 변경한 경우 자동 복구를 보장하지 않는다. Platform 연결 관리 `https://console.doraft.com/settings/connections`에서 확인하고 필요하면 동일한 helper `login`으로 재인증한다. ALL은 이후 참여 Workspace도 포함한다. 권한 확대는 사용자 요청 없이 수행하지 않는다.

Codex를 사용하는 클라이언트에는 같은 Wiki MCP를 `doraft setup`으로 중복 등록하지 않는다. 네이티브 연결 UI나 `codex mcp login`으로 별도 OAuth를 만들지 않는다.

### `invalid_target` 복구

로그인 뒤 `invalid_target`이면 인증 요청의 `resource`가 현재 `https://mcp.doraft.com/wiki`인지 확인한다. 이전 `https://api.doraft.com/mcp/wiki`를 요청하면 설치 캐시가 오래되었을 수 있다. 토큰·인가 코드·전체 인증 URL을 공유하지 않는다.

1. `codex plugin marketplace list --json`으로 `doraft`의 로컬 경로를 확인한다. 저장소를 옮겨 경로가 더 이상 존재하지 않으면 `codex plugin marketplace remove doraft` 후 `codex plugin marketplace add https://github.com/doraft-labs/doraft-plugins.git`로 다시 등록한다. 로컬 개발에서는 `.agents/plugins/marketplace.json`이 있는 doraft-plugins 레포 루트를 지정한다.
2. `codex plugin add doraft-wiki@doraft`로 최신 패키지를 다시 설치한다. 소스 저장소에서는 `npm run verify:codex`로 마켓플레이스 경로·설치 버전·설치 MCP 주소·운영 OAuth `resource`가 모두 같은지 검사한다. 검사가 실패하면 재인증만 반복하지 말고 표시된 불일치를 먼저 고친다.
3. 위 공유 helper의 `login` 절차로 재연결하고 새 작업에서 실제 도구 호출을 확인한다.

## Claude

이 플러그인은 Claude에는 스킬만 제공하고 MCP 서버를 포함하지 않는다. Claude Code 로컬/데스크톱/웹, Claude Code 클라우드 세션 모두 같은 절차를 따른다.

1. 이미 Wiki MCP가 연결되어 있는지 클라이언트의 커넥터/MCP 화면에서 확인한다. 플러그인 설치 사실만으로 MCP 연결이나 인증 성공을 주장하지 않는다.
2. claude.ai 계정 설정의 사용자 지정 커넥터(custom connector)에 원격 MCP 주소 `https://mcp.doraft.com/wiki`를 추가하고 브라우저 OAuth를 완료한다(인가 서버는 그대로 `https://api.doraft.com`). 사용자는 Doraft 로그인 후 Workspace와 읽기·쓰기 권한을 승인한다.
3. Claude Code CLI는 claude.ai 구독으로 로그인한 세션에서만 이 커넥터를 불러온다. API 키 인증으로 Claude Code를 쓰는 경우 커넥터를 불러올 수 없으므로 `doraft setup --client claude-code`로 독립 MCP를 연결한다. 같은 클라이언트에 커넥터와 `doraft setup` MCP를 동시에 등록하지 않는다.
4. `list_workspaces`를 호출해 실제 접근을 확인한다. 목록이 비어 있으면 승인 Workspace와 현재 멤버십을 확인한다. Wiki 페이지 조회가 성공하기 전에는 문서 접근이 검증되었다고 하지 않는다.
5. 실패하면 Platform 연결 관리 `https://console.doraft.com/settings/connections`에서 해당 연결의 범위·만료·철회 여부를 확인한다. 범위 편집이 제공되면 새 Workspace를 기존 연결에 추가하고 저장한 뒤 실제 조회를 확인한다. ALL은 이후 참여 Workspace도 포함하고 SELECTED는 직접 추가한다. 권한 확대는 사용자 요청 없이 수행하지 않는다. 연결이 만료·철회됐거나 앱 요청 권한이 달라진 경우 클라이언트에서 재인증한다. 인증값을 채팅, 명령 인자, URL, 설정 파일에 복사하도록 요청하지 않는다.

## CLI와 웹 연결

`doraft setup`은 독립 MCP 연결을 설정하는 대안이다. Codex 플러그인이나 Claude 커넥터를 이미 사용하는 클라이언트에는 같은 Wiki MCP를 중복 등록하지 않는다. 로컬 CLI에서 연결한 상태로 플러그인/커넥터 경로로 전환하면, 기존 연결의 로컬 설정을 먼저 제거하되 서버 권한 철회와 구분한다.

이전 주소(`https://api.doraft.com/mcp/wiki` 또는 `https://api.doraft.com/mcp`)로 연결했다면 그 등록은 새 주소 `https://mcp.doraft.com/wiki`에서 재사용되지 않는다. 옛 주소로 발급된 토큰은 옛 주소에서만 동작하므로 자동으로 옮기지 않는다. 기존 연결을 제거하고 새 주소로 다시 연결/재인증해야 한다.

Claude Desktop/웹, Claude Code 클라우드 세션, ChatGPT에서는 사용자 지정 커넥터 UI에 위 MCP URL을 넣고 OAuth를 완료한다. 커넥터로 연결하면 이 스킬과 `use-doraft-wiki`는 서버 리소스 `skill://doraft/<skill>/SKILL.md`로도 제공되므로 플러그인 설치 없이 도구와 스킬을 함께 사용한다. Claude Code 로컬처럼 플러그인(스킬)과 커넥터(MCP)를 같은 클라이언트에서 함께 쓰는 것은 중복이 아니다. 다만 같은 클라이언트에서 Wiki MCP를 커넥터·`doraft setup`·Codex 플러그인 중 두 경로로 중복 등록하지 않는다. 사용 중인 계정에 해당 UI가 없으면 그 제한을 보고하며 연결 완료로 표시하지 않는다. 브라우저 자동 열기가 실패하면 URL을 제공한다.

PAT 직접 입력은 안전한 입력/환경 주입을 지원하는 CLI에서만 사용한다. Codex의 CLI PAT 모드는 실행 중인 자식 세션에만 유효하며 Codex 데스크톱이나 다음 세션까지 공유되지 않는다.

## 서버 지침 bootstrap의 최초 설정과 한계

- Codex는 설치한 스킬과 인라인 MCP, Claude는 허용 계정의 원격 connector와 선택적 skills-only 패키지, ChatGPT는 계정 사용자 지정 앱 설정면을 사용한다. 제품/버전/계정에 따라 스킬·instructions·resource 자동 적용이 다르며 이 패키지는 전역 설정·시작/압축 hook을 자동 설치하지 않는다.
- 이 계약을 지원하는 최초 설정 후 실제 세션에서 `list_workspaces` → `get_instruction_manifest` → `get_assistant_context` → 허용 쓰기 → checkpoint → 다른 세션 조회를 확인한다. 설치·인증·tools/list 성공만으로 실제 bootstrap 자동 호출이나 지침 준수를 검증했다고 말하지 않는다.
- 서버 활성 지침 변경은 다음 manifest/context 조회로 전달하므로 매 변경마다 재설치하지 않는다. manifest 미지원 서버는 기존 수동 Wiki 기능만 호환하며 신규 assistant 연동은 미지원이다. 오류/권한 거부를 legacy fallback으로 우회하지 않는다.
- 사용자 계정의 플러그인 설치·권한 확대·새 credential·OAuth grant·유료 모델 호출 전에 구체적인 대상·권한·비용을 보고한다. API 키를 찾거나 복사해 설정하지 않는다. 실 client 검증은 wire 가짜 client 테스트와 구별하고, 별도 설치나 모델 실행이 필요하면 그 단계만 미검증으로 남긴다.

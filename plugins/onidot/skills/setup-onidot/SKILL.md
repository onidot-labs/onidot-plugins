---
name: setup-onidot
description: 선택한 onidot 인스턴스의 MCP 연결, OAuth, Space 승인 범위와 연결 오류를 안내합니다.
---

# onidot 연결

onidot 플러그인은 인스턴스 주소를 고정하지 않는다. 연결마다 사용자가 선택한 앱 주소 `APP_URL`, MCP 주소 `MCP_URL`, 별칭 `ALIAS`를 사용한다. 등록 이름은 `onidot-<ALIAS>`다. 예를 들어 집은 `onidot-home`, 회사 로컬은 `onidot-work`로 구별할 수 있으나 이 이름이나 개인 도메인을 필수값으로 쓰지 않는다.

## 연결 절차

1. 설치한 인스턴스의 앱 설정에서 앱 주소와 MCP 주소를 확인한다. 기본 MCP 주소는 앱 주소의 `/mcp`지만 별도 호스트 설정이 있으면 그 정확한 주소를 사용한다. 요청 Host나 이전 인스턴스 주소로 추측하지 않는다.
2. 클라이언트의 MCP/커넥터 설정에서 선택한 주소와 별칭을 입력한다. 기존 동일 연결이 있으면 중복 등록하지 않는다. `oni` 연결 등록은 후속 제공 기능이며 현재 설치되어 있다고 가정하지 않는다. 사용 중인 클라이언트가 제공하는 수동 원격 MCP 등록 절차를 따른다.
3. 해당 인스턴스의 OAuth 안내를 따라 로그인한다. 승인할 Space와 READ/WRITE 범위는 사용자 요청에 맞춘다. 비밀번호·승인·토큰 입력은 사람이 수행하고 비밀값을 화면 캡처·진단 로그·보고서에 남기지 않는다.
4. 초기화 결과의 `serverInfo.name=onidot`, 인스턴스 별칭·제공 방식·연결 모드를 확인한다. `list_spaces`와 허용된 페이지의 실제 조회를 실행해 연결을 검증한다. 설정 화면 성공만으로 완료라고 하지 않는다.
5. **쓰기는 읽기·쓰기 연결에, 읽기 전용 연결은 참고만** 한다. READ 연결에는 쓰기 도구가 보이지 않으며 직접 요청도 서버가 거부한다. 쓰기 실패를 다른 인스턴스에 저장하는 방식으로 우회하지 않는다.

## 전환과 오류 확인

- 옛 `dft_` 토큰은 받지 않는다. 전환 후 선택한 인스턴스로 다시 인가한다. 새 PAT/access/refresh 접두어는 `oni_pat_`·`oni_at_`·`oni_rt_`다. 토큰 내용을 출력하지 않는다.
- OAuth scope는 `onidot:wiki:read`·`onidot:wiki:write`·`offline_access`다. 서버는 옛 이름 `doraft:wiki:*`로 한 요청도 같은 scope로 받는다. 새 연결과 설정에는 새 이름을 쓴다.
- `invalid_target`·`invalid_scope`이면 실제 연결의 client/app, resource, 요청 scope와 선택한 서버의 메타데이터를 비교한다. 로컬 플러그인과 클라우드 커넥터의 인증을 같은 것으로 취급하지 않는다.
- 401은 다시 로그인하고, 403은 승인 범위와 현재 Space/페이지 권한을 확인한다. 404는 새 세션 초기화 또는 현재 페이지 권한을 확인한다. 같은 사용자라도 연결별 승인 범위를 다시 조회한다.
- 문서 작업은 `skill://onidot/use-onidot/SKILL.md`를 따른다. 특정 MCP 등록 이름을 작업 스킬에 고정하지 않는다.

## 클라이언트별 수동 등록

플러그인 `onidot@onidot`은 공통 스킬을 제공한다. Codex manifest의 `mcpServers`는 빈 목록이고 Claude 패키지는 MCP를 선언하지 않는다. 연결은 인스턴스마다 클라이언트 설정에 등록한다. `oni`가 제공되기 전의 수동 절차이며, 이 안내를 읽었다는 이유로 사용자 계정에 설치하거나 권한을 확대하지 않는다.

### 준비와 공통 확인

앱의 연결 설정에 표시된 `APP_URL`·`MCP_URL`을 그대로 입력한다. 아래 `<...>`는 사용자가 선택한 실제 값으로 바꿀 매개변수다. URL에 비밀값을 넣지 않는다. 별칭은 영문 소문자로 시작하고 영문 소문자·숫자·하이픈만 쓴다.

```sh
APP_URL='<앱 주소>'
MCP_URL='<MCP 주소>'
ALIAS='dev'
MCP_NAME="onidot-${ALIAS}"
```

집 셀프호스팅은 `onidot-dev`, 회사 로컬은 별도의 URL과 `ALIAS='work'`를 입력해 `onidot-work`로 등록하는 예시다. URL 기본값은 없다. 기대 결과는 서로 다른 이름·주소의 연결 두 개다. 이미 같은 주소의 연결이 있으면 중복 등록하지 않는다.

비밀값·OAuth 로그인·Space 선택과 READ/WRITE 승인은 **사람이 직접** 수행한다. AI 에이전트는 사용자가 요청한 연결의 공개 URL·별칭·명령만 준비하고, 로그인 화면이나 전체 인가 URL·토큰을 로그에 남기지 않는다.

### Codex 설정

공통 플러그인 설치가 요청된 경우 다음 명령을 사용한다.

```sh
codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git
codex plugin add onidot@onidot
```

기대 결과는 설치 이름 `onidot@onidot`, 버전 `0.15.6`이다. 기존 git marketplace는 `codex plugin marketplace upgrade onidot`로 갱신한 뒤 설치한다. `codex plugin marketplace list --json`으로 경로를 확인한다. 경로가 사라졌다면 해당 항목만 `codex plugin marketplace remove onidot` 후 다시 등록한다.

인스턴스는 플러그인과 별도로 등록한다.

```sh
codex mcp add "$MCP_NAME" --url "$MCP_URL"
codex mcp list
# 사람이 직접 실행하고 브라우저에서 로그인·승인한다.
codex mcp login "$MCP_NAME"
```

같은 설정을 수동으로 만들려면 `${CODEX_HOME:-$HOME/.codex}/config.toml`의 해당 항목에 실제 URL을 넣는다. 두 방식 중 하나만 사용하고 기존 설정을 보존한다.

```toml
[mcp_servers.onidot-dev]
url = "<집 인스턴스 MCP_URL>"

[mcp_servers.onidot-work]
url = "<회사 로컬 MCP_URL>"
```

기대 결과는 `codex mcp list`와 새 세션의 `/mcp`에 선택한 별칭이 표시되는 것이다. 로그인 성공 뒤에도 아래 실제 도구 검증을 수행한다.

### 선택적 Codex 공유 OAuth helper

여러 로컬 세션의 일회용 refresh를 직렬화해야 한다면 Node.js 24 이상과 `http_headers_helper`를 지원하는 로컬 macOS/Linux Codex에서 패키지 helper를 사용할 수 있다. 네이티브 OAuth와 helper 중 하나만 해당 연결의 인증원으로 쓴다. 기존 네이티브 인증을 자동으로 지우지 않는다. Windows·원격 실행은 미검증이다.

```sh
export ONIDOT_ALIAS="$ALIAS"
export ONIDOT_APP_URL="$APP_URL"
export ONIDOT_MCP_URL="$MCP_URL"
# READ 연결이면 read scope만 요청한다. 승인 범위는 사람이 직접 선택한다.
export ONIDOT_SCOPE='onidot:wiki:read offline_access'
HELPER="${CODEX_HOME:-$HOME/.codex}/plugins/cache/onidot/onidot/0.15.6/scripts/oauth-helper.mjs"
# 사람이 직접 로그인한다. headers는 비밀 헤더를 출력하므로 진단용으로 실행하지 않는다.
node "$HELPER" login
node "$HELPER" status
```

WRITE가 승인된 연결의 scope는 `onidot:wiki:read onidot:wiki:write offline_access`다. helper를 연결에 쓸 때는 해당 `mcp_servers` 항목의 `http_headers_helper` 명령 안에 동일한 공개 `ONIDOT_ALIAS`·`ONIDOT_APP_URL`·`ONIDOT_MCP_URL`·`ONIDOT_SCOPE` 값을 명시한다. 새 프로세스가 위 셸의 export를 자동 상속한다고 가정하지 않는다.

```toml
[mcp_servers.onidot-dev]
url = "<MCP_URL>"
http_headers_helper = 'ONIDOT_ALIAS=home ONIDOT_APP_URL="<APP_URL>" ONIDOT_MCP_URL="<MCP_URL>" ONIDOT_SCOPE="onidot:wiki:read offline_access" node "<설치 경로>/scripts/oauth-helper.mjs" headers'
```

기대 결과는 `status`의 `authenticated=true`다. helper는 연결 정보가 없으면 `ONIDOT_CONNECTION_REQUIRED`로 거부하고 기본 서버로 보내지 않는다. 별칭·앱·리소스·scope별로 새로운 로그인 상태와 잠금을 나누며 옛 helper의 토큰은 복사하지 않는다. scope의 옛 이름과 새 이름은 같은 권한이므로 같은 로그인 상태를 쓴다. 기존 `ONIDOT_SCOPE`의 옛 이름을 새 이름으로 바꿔도 다시 로그인하지 않는다. `OAUTH_REFRESH_UNCERTAIN_RELOGIN_REQUIRED`·`OAUTH_RESOURCE_CHANGED_RELOGIN_REQUIRED`면 사람이 같은 연결로 다시 로그인한다. `OAUTH_REFRESH_LOCKED`면 다른 갱신이 끝나길 기다리고 잠금 파일을 삭제하지 않는다. 0.14.0 이하 helper는 새 scope 이름의 갱신 응답을 `INVALID_OAUTH_TOKEN_RESPONSE`로 거부한다. 새 이름을 내는 서버를 쓰기 전에 플러그인을 갱신하고 `http_headers_helper`의 설치 경로를 바꾼다. 로그인 상태는 그대로 쓴다. 이미 거부됐으면 사람이 `login`을 다시 실행한다.

### Claude Code 독립 연결

```sh
claude plugin marketplace add onidot-labs/onidot-plugins
claude plugin install onidot@onidot --scope user
claude mcp add --transport http --scope user "$MCP_NAME" "$MCP_URL"
claude mcp get "$MCP_NAME"
```

기대 결과는 user scope의 HTTP 연결 이름·URL이 입력값과 일치하는 것이다. Claude Code의 `/mcp`에서 해당 연결을 선택해 **사람이 직접** OAuth 로그인한다. CLI가 `claude mcp login`을 지원하면 `claude mcp login "$MCP_NAME"`도 사용할 수 있다. 계정 커넥터가 같은 URL을 제공하면 독립 연결을 중복 등록하지 않는다. Claude Code 클라우드 세션의 네트워크와 설정 접근 가능 여부는 별도로 확인한다.

### claude.ai 사용자 지정 커넥터

1. 셀프호스팅 도메인의 정확한 `MCP_URL`이 Claude의 원격 네트워크에서 접근 가능한지 운영자가 확인한다. 클라우드 커넥터는 회사 PC의 localhost에 연결할 수 없다. 회사 로컬은 위 로컬 클라이언트 연결을 사용하며 이 태스크는 서버를 외부에 공개하지 않는다.
2. claude.ai의 Customize → Connectors → Add custom connector에서 이름 `onidot-<ALIAS>`와 `MCP_URL`을 입력한다. 조직 계정은 해당 관리자의 추가 권한이 필요하다.
3. **사람이 직접** OAuth 로그인·Space·연결 모드를 승인한다. 기대 결과는 선택한 별칭의 커넥터가 연결된 상태다. 웹에서 만든 계정 연결을 지원하는 Desktop·모바일에서도 사용한다.
4. Claude Code가 claude.ai 구독 인증을 사용하면 `/mcp`에서 계정 커넥터를 확인한다. API 키·외부 제공자 인증으로 해당 커넥터를 불러온다고 가정하지 않는다. 같은 URL의 독립 MCP와 중복 등록하지 않는다.

ChatGPT 계정 사용자 지정 앱도 선택한 인스턴스의 공개 MCP_URL과 OAuth로 연결한다. 계정 앱의 인증은 로컬 Codex 인증과 별개다. 제품·계정에 UI가 없다면 지원 제한을 보고한다.

### 실제 연결 검증과 문제 해결

각 연결에서 initialize의 `serverInfo.name=onidot`, 인스턴스 별칭·제공 방식·연결 모드(READ/WRITE)를 확인한다. `list_spaces`로 승인 범위를 조회하고, 반환된 Space의 허용 페이지에 `get_page`를 호출한다. READ 목록에는 쓰기 도구가 없어야 한다. 초기화 정체나 모드가 불명확하면 쓰기를 진행하지 않는다. WRITE의 실제 저장은 별도로 요청된 페이지에만 수행한다.

`npm run verify:codex -- --alias "$ALIAS" --mcp-url "$MCP_URL"`는 설치 버전·별칭 등록 URL·해당 서버의 OAuth resource를 비교하는 읽기 전용 진단이다. 설치·인증·도구 노출·실제 조회는 각각 확인하며 진단 성공만으로 문서 작업 성공이라고 하지 않는다. `invalid_target`이면 resource, `invalid_scope`이면 실제 scope를 선택한 서버 메타데이터와 비교한다.

옛 설치 이름 `doraft-wiki@doraft`와 이전 주소의 로그인은 새 연결에서 재사용되지 않는다. 사람이 다시 연결·인가하고 실제 조회를 검증한 뒤 해당 옛 로컬 등록만 제거한다. 다른 플러그인·서버 grant·문서는 삭제하지 않는다.

## 서버 bootstrap과 원본

실제 세션에서 `list_spaces` → `get_instruction_manifest` → `get_assistant_context`를 확인한다. 자동 호출 여부는 실제 클라이언트에서 검증한다. 서버 활성 지침 변경마다 플러그인을 재설치하지 않는다. manifest 미지원은 수동 호환 범위이고 권한 거부는 우회하지 않는다. OAuth grant·유료 모델 실행과 계정 설치는 별도 요청 범위에 따른다.

배포 스킬 원본은 onidot-plugins의 `source/skills` 하나다. `plugins/`·`server-resources/`는 생성물이므로 직접 고치지 않는다. 서버는 고정 commit·SHA256을 검증해 반입한다. W1-22 서버 snapshot의 이름·연결·모드·업무 계약을 유지하고 클라이언트 등록 안내만 덧붙인다. 서버 저장소의 기존 snapshot 교체는 서버 소유자가 별도로 수행한다.

공식 근거: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude 원격 커넥터](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## 완료 hooks 확인

- 플러그인 0.15.6의 완료 검사는 `oni recording-check --client claude|codex`를 사용한다. **이 기능이 포함된 oni와 함께 업데이트**한다(출시번호 미정). Node/Python 설치나 추가 LLM 호출이 필요하지 않다. oni 미설치·구버전·검사 실패이면 고정된 누락 확인 불가 안내를 보여 주며 중단하거나 저장 성공으로 판단하지 않는다. `onidot-guide`의 최종 답변 전 검토를 적용하고 `remember` 성공을 확인하지 못한 기록은 미저장으로 알린다.
- Claude Code는 기존 `claude/hooks.json`, Codex는 `codex/hooks.json`을 각 manifest에 명시하여 SessionStart와 Stop command를 실행한다. 양쪽에서 자동 탐지할 `hooks/hooks.json`은 생성하지 않아 중복 검사를 막는다. Codex는 `PLUGIN_ROOT`, Claude는 `CLAUDE_PLUGIN_ROOT`로 설치 경로를 읽는다.
- Codex는 설치만으로 hooks를 신뢰하지 않는다. 사용자가 `/hooks`에서 현재 정의를 직접 검토하고 trust해야 한다. 변경한 정의에는 재검토가 필요하며 신뢰 절차를 우회하지 않는다. 사용자 설정 파일을 자동 수정하지 않는다.
- hooks를 지원하지 않는 앱은 공통 지침만 적용한다. 실제 클라이언트 hook 실행과 저장 성공은 별도로 검증하며 설치·패키징 성공으로 대체하지 않는다. 대화 원문 전체나 비밀은 기록하지 않고 로컬 메모리로 대체 저장하지 않는다.


## 서버 업데이트 후 도구 목록 갱신

서버 배포, 플러그인 설치, 계정 커넥터 목록은 독립 상태다. 서버는 기존 bootstrap 응답의 `toolCatalog`로 현재 credential에 허용된 전체 도구와 revision을 제공한다. 서버를 재시작하면 이전 프로세스 세션이 끝나므로 `notifications/tools/list_changed`만으로 기존 클라이언트 캐시가 갱신된다고 보장하지 않는다. SDK는 활성 연결 중 도구 등록 변경 알림을 지원하지만 호스트의 수신·재조회는 별도다.

| 클라이언트 | 확인된 지원과 처리 |
| --- | --- |
| ChatGPT 사용자 지정 앱 / Codex 계정 앱 | ChatGPT 앱 설정의 **도구 새로 고침(Refresh apps/tools)**으로 도구·설명·서버 지침을 갱신한다. 계정 앱 자동 수신은 공식 문서에서 보장되지 않는다. 브라우저 도구가 있고 기존 권한 범위의 연결 복구가 승인돼 있으면 현재 사용자가 선택한 앱의 관리 화면에서 이름·MCP URL을 확인한 뒤 자동 조작한다. 이 화면의 위치와 ID는 사용자별로 찾으며 특정 계정을 하드코딩하지 않는다. 갱신 후 실제 노출 목록과 조회 성공을 확인한다. |
| Codex native MCP | 공식 문서의 `/mcp`는 상태 확인이며 갱신 명령이라고 단정하지 않는다. 실제 버전의 연결 제어를 확인하고 지원되는 재연결을 사용한다. 자동 제어가 없으면 사용자에게 연결 상태 확인과 새 세션에서 검증을 안내한다. 기존 작업을 임의 종료하지 않는다. |
| Claude Code | 설정 변경/도구 문제에 재시작 안내가 있지만 원격 도구 변경의 자동 갱신 보장은 확인되지 않았다. 현재 `/mcp` UI에서 지원되는 재연결을 확인하여 사용하고, 없으면 작업을 보존한 뒤 사용자에게 재시작/새 세션 검증을 안내한다. |
| Claude Desktop | 로컬 확장 레지스트리의 재시작 안내를 원격 커넥터 자동 갱신 보장으로 해석하지 않는다. 현재 커넥터 설정의 지원되는 갱신 수단을 사용하고 실제 조회를 확인한다. |
| Responses API 자체 통합 | 기존 `mcp_list_tools`가 문맥에 남으면 매 턴 다시 가져오지 않는다. 통합을 소유한 경우 이전 목록을 재사용하지 않는 새 discovery 요청을 구성하고 재수집한다. 일반 계정 앱에 이 API 제어가 있다고 가정하지 않는다. |

사용자 조치가 필요한 경우 앱 이름·현재 MCP URL·누락 도구·확인 방법을 짧게 안내한다. OAuth 재승인·토큰 입력·권한 확대는 사람에게 맡긴다. 서버/플러그인만으로 모든 외부 클라이언트의 자동 갱신을 보장하지 않는다. 각 클라이언트의 실제 hot-refresh 지원은 버전별 런타임 검증 전에는 미검증이다.

공식 근거: [ChatGPT custom MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server), [Responses MCP 캐시](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Codex MCP 상태](https://learn.chatgpt.com/docs/developer-commands), [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp), [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools). SDK가 협상한 프로토콜 버전의 알림 규칙을 적용하며 최신 문서의 subscriptions 동작을 구버전에 소급하지 않는다.

### 목록 비교기 입력

- Node가 이미 있는 환경에서는 설치 경로의 `scripts/catalog-check.mjs`에 JSON `{catalog: toolCatalog, observed: [{name, digest?}], complete: true, previousRevision?}`를 표준입력으로 전달한다. 이름은 현재 연결의 접두어만 제거한 원래 MCP 이름이다. 다른 연결의 도구를 합치지 않는다. digest는 이전 실제 수집·검증된 도구 계약에서만 가져오며 현재 서버 값을 observed로 복사하지 않는다. 출력 `refresh_required`는 갱신 필요, `names_match`는 이름만 일치, `current`는 제공된 digest까지 일치, `unverified`는 전체 목록 미확인, `unsupported`는 서버 진단 미지원이다. 종료 코드는 일치 0, 갱신 필요/미확인 2, 입력 오류 1이다. Node가 없으면 설치하지 않고 같은 비교를 직접 수행한다.

현재 catalog는 현재 연결에서 실제 조회한 값이고 observed는 별도로 노출된 도구 목록이다. 이전에 검증한 revision은 같은 연결·권한 범위에서만 재사용한다. 도구 수를 고정하지 않고 READ/WRITE 및 모듈 범위의 차이를 반영한다. toolCatalog가 없거나 전체 목록을 확인할 수 없으면 미지원/미검증이며 정상으로 판정하지 않는다.

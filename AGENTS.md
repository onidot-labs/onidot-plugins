# onidot Plugins

상위 onidot 작업공간 지침을 따른다. 명세·계획·결과 정본은 onidot-studio Wiki다.

- onidot-labs/onidot-plugins가 onidot 플러그인 원본·생성기·카탈로그·릴리스를 소유한다. 서버 코드는 onidot-studio가, 공통 인증 정책은 onidot-platform이 소유한다.
- source/products.json과 source/<product>.json, source/skills(wiki), source/crew/(crew 역할 본문·스킬·세션 안내)가 정본이다. plugins/, server-resources/, catalog.json 및 두 marketplace는 npm run generate로 생성한다.
- 출시 Wiki 플러그인은 ID·이름 onidot 하나를 유지한다. 서버 반입용 product ID wiki와 외부 MCP/OAuth 계약은 유지한다. 이 저장소에는 onidot(Wiki, product ID wiki)과 onidot-crew(역할 에이전트·업무 스킬, product ID crew) 두 제품만 두며 다른 제품의 planned 항목을 넣지 않는다. 서버 반입(server-resources)과 OAuth helper·완료 기록 검사는 wiki 전용이다. 클라이언트 접미사로 다른 플러그인을 만들지 않는다.
- W1-22P부터 Codex manifest의 inline MCP 목록은 비워 두고 연결마다 사용자 설정에 `onidot-<별칭>`으로 등록한다. Claude는 계정 connector 또는 독립 등록 + skills-only 패키지다. 특정 인스턴스 주소를 패키지에 고정하지 않는다. 루트 .mcp.json은 Claude Code에 중복 MCP를 등록하므로 생성하지 않는다.
- 미출시 제품은 status=planned이며 카탈로그 설치 목록에 넣지 않는다.
- 생성기는 레포 외부에 쓰지 않는다. 서버는 고정 commit과 SHA256을 확인해 server-resources를 반입한다.
- 이슈별 브랜치와 PR로 main에 반영한다. clean commit에서 npm run verify:local(기존 npm test의 manifest 검증과 npm run package)을 통과한 뒤 릴리스한다. #11부터 자동 verify Actions는 실행하지 않는다. 로컬 결과만으로 서버 배포 권한을 인증하지 않으며 보호 규칙 변경은 별도 승인 대상이다.
- 사용자 설치 전환 전 새로운 배포본을 검증하고 다른 플러그인·서버 grant·문서를 삭제하지 않는다.

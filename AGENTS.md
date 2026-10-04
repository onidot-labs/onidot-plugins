# onidot Plugins

상위 onidot 작업공간 지침을 따른다. 명세·계획·결과 정본은 onidot-studio Wiki다.

- onidot-labs/onidot-plugins가 onidot 플러그인 원본·생성기·카탈로그·릴리스를 소유한다. 서버 코드는 onidot-studio가, 공통 인증 정책은 onidot-platform이 소유한다.
- source/products.json과 source/<product>.json, source/skills가 정본이다. plugins/, server-resources/, catalog.json 및 두 marketplace는 npm run generate로 생성한다.
- 출시 Wiki 플러그인은 ID·이름 onidot 하나를 유지한다. 서버 반입용 product ID wiki와 외부 MCP/OAuth 계약은 유지한다. 이 저장소에는 onidot 제품만 두며 다른 제품의 planned 항목을 넣지 않는다. 클라이언트 접미사로 다른 플러그인을 만들지 않는다.
- Codex는 manifest inline MCP, Claude는 계정 connector + skills-only 패키지다. 루트 .mcp.json은 Claude Code에 중복 MCP를 등록하므로 생성하지 않는다.
- 미출시 제품은 status=planned이며 카탈로그 설치 목록에 넣지 않는다.
- 생성기는 레포 외부에 쓰지 않는다. 서버는 고정 commit과 SHA256을 확인해 server-resources를 반입한다.
- 이슈별 브랜치와 PR로 main에 반영한다. clean commit에서 npm run verify:local(기존 npm test의 manifest 검증과 npm run package)을 통과한 뒤 릴리스한다. #11부터 자동 verify Actions는 실행하지 않는다. 로컬 결과만으로 서버 배포 권한을 인증하지 않으며 보호 규칙 변경은 별도 승인 대상이다.
- 사용자 설치 전환 전 새로운 배포본을 검증하고 다른 플러그인·서버 grant·문서를 삭제하지 않는다.

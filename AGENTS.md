# onidot Plugins (공개 미러)

상위 onidot 작업공간 지침을 따른다.

- 이 저장소는 생성물만 두는 미러이며 직접 고치지 않는다. 원본·생성기·시험은 비공개 저장소 onidot-labs/onidot-studio-plugin이 소유한다.
- 갱신 절차: onidot-studio-plugin에서 `node scripts/generate.mjs` 후 `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `catalog.json`, `plugins/onidot-studio/**`, `source/wiki.json`을 이 저장소로 복사한다.
- 서버의 업데이트 확인이 `https://raw.githubusercontent.com/onidot-labs/onidot-plugins/main/source/wiki.json`의 `version`을 읽는다. 이 경로와 필드를 유지한다.
- 이슈별 브랜치와 PR로 main에 반영한다.

# Onidot Plugins

이 저장소는 Onidot Studio 플러그인(`onidot-studio`)의 공개 배포본이다. 원본은 비공개 저장소에서 관리하고, 여기에는 원본에서 생성한 결과만 둔다. 이 저장소를 직접 고치지 않는다.

## 설치

Claude Code:

```sh
claude plugin marketplace add onidot-labs/onidot-plugins
claude plugin install onidot-studio@onidot-studio --scope user
```

Codex:

```sh
codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git
codex plugin add onidot-studio@onidot-studio
```

설치 뒤 서버 연결과 로그인은 플러그인의 `setup-onidot` 스킬 안내를 따른다.

## 옛 플러그인에서 옮기기

옛 `onidot`, `onidot-crew` 플러그인은 2026-10-19에 이 카탈로그에서 내렸다. 그 기능은 `onidot-studio` 플러그인과 Onidot Orbit으로 옮겼다. 옛 마켓 `onidot`으로 설치했다면 지우고 다시 설치한다.

```sh
claude plugin uninstall onidot@onidot
claude plugin marketplace remove onidot
claude plugin marketplace add onidot-labs/onidot-plugins
claude plugin install onidot-studio@onidot-studio --scope user

codex plugin marketplace remove onidot
codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git
codex plugin add onidot-studio@onidot-studio
```

`source/wiki.json`의 `version`은 서버의 업데이트 확인이 읽는다. 경로와 필드를 바꾸지 않는다.

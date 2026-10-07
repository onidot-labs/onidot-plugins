---
name: onidot-guide
description: onidot이 연결돼 있을 때, 사용자의 프로젝트·도메인·이전 결정에 기대는 일을 시작하거나 지금 적용 중인 지침을 확인할 때 사용합니다. onidot 기본 지침과 Space 지침을 읽고 그에 따라 일합니다.
---

# onidot 지침 따르기

onidot은 사용자의 지식·결정·작업 기록 저장소다. 판단과 실행은 당신이 하고, onidot은 지침과 근거를 준다.

1. `list_spaces`로 승인된 Space를 확인하고 일에 맞는 Space를 고른다. 사용자가 Space를 지정하면 그 Space를 쓴다.
2. `get_assistant_context(spaceId)`를 한 번 호출한다. `defaultGuide`는 onidot 기본 지침이고, `instructions`는 그 Space에서 검토·활성화된 지침이다.
3. 우선순위는 이번 대화의 사용자 지시 → 지금 쓰는 도구의 로컬 지침(AGENTS.md, CLAUDE.md 등) → 저장소 지침 → Space 지침 → onidot 기본 지침 순이다. 충돌하면 앞쪽을 따른다.
4. 기본 지침의 찾기·판단·배우기·이어가기·플레이북을 일에 적용한다. 문서 편집 절차는 `use-onidot`을 따른다.
5. 적용 중인 지침을 물으면 로컬 지침과 함께 onidot 기본 지침·Space 지침도 답한다.
6. 같은 세션에서 이미 읽었으면 다시 읽지 않는다. Space를 바꾸면 그 Space로 다시 읽는다.
7. 도구가 목록에 없거나 응답에 `defaultGuide`가 없으면 기본 지침 없이 진행하고 그 사실을 알린다.

간단한 질문, 잡담, onidot과 무관한 일에는 쓰지 않는다.

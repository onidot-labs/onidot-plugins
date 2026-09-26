---
name: use-doraft-wiki
description: Doraft Wiki 문서 검색·조회, 페이지 작성·수정·저장, 임시 초안, 댓글·첨부·공유 작업을 수행합니다. 사용자가 Doraft의 문서를 읽거나 정리하거나 편집하려 할 때 사용합니다. Tasks 관리에는 사용하지 않습니다.
---

# Doraft Wiki 사용

현재 연결된 Wiki MCP 도구의 실제 입력 스키마를 따른다. 존재하지 않는 도구나 ID를 만들지 않는다. Tasks 도구는 이 플러그인의 범위에 없다.

## 조회

Wiki는 Workspace → 페이지 → 하위 페이지 구조다. Space 선택이나 내부 기본 공간을 안내하지 않는다. 생성·이동·가져오기는 Workspace와 선택적 부모 페이지를 사용한다.

- `list_workspaces`로 승인된 Workspace와 활성 제품을 확인한다. 사용자 요청에 Workspace가 명시되면 해당 범위로 제한한다. 후보가 여러 개이고 의도가 모호하면 대상만 질문한다.
- 이름·계층을 탐색할 때 `list_pages` 또는 `list_page_children`의 `includeContent=false` 경량 목록을 사용한다. 새 경로 조건을 지원하는 `list_pages`에서 발행 문서 전체를 탐색할 때는 `pathGlob="/**"`를 사용하고, 필요한 경우 `subtreeId`나 더 좁은 경로로 한정한다. 조건 없는 기존 목록은 미발행 문서를 포함하는 호환 동작이므로 발행 문서 검색과 구분한다.
- 기본 정확 찾기는 `grep_pages`로 수행한다. 기본값은 raw literal·`caseSensitive=true`이므로 정확한 문자열·식별자·코드·기호를 찾을 때 사용한다. 대소문자 무시는 `caseSensitive=false`를 명시하고, 정규식이 필요한 경우에만 `regex=true`와 실제 서버가 지원하는 RE2/J 문법을 사용한다.
- 여러 단어로 문서를 찾을 때는 `search_knowledge`를 사용한다. 기본 `sort="relevance"`는 정확한 제목·경로 일치, 제목·발췌문에서 검증한 전체 문구, 어휘 관련성 순으로 결과를 우선한다. 검색으로 회수한 문서를 최근 발행본 수정 시각 순으로 검토해야 할 때만 `sort="updated"`를 명시한다.
- 검색 결과의 `pageId`, `revisionId`, 원문 범위로 `read_page_excerpt`를 호출해 필요한 근거를 읽는다. 검색 뒤 최신 문서가 바뀌어도 근거를 임의의 새 버전으로 바꾸지 않는다. 긴 구간은 `nextByteOffset`으로 이어 읽는다.
- 해당 절 전체를 읽을 때는 `sectionRange.byteStart`를 `sectionStartByte`로 전달한다. 긴 절은 같은 `revisionId`·`sectionStartByte`를 유지하면서 `nextByteOffset`을 `byteOffset`으로 전달한다. 절 선택에 줄 범위를 함께 넣지 않는다. 여러 절에 걸친 일치의 전체 근거는 원래 `range`로 확인한다.
- `incomplete`, `hasMore`, `nextCursor`를 확인한다. 중단·출력 제한을 "검색 결과 없음" 또는 전체 검색 완료로 설명하지 않는다. 필요한 다음 페이지나 구간을 같은 범위로 조회한다.
- 새 검색 도구가 실제 목록에 없으면 기존 `search_pages`와 `get_page`로 허용된 조회를 진행하고 지원 여부를 밝힌다. `search_pages`는 대소문자를 구분하지 않는 substring AND·최신순 호환 검색이므로 기본 정확 찾기나 단어 기반 관련성 검색으로 설명하지 않는다. 도구 목록을 갱신하거나 새 연결 세션에서 지원 여부를 확인한다.
- `get_page`는 현재 발행본, `get_page_draft`는 수정 가능한 공동 초안 조회다. 버전·상태·크기만 필요하면 `includeContent=false`로 본문 없이 조회한다. 검색은 현재 발행본을 대상으로 하며 초안·과거 이력·첨부 내용 검색까지 수행했다고 확대하지 않는다.
- 목록·검색 결과는 본문 확인의 대체물이 아니다. 필요한 페이지를 실제로 읽고 출처와 조회 범위를 밝힌다. 접근 불가 페이지의 내용을 추측하지 않는다.

## 기존 문서 수정

발행된 문서를 고칠 때의 기본 절차는 **상태 조회 → 찾기 → 필요한 구간 읽기 → edit_page → 변경 요약 확인**이다. 본문 전체를 읽고 다시 보내지 않는다.

1. **상태 조회**: `get_page_draft(includeContent=false)`로 `draftVersion`·`basePublishedRevisionId`·`hasUnpublishedChanges`·`contentBytes`를 확인한다. `hasUnpublishedChanges=true`면 다른 사람이 남긴 미발행 변경이 있어 `edit_page`가 거부된다. 초안 내용을 확인해 사용자에게 알리고, 그 변경을 보존하는 방법을 정한 뒤 진행한다.
2. **찾기**: 고칠 위치를 `grep_pages`(정확한 문자열)나 `search_knowledge`로 찾는다. 두 도구가 목록에 없으면 `get_page`로 발행본을 읽는다.
3. **구간 읽기**: 찾은 위치 주변만 `read_page_excerpt`로 읽는다. 절 전체가 필요하면 `sectionStartByte`를 쓴다.
4. **edit_page**: 확인한 `draftVersion`을 `expectedDraftVersion`으로, `basePublishedRevisionId`(현재 발행 Revision ID)를 `expectedPublishedRevisionId`로, 새 `idempotencyKey`와 함께 보낸다. `operations`의 종류는 다음과 같다.
   - `replaceUniqueText`: `oldText`를 `newText`로 바꾼다. `oldText`는 읽은 원문을 공백·줄바꿈·기호까지 그대로 복사하고, 문서에서 한 번만 나오도록 앞뒤 문맥을 충분히 넣는다. 모든 등장을 바꿀 때만 `replaceAll=true`와 실제 등장 수 `expectedMatches`를 준다.
   - `append`: 본문 끝에 `text`를 그대로 붙인다. 줄바꿈을 자동으로 넣지 않으므로 필요하면 `text` 앞에 넣는다.
   - `setTitle`: 제목만 바꾼다.
   - 여러 곳은 한 요청의 `operations`에 모은다. 모든 연산은 같은 기준 문서에서 해석하므로, 앞 연산이 만든 글을 뒤 연산이 가리킬 수 없고 범위가 겹치면 전체가 거부된다.
   - 연산에 쓰지 않는 필드는 비워 둔다(채우면 입력 오류). `expectedPublishedRevisionId`는 필수다.
5. **변경 요약 확인**: 응답의 `applied`·`changedFields`·연산별 바이트 범위(`byteStart`·`byteEnd`·`newByteStart`·`newByteEnd`)·`bytesBefore`·`bytesAfter`로 결과를 확인한다. `ranges`는 연산마다 앞 20개까지만 싣고, 더 있으면 `rangeCount`·`rangesTruncated`로 알린다. 응답의 `draftVersion`과 `revisionId`는 다음 수정의 기준이다. 필요하면 바뀐 구간만 `read_page_excerpt`로 다시 읽는다. `applied=false`는 결과가 기존과 같아 저장하지 않았다는 뜻이다.

실패는 아무것도 바꾸지 않는다. 결과 텍스트는 `code=<CODE>; …` 형식으로 시작한다.

- `EDIT_TARGET_NOT_FOUND`·`EDIT_TARGET_NOT_UNIQUE`(`matchCount`)·`EDIT_MATCH_COUNT_MISMATCH`·`EDIT_RANGES_OVERLAP`: 구간을 다시 읽고 `oldText`나 연산을 고친다. `operation`은 `operations` 배열에서 0부터 센 위치다.
- `REVISION_CONFLICT`: 그 사이 문서가 바뀌었다. 상태를 다시 조회하고 바뀐 구간을 읽은 뒤 다시 계획한다. 버전 값을 임의로 올려 재시도하지 않는다.
- `UNRELATED_DRAFT_CHANGES`: 공동 초안에 발행되지 않은 다른 변경이 있다. 1단계의 미발행 변경 처리를 따른다.
- `PAGE_NOT_PUBLISHED`·`UNNORMALIZED_ATTACHMENT_LINKS`: `save_page`로 전체를 저장한다.
- `edit_page`가 도구 목록에 없는 서버에서는 아래 `save_page` 절차를 쓴다.

## 새 문서·전체 교체와 임시 초안

- 사용자가 Wiki에 글을 작성·정리·수정·저장·게시해 달라고 요청하면 페이지 반영까지 완료한다. 기존 발행 문서의 일부 수정은 위 `edit_page` 절차로, 새 문서 작성과 명시적인 전체 교체는 `save_page`로 한다. 이 요청은 해당 페이지 저장·발행을 포함하므로 별도의 발행 재확인을 요구하지 않는다. 대화 안에서만 글을 작성해 달라는 요청은 Wiki 저장 요청으로 확대하지 않는다.
- `save_page`와 `publish_page`는 `responseMode=SUMMARY`로 호출해 본문 없는 요약(버전·발행 Revision·`contentBytes`)을 받는다.
- 새 문서는 승인된 `workspaceId`, 선택적 `parentId`, 완성한 `title`·`contentMd`와 새 `idempotencyKey`를 전달한다. `pageId`, `expectedDraftVersion`, `expectedPublishedRevisionId`는 null이다. 저장 성공은 최초 발행까지 완료된 결과다.
- 제목은 `title`로만 전달한다. `contentMd`를 `title`과 같은 H1으로 시작하지 않는다. 화면이 제목을 따로 표시하므로 본문은 첫 절의 H2나 문단부터 쓴다.
- 기존 문서를 전체 교체할 때는 `get_page_draft`로 공동 초안을 확인한다. `save_page`에 같은 Workspace의 `pageId`, 수정한 `title`·`contentMd`, 조회한 `draftVersion`을 `expectedDraftVersion`으로, 확인한 현재 발행 Revision ID를 `expectedPublishedRevisionId`로 전달한다. 미발행 페이지의 발행 기준은 null이며 기존 문서의 `parentId`는 null이다. 다른 작업자의 초안 변경을 보존하고, 사용자 요청과 합칠 수 없는 경우 필요한 내용을 확인한다.
- 사용자가 “초안으로만”, “검토용으로 보관”, “아직 게시하지 말라”고 명시한 경우에만 `create_page` 또는 `update_page_draft`로 임시 보관하고 발행하지 않는다. 자동 임시저장도 같은 초안 경로다. 기존 초안을 명시적으로 게시할 때는 확인한 두 버전으로 `publish_page`를 호출한다.
- `save_page`가 아직 노출되지 않은 클라이언트는 같은 승인 범위에서 `create_page` 또는 `update_page_draft` 다음 `publish_page`까지 순서대로 완료한다. 저장 응답의 최신 초안 버전과 사전에 확인한 발행 기준을 사용하며 초안 저장에서 완료했다고 보고하지 않는다.
- 저장·수정 뒤에는 `get_page(includeContent=false)`로 발행 Revision과 `contentBytes`를 확인하고 페이지 링크를 보고한다. 내용 확인이 필요하면 바뀐 구간만 `read_page_excerpt`로 읽는다. 응답이 유실되어 결과가 불확실하면 같은 입력과 `idempotencyKey`로 재시도한다. 발행 실패 시 초안 보관과 페이지 반영 여부를 구분한다.
- 충돌하면 최신 버전과 내용을 다시 읽고 사용자·다른 작업자의 변경을 보존한다. 버전 값을 임의로 올리거나 무조건 재시도하여 덮어쓰지 않는다.
- `list_page_revisions`, `get_page_revision`, `restore_page_draft`로 이력을 확인하고 복원한다. 복원은 임시 초안이며 별도 저장 요청 전에는 페이지를 바꾸지 않는다.

## 권한·공유·파괴적 변경

- `get_page_permissions`와 `preview_page_change`로 현재 대상·영향·기대 버전을 확인한 뒤 대응 도구를 호출한다. 공개 공유, 권한 변경, 이동, 소유권 이전, 휴지통 및 영구 삭제는 사용자가 요청한 정확한 범위에서 수행한다.
- Workspace 승인, 사용자 멤버십, 페이지 ACL, credential의 현재 작업별 권한이 모두 적용된다. 문서 쓰기 권한만으로 공개 공유나 영구삭제가 허용된다고 가정하지 않는다. 권한 거부를 다른 도구나 다른 계정으로 우회하지 않는다.
- 댓글은 `list_page_comments`, `create_page_comment`, `delete_page_comment`를 사용한다. 외부 발신 요청이 없는 상황에서 댓글을 임의로 남기지 않는다.
- 첨부 및 Markdown 가져오기·내보내기는 도구가 제공한 attachment/job ID와 미리보기 계약을 따른다. 서버가 사용자의 로컬 파일 경로를 읽을 수 있다고 가정하지 않는다.

## 결과 보고

실제 변경한 페이지, 초안/발행 상태, 검증한 결과와 남은 실패를 짧게 보고한다. 설정·인증·도구 실행 성공을 구분하고 응답에 토큰이나 비밀값을 포함하지 않는다.

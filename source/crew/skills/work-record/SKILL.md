---
name: work-record
description: 계획 단계가 3개 이상인 큰 일을 진행할 때 연결된 onidot Studio의 작업 기록에 계획·진행·멈춤·인계를 남기고, 다음 세션에서 그 작업을 이어 받을 때 쓴다. 작업 기록 도구(create_work_checklist 등)가 없으면 쓰지 않는다.
---

# work-record

큰 일의 계획·진행·멈춤·인계를 Studio 작업 기록에 남긴다. 사람은 웹의 작업 화면에서 같은 기록을 본다. 작업 기록 도구가 연결돼 있지 않으면 `onidot-crew:resume` 스킬의 진행 기록 방식으로 대신한다.

## 공통 규칙

- 작업 기록 쓰기는 메인 AI만 한다. 서브에이전트는 결과만 돌려준다. 쓰기마다 작업 버전이 올라가서 여럿이 동시에 쓰면 충돌한다.
- 모든 쓰기 도구에 `spaceId`와 `idempotencyKey`를 준다. 키는 `crew:<작업 짧은 이름>:<동작>:<대상>:<번호>` 꼴로 만든다. 내용이 다른 요청에 같은 키를 쓰지 않는다.
- 쓰기 응답의 `version`을 다음 요청의 `expectedVersion`으로 이어 쓴다.
- `knownPolicyRevision`, `guideSnapshotId`, `deviceId`는 보내지 않는다.
- 이벤트·사유 문장에는 줄바꿈과 비밀값처럼 보이는 문자열을 넣지 않는다. 인계 본문은 줄바꿈을 써도 된다.
- 단계·작업의 완료 처리(`complete_work_stage`, `transition_work`의 `COMPLETED`)는 아직 하지 않는다. 끝난 단계는 진행 메모로 남긴다. 완료 처리는 서버의 완료 모델이 바뀐 뒤 이 스킬에 추가된다.

## 1. 계획이 확정되면 작업 만들기

1. `create_work_checklist`를 부른다.
   - `expectedVersion`: 0
   - `title`, `goal`: 계획의 제목과 목표
   - `grade`: 보통 `LIGHT`. 되돌리기 어렵거나 중요한 일은 `HEAVY`
   - `acceptanceCriteria`: 1개 이상. `{ "text": "<완료 기준>", "verificationMethod": "<TEST | COMMIT | WIKI_PUBLISH 중 맞는 것>" }`
   - `completionConditions`: 1개 이상. `{ "kind": "done", "target": { "action": "<무엇을 끝내나>" }, "requiredEvidenceKinds": ["<위와 같은 종류>"], "approvalRequired": false }`
   - `stages`: 계획의 단계마다 `{ "title": "<단계>", "required": true, "acceptanceCriteria": [], "completionConditions": [{ "kind": "done", "target": { "action": "<단계>" }, "requiredEvidenceKinds": ["VERIFICATION"], "approvalRequired": false }] }`
   - 단계 의존을 남기려면 단계마다 `id`를 직접 주고 `predecessorStageIds`로 잇는다. id는 13자 소문자 TSID여야 한다. 의존이 없으면 `id`를 비운다.
2. 응답의 `entityId`(작업 ID)와 `version`을 기억한다. 만든 직후 상태는 `PAUSED`·`QUESTION`이다.
3. 계획서를 Wiki에 따로 두었다면 작업 기록에는 같은 내용을 다시 쓰지 않는다.

## 2. 실행을 시작할 때

4. `start_work_session`을 부른다. 한 대화에서 세션은 하나만 연다.
   - `expectedVersion`: 0
   - `externalSessionKey`: `claude-code:<시작 시각 같은 고유 값>`(Codex면 `codex:`로 시작)
   - `harness`: `claude-code` 또는 `codex`
   - `collectionScope`: `MCP_ONLY`
   - `binding`: 아는 경우 `{ "repository": "<저장소>", "branch": "<브랜치>" }`, 모르면 `{}`
   - 응답의 `entityId`가 세션 ID다.
5. `claim_work`로 작업 전체를 맡는다.
   - `workId`, `sessionId`, `role`: `COORDINATOR`, `stageId`는 비운다
   - `expectedClaimGeneration`: 처음이면 0. 이전 담당이 있었으면 `get_work` 응답의 `claims` 중 `targetKey`가 `WORK`인 항목의 `generation`
   - 응답의 `attemptId`와 `claimGeneration`을 기억한다. 이후 상태 변경에 쓴다. 작업 상태가 `IN_PROGRESS`가 된다.
6. `bind_work_session`으로 세션을 작업에 묶는다. `expectedVersion`은 `get_work_session` 응답의 `version`이다. 다음 세션이 이 작업을 바로 찾게 한다.

## 3. 진행을 남길 때

7. 단계를 맡기기 직전과 끝난 직후에 `append_work_session_events`로 메모를 남긴다. `expectedVersion`은 0이다.
   - 이벤트: `{ "schemaVersion": 1, "eventId": "crew:<작업>:<단계>:<started|done>:<번호>", "sessionId": "<세션 ID>", "producerSeq": <0부터 하나씩 증가>, "occurredAt": "<현재 UTC 시각>", "type": "SUMMARY", "payload": { "workId": "<작업 ID>", "summary": "<단계> 시작, 담당 <역할>" } }`
   - 끝난 뒤에는 `summary`에 "<단계> 끝남, <증거 한 줄>"을 쓴다. 1000자 이하 한 줄이다.
   - `producerSeq`는 세션마다 0부터 시작해 이벤트마다 1씩 올린다. 건너뛰면 서버가 순번 빈틈으로 표시한다.
   - `occurredAt`은 짐작하지 말고 `date -u +%Y-%m-%dT%H:%M:%SZ`로 읽은 실제 시각을 쓴다. 서버 시각보다 5초 넘게 앞서면 시계 어긋남으로 표시되고 활동 시간 계산에서 빠진다.
8. 계획이 바뀌면 `edit_work_checklist`(`operation`: `ADD`·`REMOVE`·`RENAME`, `reason` 필수)로 단계를 고친다.
9. 단계를 시작하기 전에 `get_work`로 두 가지를 본다.
   - 사람이 남긴 지시(`pendingInstructions`)가 있으면 반영하고 `acknowledge_work_instruction`(`instructionId`, `reason`)으로 확인한다.
   - 사람이 웹에서 작업을 멈췄으면 더 쓰지 않고 사용자에게 보고한다.

## 4. 사용자 결정을 기다릴 때

10. `transition_work`를 부른다. `attemptId`·`claimGeneration`, `state`: `PAUSED`, `stopReason`: `QUESTION`(승인 대기는 `APPROVAL`, 외부 대기는 `EXTERNAL`), `reason`: 질문 요지.
11. 답을 받으면 같은 표식으로 `state`: `IN_PROGRESS`, `reason`을 보낸다. 담당이 이미 풀렸으면 5번으로 다시 맡는다.

## 5. 멈출 때 인계

12. `save_handoff`를 부른다. `sessionId`, `workId`, `expectedVersion`: 0, `payload`: `{ "summary": "<지금까지>", "remainingWork": [...], "questions": [...], "nextSteps": [...], "recheckItems": [...], "sourceRefs": [], "target": { "workId": "<작업 ID>" } }`
13. 이 대화를 더 이어가지 않을 때만 `end_work_session`(`expectedVersion`은 `get_work_session`의 `version`, `reason` 필수)으로 세션을 닫는다. 멈춤 전이는 닫기 전에 한다.

## 6. 다음 세션에서 이어 받을 때

14. `list_works`를 `state`: `IN_PROGRESS`, 이어서 `PAUSED`로 불러 후보를 고르고 `get_work`로 상태·단계·담당 세대를 읽는다.
15. 2의 4번처럼 새 세션을 연다.
16. `get_work_resume_context`(`sessionId`)로 인계와 다시 확인할 항목을 읽고, 다시 확인할 항목부터 확인한다.
17. 담당을 이어 받는다.
    - 인계가 있고 이전 세션이 담당을 쥐고 있으면 `accept_handoff`를 쓴다. `handoffId`, `handoffVersion`, `expectedVersion`은 `handoffVersion`과 같게, `claim`에는 `claim_work`와 같은 값(`spaceId`, `expectedVersion`은 작업 version, 별도 `idempotencyKey`, `workId`, 새 `sessionId`, `role`, `expectedClaimGeneration`)을 넣는다.
    - 인계가 없으면 `claim_work`로 맡는다. 이전 세션이 열린 채 남아 있으면 `end_work_session`으로 정리한 뒤 맡는다.

## 오류가 나면

| 오류 | 대응 |
| --- | --- |
| `VALIDATION_FAILED` | 입력을 고친다. 빈 `reason`이 흔한 원인이다 |
| `REVISION_CONFLICT` | `get_work`로 최신 `version`을 읽고 다시 보낸다 |
| 응답을 못 받음 | 같은 인자와 같은 키로 다시 보낸다 |
| `IDEMPOTENCY_KEY_REUSED` | 새 키를 쓴다 |
| `CLAIM_LOST` | `get_work`의 `claims`를 본다. 다른 세션의 살아 있는 담당이면 멈추고 보고한다 |
| `INVALID_TRANSITION` | 사람이 멈춘 작업이거나 같은 상태로 바꾸려 한 것이다. 상태를 읽고 보고한다 |
| `FORBIDDEN` | 연결 권한 문제다. 사용자에게 알린다 |

## 점검 목록

- [ ] 작업 기록 쓰기는 메인만 했다.
- [ ] 계획 확정 뒤 작업을 만들고 세션을 열어 작업을 맡았다.
- [ ] 단계 시작·끝을 메모로 남겼다.
- [ ] 결정이 필요하면 `PAUSED`로 바꾸고 질문을 남겼다.
- [ ] 멈출 때 인계를 남겼다.
- [ ] 완료 처리는 하지 않았고, 보고에 완료·미완료·미검증을 나눴다.

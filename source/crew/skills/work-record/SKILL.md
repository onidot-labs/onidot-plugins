---
name: work-record
description: 계획 단계가 3개 이상인 큰 일을 진행할 때 연결된 onidot Studio의 작업 기록에 계획·진행·증거·검토·완료·멈춤·인계를 남기고, 다음 세션에서 그 작업을 이어 받을 때 쓴다. 작업 기록 도구(create_work_checklist 등)가 없으면 쓰지 않는다.
---

# work-record

큰 일의 계획·진행·증거·검토·완료·멈춤·인계를 Studio 작업 기록에 남긴다. 사람은 웹의 작업 화면에서 같은 기록을 본다. 작업 기록 도구가 연결돼 있지 않으면 `onidot-crew:resume` 스킬의 진행 기록 방식으로 대신한다.

## 공통 규칙

- 작업 기록 쓰기는 메인 AI만 한다. 서브에이전트는 결과만 돌려준다. 쓰기마다 작업 버전이 올라가서 여럿이 동시에 쓰면 충돌한다.
- 모든 쓰기 도구에 `spaceId`와 `idempotencyKey`를 준다. 키는 `crew:<작업 짧은 이름>:<동작>:<대상>:<번호>` 꼴로 만든다. 내용이 다른 요청에 같은 키를 쓰지 않는다.
- 쓰기 응답의 `version`을 다음 요청의 `expectedVersion`으로 이어 쓴다.
- `knownPolicyRevision`, `guideSnapshotId`, `deviceId`는 보내지 않는다.
- 이벤트·사유 문장에는 줄바꿈과 비밀값처럼 보이는 문자열을 넣지 않는다. 인계 본문은 줄바꿈을 써도 된다.
- 서버는 이벤트의 `eventId`·`summary`·`role`·`agentId`에 다음이 들어 있으면 묶음 전체를 `VALIDATION_FAILED`로 거부한다(대소문자 무시): `bearer `, `authorization:`, `-----begin `, `sk-`, `ghp_`, `github_pat_`, 그리고 `api_key`·`api-key`·`password`·`access_token`·`refresh_token`·`secret` 바로 뒤의 `=`. `task-`·`risk-`·`desk-`처럼 `sk-`로 끝나는 낱말도 걸리므로 문장과 `eventId`에 쓰지 않는다.
- 단계·작업의 완료 처리(`complete_work_stage`, `transition_work`의 `COMPLETED`)는 7절의 순서(증거 기록 → gate 독립 검토 → 완료)로만 한다. 증거나 판정 없이 부르지 않고, 서버가 거부하면 완료라고 하지 않는다.
- 증거의 `runId`·`redactedCommand`·`sourceRef` 같은 문자열에도 위 금지 문자열·줄바꿈·제어 문자 검사가 적용된다. 비밀값·전체 경로·개인정보를 넣지 않는다.

## 1. 계획이 확정되면 작업 만들기

1. `create_work_checklist`를 부른다.
   - `expectedVersion`: 0
   - `title`, `goal`: 계획의 제목과 목표
   - `grade`: 보통 `LIGHT`. 되돌리기 어렵거나 중요한 일은 `HEAVY`
   - `acceptanceCriteria`: 1개 이상. `{ "text": "<완료 기준>", "verificationMethod": "<TEST | COMMAND | COMMIT | MANUAL_CHECK | WIKI_PUBLISH 중 일의 성격에 맞는 것>" }`. git이 없는 일이나 문서·설정·조사 같은 일은 `MANUAL_CHECK`를 쓴다. 이 확인 방법은 계획 때 반드시 올릴 수 있는 종류로 고른다. 커밋·푸시하지 않을 수 있는 일(회사 작업 등)은 `COMMIT`을 고르지 않고 `MANUAL_CHECK`를 쓴다. 알려진 실패가 남을 수 있는 전체 검사는 `TEST` 대신 `MANUAL_CHECK`로 둔다. 작업 수준 완료 기준은 서버가 기계적으로 검사하므로 21번의 조건을 맞춰 올릴 수 있어야 한다
   - `completionConditions`: 1개 이상. `{ "kind": "done", "target": { "action": "<무엇을 끝내나>" }, "requiredEvidenceKinds": ["VERIFICATION"], "approvalRequired": false }`. 대상 해시 없이 action만 둔 조건은 요구 증거가 `VERIFICATION`이어야 독립 검토(범위 검토)로 충족된다. `approvalRequired`가 true이면 해시 없이는 충족할 수 없으므로 항상 false로 둔다. 단계 완료 조건과 작업의 범위(action) 조건은 어떤 종류의 증거든 그 범위의 묶음이 되며 독립 검토 판정이 정한다. 작업 수준 완료 기준(`acceptanceCriteria`)은 판정만으로 충족되지 않는다. 증거 종류를 고르는 법은 7절 20번, 기준 검사는 21번이다.
   - `stages`: 계획의 단계마다 `{ "title": "<단계>", "required": true, "acceptanceCriteria": [], "completionConditions": [{ "kind": "done", "target": { "action": "<단계>" }, "requiredEvidenceKinds": ["VERIFICATION"], "approvalRequired": false }] }`
   - `links`: 계획의 기준 묶음(`onidot-crew:spec-first` 2절)의 기준 문서와 기존 조사를 넣는다. 항목마다 `{ "kind": "URL", "url": "<문서 주소>" }`로 쓴다. Wiki 페이지도 페이지 주소를 `URL`로 넣는다(`WIKI_PAGE` 종류는 읽기 권한 검사에서 기록한 사람에게도 가려질 수 있다). 기준을 찾아봤는데 없었으면 비워 두고 계획서에 찾아본 곳을 적는다.
   - 계획의 선행 관계를 그대로 남긴다. 작업 화면의 흐름 그래프는 이 의존으로 묶음 열과 간선을 그리므로, 의존이 있는 계획을 의존 없이 올리지 않는다. 단계마다 `id`를 주고 `predecessorStageIds`로 잇는다. id는 서버 형식의 13자 TSID여야 하므로 직접 지어내지 않고 `<flow> ids --count <단계 수>`(Claude Code, 8번의 명령 접두사)나 `node '<플러그인 루트>/scripts/flow-queue.mjs' ids --count <단계 수>`로 발급받는다. `ids`는 세션·데이터 경로 없이 동작한다. 발급할 수 없으면 `id`를 비우고 의존을 계획서에 적은 뒤 그 사실을 보고한다.
2. 응답의 `entityId`(작업 ID)와 `version`을 기억한다. 만든 직후 상태는 `PAUSED`·`QUESTION`이다.
3. 계획서를 Wiki에 따로 두었다면 작업 기록에는 같은 내용을 다시 쓰지 않고 계획서 주소도 `links`에 넣는다.

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
6. `get_work_session`으로 세션의 `version`을 다시 읽은 뒤 `bind_work_session`으로 세션을 작업에 묶는다. `expectedVersion`은 이 값이다. `claim_work`가 세션 version을 올리므로 `start_work_session` 응답의 `version`을 쓰면 `REVISION_CONFLICT`가 난다. 다음 세션이 이 작업을 바로 찾게 한다.

## 3. 진행을 남길 때

7. 단계를 맡기기 직전과 끝난 직후에 `append_work_session_events`로 단계 흐름 이벤트를 남긴다. `expectedVersion`은 0이다. 흐름 이벤트는 작업 버전을 올리지 않는다.
   - 시작: `{ "schemaVersion": 1, "eventId": "crew:<작업>:<단계>:started:<번호>", "sessionId": "<세션 ID>", "producerSeq": <다음 순번>, "occurredAt": "<실제 UTC 시각>", "type": "STAGE_STARTED", "payload": { "workId": "<작업 ID>", "stageId": "<단계 ID>", "role": "<맡긴 역할의 한정 이름, 예: onidot-crew:worker>", "summary": "<지금 하는 일 한 줄>" } }`
   - 끝: `type`은 `STAGE_FINISHED`, `eventId` 끝은 `finished:<번호>`로 하고 payload에 `result`를 넣는다. 통과하면 `DONE`, 실패하면 `FAILED`, 사용자 결정이나 외부 요인으로 막히면 `BLOCKED`다. `summary`에는 증거 한 줄을 쓴다.
   - `stageId`는 `get_work`나 `get_work_flow`가 돌려준 단계의 `id`다. 메인이 직접 하는 단계는 `role`을 비운다. `role`은 UTF-8 120바이트, `summary`는 1000바이트 이하 한 줄이다.
   - `producerSeq`는 세션마다 0부터 시작해 이벤트마다 1씩 올린다. 아래 8번의 꺼내기 출력 `nextSeq`도 같은 순번을 이어 쓴다. 건너뛰면 서버가 순번 빈틈으로 표시한다.
   - `occurredAt`은 짐작하지 말고 `date -u +%Y-%m-%dT%H:%M:%SZ`로 읽은 실제 시각을 쓴다. 단계 상태는 이 시각 순으로 계산되므로 늦게 보내더라도 실제 일어난 시각을 담는다. 서버 시각보다 5초 넘게 앞서거나 작업 기록 세션을 연 시각보다 이르면 시계 어긋남(`clockSkew`)으로 표시되고 흐름 계산에서 빠진다. 그보다 오래된 시각을 따로 거부하지는 않는다.
   - 흐름 이벤트를 받는 서버인지는 연결된 도구 목록에 `get_work_flow`가 있는지로 판단한다. 없으면 예전처럼 `SUMMARY` 메모로 대신한다. payload에는 `workId`와 `summary`("<단계> 시작, 담당 <역할>" 또는 "<단계> 끝남, <증거 한 줄>")만 넣고, 8번의 서브에이전트 이벤트는 남기지 않는다. `get_work_flow`가 있는데 `VALIDATION_FAILED`가 나면 종류 탓으로 단정하지 말고 위 공통 규칙의 금지 문자열·길이·필수 필드를 먼저 고친다.
   - 긴 작업은 단계 사이에 담당을 살린다. 작업 담당(`targetKey`가 `WORK`)은 `transition_work`·작업 범위 증거·`ACTIVITY` 이벤트로만 활동이 갱신된다. 단계 claim·단계 증거·`STAGE_*` 이벤트는 갱신하지 않아 6시간 활동이 없으면 서버가 작업을 `PAUSED`·`INACTIVITY`로 정리한다. 단계 사이에 `append_work_session_events`로 `type`이 `ACTIVITY`인 이벤트를 보낸다. payload는 `{ "workId": "<작업 ID>", "attemptId": "<WORK 담당의 attemptId>", "claimGeneration": <WORK 담당의 claimGeneration>, "summary": "<한 줄>" }`이고 세션은 6번으로 그 작업에 묶여 있어야 한다. `occurredAt`은 실제 시각이며 이미 만료된 담당은 살리지 못한다.
8. 서브에이전트 시작·끝은 메인이 짐작해 쓰지 않는다. Claude Code에서는 플러그인 훅이 정확한 시각·서브에이전트 ID·역할을 Claude 세션별 대기열 파일에 적고, 메인이 그것을 보낸다. Codex에는 이 훅이 없으므로 서브에이전트 이벤트를 남기지 않는다.
   - 아래에서 `<flow> <명령>`은 Bash로 실행하는 명령이다. Bash 셸에는 플러그인 경로 변수가 없으므로 세션 시작 때 훅이 알려 준 명령 접두사(`node '<절대경로>/flow-queue.mjs' <명령> --data '<절대경로>' --claude-session '<세션 ID>'`)의 `<명령>` 자리에 명령을 넣어 쓴다. 알림이 없으면(훅 미지원) 서브에이전트 이벤트를 남기지 않는다. 이때 이 절의 나머지(켜기·꺼내기 등)는 하지 않는다.
   - 켜기: 2의 6번을 마친 뒤 `<flow> start --work <작업 ID> --session <세션 ID>`를 실행한다. 켠 뒤에 시작한 서브에이전트만 적힌다. 켜지 않은 대화에서는 훅이 아무것도 적지 않고 알리지도 않는다. `/clear` 뒤나 새 대화에서 이어 받으면 다시 켠다.
   - 단계를 맡기는 Agent 호출의 `description` 끝에 `[stage:<단계 ID>]`를 붙인다. 훅이 그 서브에이전트의 이벤트에 그 `stageId`를 붙인다. 단계와 무관한 호출(탐색·조사·자문 등)에는 붙이지 않으며, 그 이벤트는 `stageId` 없이 간다.
   - 꺼내기: 훅이 "기록할 흐름 이벤트 N건"을 알리면(알림의 명령을 그대로 써도 된다), 그리고 `STAGE_FINISHED`를 보내기 직전과 백그라운드 서브에이전트의 완료 알림을 받은 뒤에 `<flow> pending --next-seq <다음 producerSeq>`를 실행한다. 백그라운드 서브에이전트는 끝날 때 알림 훅이 돌지 않으므로 이 확인을 빼먹지 않는다. 출력의 `count`가 0이면 보내지 않는다.
   - 보내기: 출력의 `events`를 고치지 말고 그대로 `append_work_session_events`의 `events`로 보낸다. `spaceId`는 작업의 Space, `sessionId`·`idempotencyKey`는 출력의 값, `expectedVersion`은 0이다. 이 묶음에 메인이 직접 쓰는 단계 이벤트를 섞지 않는다. 출력의 `nextSeq`를 다음 `producerSeq`로 이어 쓴다. 보내기가 실패해도 그렇다.
   - 이벤트 모양: `eventId`는 대기열 항목마다 고정된 `cc-flow:<항목 ID>`다. `producerSeq`와 `stageId`는 그 항목을 처음 꺼낼 때 정해져 저장된다. 그래서 다시 꺼내면 같은 이벤트와 같은 키가 나오고, 다시 보내도 중복되지 않는다. 키는 이벤트 내용에서 만들므로 항목이 빠지거나 단계가 떨어지면 키도 바뀐다. 출력은 한 번에 100건까지이며 `more`가 0보다 크면 지운 뒤 다시 꺼낸다.
   - 지우기: 보내기에 성공하면 `<flow> ack <출력의 ids>`로 지운다. 실패하면 지우지 않고 다음에 다시 꺼내 보낸다.
   - 묶음이 거부되면: `TARGET_MISMATCH`이면 계획에서 빠진 단계다. `<flow> unstage --stage <그 단계 ID>`로 단계 ID만 떼고 다시 꺼내 보낸다. `VALIDATION_FAILED`이면 금지 문자열에 걸린 항목을 찾아 그 항목 ID만 `<flow> ack`로 버리고 나머지를 다시 꺼내 보낸다. 훅은 걸리는 `role`을 빼고 걸리는 `agentId`의 항목은 적지 않지만, 서버 규칙이 바뀌었을 수 있다.
   - 단계 ID 발급: `<flow> ids --count <개수>`는 서버 형식의 단계 ID를 `{ "ids": [...] }`로 출력한다(1절 1번). 대기열과 무관하다.
   - 상태와 끄기: `<flow> status`는 켜짐 여부·작업·남은 항목 수를 보인다. 인계를 남기고 이 대화에서 작업 기록을 그만둘 때(14·15번) `<flow> stop`을 실행한다. 버려도 될 때만 `--discard`를 붙인다.
   - 종료 코드(공통): 0 성공, 1 잠금을 못 얻음(잠시 뒤 다시 실행) 또는 예상 못 한 오류, 2 잘못된 인자, 3 꺼져 있음 또는 보내지 않은 항목이 남아 거부함.
9. 진행을 확인할 때는 `get_work_flow`(`workId`)를 부른다. `stages`의 `status`(`PENDING`·`READY`·`RUNNING`·`DONE`·`FAILED`·`BLOCKED`·`VERIFIED`)와 `subagents`, `lastSeq`를 돌려준다. 다음 확인 때 `afterSeq`에 이전 `lastSeq`를 넣으면 그 뒤에 기록된 흐름 이벤트만 `events`로 온다. `hasMoreEvents`가 true이면 마지막 이벤트의 `id`로 이어 읽는다. 보낸 이벤트가 상태에 보이지 않으면 보내기 응답의 `clockSkew`를 확인한다.
10. 계획이 바뀌면 `edit_work_checklist`(`operation`: `ADD`·`REMOVE`·`RENAME`, `reason` 필수)로 단계를 고친다.
11. 단계를 시작하기 전에 `get_work`로 두 가지를 본다.
   - 사람이 남긴 지시(`pendingInstructions`)가 있으면 반영하고 `acknowledge_work_instruction`(`instructionId`, `reason`)으로 확인한다.
   - 사람이 웹에서 작업을 멈췄으면 더 쓰지 않고 사용자에게 보고한다.

## 4. 사용자 결정을 기다릴 때

12. `transition_work`를 부른다. `attemptId`·`claimGeneration`, `state`: `PAUSED`, `stopReason`: `QUESTION`(승인 대기는 `APPROVAL`, 외부 대기는 `EXTERNAL`), `reason`: 질문 요지.
13. 답을 받으면 같은 표식으로 `state`: `IN_PROGRESS`, `reason`을 보낸다. 담당이 이미 풀렸으면 5번으로 다시 맡는다.

## 5. 멈출 때 인계

14. 열린 검토 세션(22번)이 있으면 15번에서 함께 닫는다. `save_handoff`를 부른다. `sessionId`, `workId`, `expectedVersion`: 0, `payload`: `{ "summary": "<지금까지>", "remainingWork": [...], "questions": [...], "nextSteps": [...], "recheckItems": [...], "sourceRefs": [], "target": { "workId": "<작업 ID>" } }`
15. 이 대화를 더 이어가지 않을 때만 `end_work_session`(`expectedVersion`은 `get_work_session`의 `version`, `reason` 필수)으로 세션을 닫는다. 멈춤 전이는 닫기 전에 한다. 22번의 검토 세션이 열려 있으면 25번대로 먼저 닫는다.

## 6. 다음 세션에서 이어 받을 때

16. `list_works`를 `state`: `IN_PROGRESS`, 이어서 `PAUSED`로 불러 후보를 고르고 `get_work`로 상태·단계·담당 세대를 읽는다.
17. 2의 4번처럼 새 세션을 연다.
18. `get_work_resume_context`(`sessionId`)로 인계와 다시 확인할 항목을 읽고, 다시 확인할 항목부터 확인한다. 이어서 `get_work`의 `links`에 있는 기준 문서 원문을 읽는다. 인계 요약만 보고 기준을 짐작하지 않는다. 이후 위임에는 그 원문으로 기준 묶음을 다시 만들어 넘긴다.
19. 담당을 이어 받는다.
    - 인계가 있고 이전 세션이 담당을 쥐고 있으면 `accept_handoff`를 쓴다. `handoffId`, `handoffVersion`, `expectedVersion`은 `handoffVersion`과 같게, `claim`에는 `claim_work`와 같은 값(`spaceId`, `expectedVersion`은 작업 version, 별도 `idempotencyKey`, `workId`, 새 `sessionId`, `role`, `expectedClaimGeneration`)을 넣는다.
    - 인계가 없으면 `claim_work`로 맡는다. 이전 세션이 열린 채 남아 있으면 `end_work_session`으로 정리한 뒤 맡는다.

## 7. 증거를 남기고 닫을 때

작업 조건의 `requiredEvidenceKinds`가 `VERIFICATION`이 아니고 대상 해시도 없으면(0.2.0 이전에 만든 작업) 서버가 묶음을 만들지 않아 충족할 수 없다. 먼저 `update_work`로 조건을 1절의 `VERIFICATION` 꼴로 바꾼 뒤 진행한다. 바꾸지 못하면 작업 완료는 하지 않고 보고한다(단계 완료는 할 수 있다). 증거가 없는 상태에서는 고쳐도 잃을 것이 없다.

단계와 작업은 증거 기록 → gate 독립 검토 → 완료 순서로 닫는다. `get_work` 응답에 `reviewBundles`가 없으면(구 서버) 이 절을 하지 않는다. 그때는 3절의 진행 이벤트만 남기고, 완료 처리를 하지 않았다고 보고한다. 이 절의 쓰기는 22번의 판정 기록을 포함해 모두 메인 AI가 부른다. 완료(`complete_work_stage`, `COMPLETED` 전이)는 반드시 메인(구현) 세션이 부르고, 검토 세션으로는 판정 기록만 한다. 검토 세션이 완료를 부르면 구현 담당이 생겨 이후 판정이 거부된다.

20. 단계 증거를 기록한다. 단계 결과가 통과한 뒤, 단계마다 한다.
    - `get_work`로 `version`, `conditionsVersion`, `grade`, 단계의 `id`와 그 단계 완료 조건의 `id`, 작업의 `acceptanceCriteria` `id`, `claims`를 읽는다.
    - `claim_work`로 그 단계를 맡는다. `stageId`, `sessionId`: 메인 세션, `role`: `IMPLEMENTER`, `expectedClaimGeneration`: 처음이면 0, 아니면 `claims`의 `STAGE:<단계 ID>` 항목 `generation`. 응답의 `attemptId`·`claimGeneration`이 이 단계 증거에 쓰는 값이다. 2절 5번의 작업 맡기 값을 쓰면 서버가 `TARGET_MISMATCH`로 거부한다(증거의 `stageId`는 시도의 단계와 같아야 한다). 이미 맡았으면 다시 맡지 않는다.
    - 증거는 검토자(gate)가 확인할 참고 자료다. 모두 AI의 주장으로 기록된다. 단계와 범위 검토에서는 커밋이 없다고 완료를 막지 않고 판정은 gate가 증거를 보고 내린다. 작업 수준 완료 기준은 다르다(21번). 단계 증거는 일의 성격에 맞게 하나 이상 올린다.
      - git 작업: `COMMIT`. `sourceRef`는 `{ "kind": "GIT_COMMIT", "id": "<sha>" }`이다. 푸시는 필요 없고 로컬 커밋 sha여도 된다. 커밋하지 않기로 한 일이면 아래 다른 종류를 쓴다.
      - 실행 결과(시험·명령·CI): `TEST`·`COMMAND`·`CI`. 아래 시험 예시를 따른다. git이 없으면 `execution.target.fileSetHash`에 바뀐 파일 묶음의 해시를 넣는다. 예: `shasum -a 256 <바뀐 파일들>`의 줄을 정렬한 출력을 다시 `shasum -a 256`한 값.
      - 문서·설정·조사·외부 시스템 작업: `MANUAL_CHECK`. 확인한 출처를 `sourceRef`로 밝힌다. 예: `{ "kind": "FILE", "id": "<상대 경로>" }`, `{ "kind": "URL", "url": "<주소>" }`. Wiki 발행본은 21번의 `WIKI_PUBLISH` 규칙을 따른다.
      - 병합·배포: `MERGE`·`DEPLOY`.
    - 증거는 종류와 무관하게 `append_work_evidence`로 올린다. `attemptId`·`claimGeneration`은 위 값, `workId`, `expectedVersion`은 최신 작업 version이다. `evidence`의 공통 필드는 `criterionId`(그 단계 완료 조건의 id), `conditionsVersion`(`get_work`의 값), `stageId`, `kind`, `occurredAt`(실제 UTC 시각)이고 종류에 따라 `sourceRef`나 `execution`이 붙는다. 모든 `sourceRef`에는 `kind`가 필수다. `kind` 없이 `id`·`url`만 있으면 서버가 Wiki 참조로 보고 숨은 출처(`hiddenEvidence`)로 가려 검토할 수 없다. 묶음에 `hiddenEvidence`가 나오면 `invalidate_work_evidence`(`spaceId`, `workId`, `evidenceId`, `reason` 필수, `expectedVersion`, `idempotencyKey`)로 그 증거를 무효화하고 `kind`를 단 증거를 다시 올린다.
    - 커밋했으면 `kind`는 `COMMIT`, `sourceRef`는 `{ "kind": "GIT_COMMIT", "id": "<전체 40자 sha>" }`로 올린다.
    - 시험을 돌렸으면 증거를 하나 더 올린다. `kind`는 `TEST`(명령 실행이면 `COMMAND`)이고 `sourceRef`는 넣지 않는다.
      `execution`: `{ "target": { "action": "<조건의 action>", "sha": "<시험한 커밋 sha>", "conditionsVersion": <같은 값> }, "runId": "<시험 실행을 가리키는 비지 않은 값, 예: crew:<작업>:<단계>:test:<번호>>", "redactedCommand": "<실행한 명령>", "exitCode": <종료 코드>, "executedCount": <실행 수>, "failedCount": <실패 수> }`
      종료 코드·실행 수·실패 수는 로그의 결과 줄에서 읽은 값만 쓴다. 서버는 `exitCode` 0, `executedCount` 1 이상, `failedCount` 0, `runId` 있음, `target`의 `sha`나 `fileSetHash` 있음일 때만 통과한 실행으로 센다. 실패한 실행도 사실대로 올릴 수 있다(통과로 세지 않을 뿐이며 판정은 gate가 내린다). 알려진 실패를 포함한 전체 검사 결과처럼 판정에 필요하면 그대로 올리고, 통과했다고 쓰지 않는다.
    - `occurredAt`은 `date -u +%Y-%m-%dT%H:%M:%SZ`로 읽은 실제 시각이다. 서버 시각보다 5분 넘게 앞서면 거부된다. 쓰기마다 응답의 `version`을 다음 `expectedVersion`으로 이어 쓴다.
21. 모든 단계를 닫은 뒤 작업 수준 증거를 기록한다. 작업의 `acceptanceCriteria`마다 20번과 같은 방식으로 올리되 `criterionId`는 그 완료 기준의 `id`, `stageId`는 비우고, `kind`는 그 기준의 `verificationMethod`(`TEST`·`COMMAND`·`COMMIT`·`MANUAL_CHECK` 등, 병합·배포는 `MERGE`·`DEPLOY`)이고 출처는 20번의 일의 성격별 기준과 같다. 작업 수준 완료 기준은 서버가 기계적으로 검사한다. `criterionId`가 그 기준의 id이고, `kind`가 그 기준의 `verificationMethod`와 같고, 실행 종류(`TEST`·`COMMAND`·`CI`)면 통과한 실행이어야 하며, gate 판정만으로는 충족되지 않는다. 기준과 맞지 않는 종류를 올렸거나 계획이 바뀌었으면 `update_work`로 `title`·`goal`·`grade`·`acceptanceCriteria`·`completionConditions`를 통째로 교체한다(`reason` 필수, `expectedVersion`은 최신 작업 version). 단계 조건은 그대로 이어지지만 `conditionsVersion`이 오르므로 고친 뒤 `get_work`로 새 값을 읽고 증거를 다시 올린다. `attemptId`·`claimGeneration`은 `get_work`의 `claims` 중 `targetKey`가 `WORK`인 살아 있는 현재 담당의 값이다(정리·인계로 바뀌었을 수 있으니 매번 읽는다). `WIKI_PUBLISH`는 서버가 발행본을 직접 확인하는 출처(`kind`: `WIKI_REVISION`, `revisionId`, `digest`와 같은 `sourceDigest`)가 있어야 한다.
22. gate 독립 검토를 받는다. 작업 등급이 `LIGHT`일 때만 한다(`HEAVY`는 26번).
    - 메인이 `onidot-crew:gate`(Codex에서는 `crew-gate`)에게 단계 결과와 증거를 감사시킨다. gate는 읽기 전용이고 MCP 도구로 기록하지 않고 판정만 반환하므로, 증거를 먼저 기록해 `get_work`의 `reviewBundles`로 받은 증거 ID와 실행 결과, 완료 기준, 커밋 해시, 시험 로그 위치를 위임 지시에 담아 준다. 감사 뒤 증거가 생겼으면 그 묶음으로 다시 감사받는다.
    - gate 반환을 받으면 검토 세션을 연다. 작업마다 한 번만 열고 재사용한다. `start_work_session`: `expectedVersion` 0, `externalSessionKey`: 메인 세션 키에 `:gate`를 붙인 값, `harness`·`collectionScope`·`binding`은 메인 세션과 같게, `parentSessionId`: 메인 세션 ID. 검토 세션으로는 `claim_work`로 담당을 잡거나 증거를 기록하거나 완료하지 않고 작업에 묶지도 않는다. 구현 시도나 증거가 생기면 그 세션의 판정은 `TARGET_MISMATCH`로 거부된다.
    - `get_work`의 `reviewBundles`에서 방금 닫은 범위의 묶음을 고른다. 단계는 `stageId`가 그 단계인 묶음, 작업 수준은 `stageId`가 없는 묶음이다. 묶음마다 다음과 같이 한다.
      - `hiddenEvidence`가 true이거나 `evidenceSetHash`가 없으면(증거 없음) 판정하지 않고 보고한다.
      - 그 밖에는 `record_work_verification`을 부른다. `target`·`evidenceIds`·`evidenceSetHash`는 묶음 값 그대로, `conditionsVersion`은 묶음 `target`이 아니라 작업의 `conditionsVersion`, `expectedVersion`은 최신 작업 version, `verifierSessionId`는 검토 세션 ID, `reason`은 필수 한 줄이다.
      - `verdict`는 gate의 전체 판정(통과 / 수정 필요 / 사람 확인 필요)을 옮긴다. 통과는 `CONFIRMED`, 수정 필요는 `CHANGES_REQUIRED`, 사람 확인 필요는 `HUMAN_REQUIRED`다. 보류의 기본은 `CHANGES_REQUIRED`이고, 증거를 더 올려도 판정할 수 없어 사람이 정할 일일 때만 `HUMAN_REQUIRED`다.
    - 같은 묶음은 마지막 판정이 우선하고, 판정 뒤 그 범위에 증거가 늘면 해시가 달라져 판정이 무효가 된다. 판정 뒤에는 그 범위에 증거를 더하지 않는다. 더했다면 `get_work`를 다시 읽고 새 묶음을 다시 감사받는다.
    - `CHANGES_REQUIRED`·`HUMAN_REQUIRED`이면 그 범위를 완료하지 않는다. 고친 뒤 증거를 다시 올리고 다시 감사받는다. 사람 확인은 사용자에게 보고한다.
23. 단계를 완료한다. 메인 세션으로 `complete_work_stage`를 부른다. `workId`, `stageId`, `sessionId`: 메인 세션, `evidence`: 빈 배열(새 증거를 넣으면 묶음이 바뀌어 판정이 무효가 된다), `reason` 필수, `expectedVersion`은 최신 작업 version이다. 서버가 거부하면(`COMPLETION_NOT_SATISFIED` 등) 응답을 그대로 보고하고 완료라고 하지 않는다. 단계 끝 이벤트는 3절대로 남긴다.
24. 필수 단계가 모두 끝나고 21번의 작업 수준 묶음도 판정됐으면 작업을 완료한다. 메인 세션으로 `transition_work`를 부른다. `state`: `COMPLETED`, `attemptId`·`claimGeneration`: `get_work`의 `claims` 중 `targetKey`가 `WORK`인 살아 있는 현재 담당의 값, `reason` 필수, `expectedVersion`은 최신 작업 version이다. 서버가 거부하면 응답(미충족 기준 ID)을 그대로 보고하고 완료라고 하지 않는다.
25. 검토 세션을 닫는다. `get_work_session`으로 검토 세션의 `version`을 다시 읽어(판정이 올린다) `end_work_session`을 부른다. 메인 세션은 5절 15번대로 닫는다. Claude Code에서 흐름 대기열을 켰다면 `<flow> stop`으로 끈다(24·25번 뒤, 남은 항목이 있으면 먼저 보낸다).
26. `HEAVY` 작업은 22번의 판정을 기록하지 않는다. 사람이 확인한 뒤 AI 판정이 오면 다시 미검증으로 돌아가기 때문이다. 20·21번의 증거까지만 남기고 `transition_work`로 `PAUSED`·`APPROVAL`(`reason`에 웹 작업 상세의 '검토 대상' 절에서 확인이 필요하다고 쓴다)로 바꾸며, 사용자에게 그 절의 버튼으로 확인해 달라고 요청한다. 확인을 받으면 4절 13번처럼 재개하고 23·24번을 한다.

## 오류가 나면

| 오류 | 대응 |
| --- | --- |
| `VALIDATION_FAILED` | 입력을 고친다. 빈 `reason`과 공통 규칙의 금지 문자열이 흔한 원인이다 |
| `REVISION_CONFLICT` | `get_work`로 최신 `version`을 읽고 다시 보낸다 |
| 응답을 못 받음 | 같은 인자와 같은 키로 다시 보낸다 |
| `IDEMPOTENCY_KEY_REUSED` | 새 키를 쓴다. 직접 쓴 이벤트면 `eventId`의 번호도 바꾼다(같은 `eventId`에 다른 내용은 거부된다). 대기열 이벤트는 고치지 않고 다시 꺼낸다 |
| `CLAIM_LOST` | `get_work`의 `claims`를 본다. 다른 세션의 살아 있는 담당이면 멈추고 보고한다 |
| `TARGET_MISMATCH` | 증거는 `stageId`와 시도의 단계가 같아야 하고, 판정은 묶음 값이 그대로이며 검토 세션이 독립이어야 한다(구현 시도·증거 제출이 없는 세션). 흐름 이벤트의 `stageId`가 그 작업의 단계가 아닌 경우도 같다. 직접 쓴 단계 이벤트면 `get_work`로 단계 `id`를 다시 읽는다. 대기열 이벤트면 8번대로 `unstage`로 단계 ID만 떼고 다시 보낸다 |
| `COMPLETION_NOT_SATISFIED` | 완료 기준이 아직 충족되지 않았다. 응답의 미충족 기준 ID를 보고하고 완료라고 하지 않는다. 증거가 빠졌거나 판정이 없거나 증거가 늘어 판정이 무효가 된 경우다 |
| `INVALID_TRANSITION` | `get_work`의 `state`와 `stopReason`을 읽고 판단한다. 사람이 멈춘 작업이거나 같은 상태로 바꾸려 한 것이면 보고한다. `PAUSED`·`INACTIVITY`면 바로 아래 행을 따른다 |
| 작업이 `PAUSED`·`INACTIVITY` | 6시간 활동이 없어 서버가 정리한 것이고 사람 멈춤이 아니다. 시도도 끝났다. `get_work`의 `claims`에서 `targetKey`가 `WORK`인 `generation`을 읽어 2절 5번(`claim_work` `COORDINATOR`, 새 세대)으로 다시 맡고, 상태가 `PAUSED`로 남아 있으면 4절 13번처럼 `IN_PROGRESS`로 재개한다. 이후 `attemptId`·`claimGeneration`은 새 값을 쓴다 |
| `FORBIDDEN` | 연결 권한 문제다. 사용자에게 알린다 |

## 점검 목록

- [ ] 작업 기록 쓰기는 메인만 했다.
- [ ] 계획 확정 뒤 작업을 만들고(기준 문서는 `links`에, 선행 관계는 발급한 단계 ID로) 세션을 열어 작업을 맡았다.
- [ ] 이어 받을 때 `links`의 기준 문서 원문을 읽었다.
- [ ] 단계 시작·끝을 `STAGE_STARTED`·`STAGE_FINISHED`로 남겼다. `get_work_flow`가 없는 서버면 `SUMMARY` 메모로 대신했다.
- [ ] Claude Code에서는 흐름 대기열을 켜고, 보내기에 성공한 항목만 지웠고, 그만둘 때 껐다.
- [ ] 결정이 필요하면 `PAUSED`로 바꾸고 질문을 남겼다.
- [ ] 멈출 때 인계를 남겼다.
- [ ] 단계·작업의 증거를 기록하고 gate의 독립 검토 판정을 받은 뒤에만 완료했다. `HEAVY`는 판정 대신 사용자 웹 확인을 요청했다.
- [ ] 검토 세션으로는 판정만 기록했고 완료는 메인 세션이 했다. 검토 세션을 닫았다.
- [ ] `reviewBundles`가 없는 서버나 서버가 거부한 완료를 완료라고 하지 않았고, 보고에 완료·미완료·미검증을 나눴다.

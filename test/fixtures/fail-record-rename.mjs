// 시험 전용 사전 로드 모듈: 설치 기록(.onidot-crew.json)으로 가는 N번째 rename을 실패시킨다.
// node --import 로 불러 codex-agents.mjs의 기록 쓰기 실패를 재현한다. N은 FAIL_RECORD_AT(기본 2).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.promises.rename;
const at = Number(process.env.FAIL_RECORD_AT ?? 2);
let count = 0;
fs.promises.rename = async (from, to) => {
  if (String(to).endsWith('.onidot-crew.json') && ++count === at)
    throw Object.assign(new Error('시험용 기록 쓰기 실패'), { code: 'EIO' });
  return original(from, to);
};
syncBuiltinESMExports();

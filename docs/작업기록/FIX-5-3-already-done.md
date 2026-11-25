# 5-3 정정 — 백엔드 작업이 필요 없습니다

`TASK-5-UI-REBUILD.md` 의 **5-3을 아래 내용으로 대체하세요.** 원래 지시가 틀렸습니다.

## 무엇이 틀렸나

원래 지시서에 이렇게 썼습니다.

> `/api/day/:date` 응답의 선곡 결과와 후보 목록에 `official_url`·`platform_video_id` 를 싣습니다.

**이미 실려 있습니다.** 확인했습니다.

- `/api/day/:date` → `out.candidate = loadCandidate(db, ...)`
- `/api/candidates` → `loadCandidates(db)`
- 둘 다 `src/selection/candidates.js` 의 `CANDIDATE_SQL` 을 쓰고, 그 SQL이 이미 `sv.official_url`·`sv.platform_video_id` 를 가져옵니다.

실제 응답에서 확인한 값입니다.

```
loadCandidate 반환 키 39개 중
  official_url      "https://www.youtube.com/watch?v=04GSqsX0S50"
  platform_video_id "04GSqsX0S50"
  platform          "youtube"
  video_title       "[COVER] DK X SEUNGKWAN - Die With A Smile (Original Song : Lady Gaga, Bruno Mars)"
```

**백엔드는 손댈 것이 없습니다.** 서버 코드도, 테스트도 추가하지 마세요.

## 진짜 문제는 화면입니다

`src/web/public/app.js` 에서 `official_url`·`platform_video_id` 가 **한 번도 쓰이지 않습니다** (검색 결과 0건).

후보 비교표가 뿌리는 항목은 이것뿐입니다.

```
candidate_key, rank, performer_en, title_en, title_ko,
performance_type, arrangement_tags, eligible, exclusions, clip
```

**데이터는 화면까지 와 있는데 화면이 안 씁니다.** 그래서 "오늘은 이 영상을 추천합니다"라고 해놓고 그 영상을 볼 방법이 없습니다.

## 그래서 할 일

**5-3을 독립 단계로 두지 말고, 5-4 화면 작업에 흡수시키세요.** 5-4에서 이렇게 합니다.

1. 선곡 결과 카드와 후보 비교표의 각 행에 **영상 링크**를 답니다 — `official_url` 을 새 탭으로 (`target="_blank" rel="noopener noreferrer"`).
2. 각 행 왼쪽에 **썸네일**을 답니다 — `https://i.ytimg.com/vi/{platform_video_id}/hqdefault.jpg`
   - 이미지를 내려받아 저장하지 마세요. 주소만 씁니다.
   - 화면에 CSP 설정이 없는 것을 확인했으므로 외부 이미지가 그대로 로드됩니다.
   - 이미지가 안 뜰 때(`onerror`)는 빈 칸으로 두세요. 깨진 아이콘이 뜨면 안 됩니다.
3. 「오늘의 추천 받기」 결과를 **글자 목록이 아니라 보고 고르는 화면**으로 만드세요. 썸네일 + 제목 + 점수 + 「영상 보기」.

## 왜 이렇게 바꾸나

원래 지시대로 하면 **이미 되는 기능을 다시 만들고, 그걸 검증하는 테스트까지 쓰게 됩니다.** 남은 시간에 쓸 곳이 아닙니다.

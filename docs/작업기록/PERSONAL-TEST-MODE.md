# 작업 지시 — 개인 테스트 모드 (권리 입력 없이 내 영상 편집하기)

> `HANDOFF.md`의 절대 원칙을 따른다. 이 작업은 그 원칙 중 하나를 **조건부로 완화**하는 것이므로, 아래 안전 규칙을 반드시 함께 구현해야 한다.

---

## 1. 왜 필요한가

운영자가 **자기 PC에 이미 가지고 있는 영상**을 잘라서 템플릿이 어떻게 보이는지 확인하고 싶어 한다. 개인 확인용이고 공개 게시 목적이 아니다.

그런데 지금은 클립 하나를 렌더링하려면 **영상·음악·실연 권리 3건을 모두 입력하고 증빙 파일까지 올려야** 한다. 개인 확인용으로는 과한 절차다.

**목표: 권리 3건 입력 없이 렌더링까지 가능하게 하되, 실제 발행은 영구히 막는다.**

---

## 2. 절대 지킬 안전 규칙

이걸 어기면 이 기능은 만들면 안 된다.

1. **`mode === 'live'`에서는 무조건 실패한다.** 개인 테스트 클립은 어떤 경우에도 실제 발행 경로를 통과할 수 없다.
2. **캡션에 거짓을 쓰지 않는다.** 지금 클립형 캡션 마지막에 `Clip used with permission (...)`이 들어간다. 권리를 입력하지 않았으므로 **이 문장을 쓰면 안 된다.** 대신 `Personal test render — not licensed for distribution.` 로 바꾼다.
3. **영상 안에도 표시한다.** 클립 템플릿의 `credit` 자리에 `개인 테스트용 · 권리 미확인 · 배포 불가` 를 넣는다.
4. **화면에 빨간 배지로 표시한다.** `권리 미확인 · 개인 확인용` 처럼, 운영자가 이게 정상 클립이 아님을 한눈에 알아야 한다.
5. **기본값은 꺼짐(0)이다.** 기존 예시 데이터와 테스트 30개가 그대로 통과해야 한다.
6. **유튜브 등에서 영상을 내려받는 기능은 만들지 않는다.** URL을 넣어 다운로드하는 코드는 추가 금지. 운영자가 이미 가진 로컬 파일만 대상이다.
7. **`내보내기`의 `읽어보기.txt`에 경고를 넣는다.** "이 영상은 권리를 확인하지 않은 개인 확인용입니다. 공개 게시하지 마세요."

---

## 3. 구현

### 3-1. 데이터베이스
`src/db/schema.sql` 의 `clip_assets` 에 컬럼 추가:
```sql
personal_use_only  INTEGER NOT NULL DEFAULT 0 CHECK (personal_use_only IN (0,1)),
```
`src/db/index.js` 의 `COLUMN_MIGRATIONS` 에도 추가해 기존 데이터베이스가 그대로 열리게 할 것:
```js
['clip_assets', 'personal_use_only', 'INTEGER NOT NULL DEFAULT 0'],
```

### 3-2. 권한 판정 — `src/rights/evaluate.js`
파일 존재 확인과 길이 확인은 **그대로 하고**, 권리 3종 반복문만 건너뛴다.

```
if (asset.personal_use_only) {
    live 모드이면      → fail('Personal-use clip — never valid for live publishing',
                              '개인 확인용 클립입니다. 실제 발행에는 쓸 수 없습니다.')
    live 모드가 아니면 → checks 에 { ok:true, testOnly:true } 로
                         'Personal use only — rights NOT verified'
                         '개인 확인용 — 권리를 확인하지 않았습니다. 공개 게시하면 안 됩니다.'
                         를 넣고, 권리 3종 반복문을 건너뛴다
}
```
- `testOnly` 는 반드시 `true` 로 반환해야 한다. 화면과 드라이런이 이 값으로 경고를 띄운다.
- 길이 제한(`maxClipDurationSec`)과 파일 존재 확인은 **건너뛰지 마라.** 둘 다 렌더링 실패로 직결된다.

### 3-3. 문구 — `src/copy/templates.js`
`buildCopy` 의 `format === 'licensed_clip'` 분기에서, `clipAsset.personal_use_only` 이면
`Clip used with permission (...)` 대신
`Personal test render — not licensed for distribution.` 을 넣는다.

### 3-4. 영상 — `src/render/renderReel.js`
`credit` 변수를 만들 때 `clipAsset.personal_use_only` 이면
`개인 테스트용 · 권리 미확인 · 배포 불가` 로 대체한다.

### 3-5. 저장 — `src/ingest/manualEntry.js`, `src/ingest/importJson.js`
`saveClipAsset` 과 JSON 가져오기에서 `personal_use_only` 를 받아 저장한다. 다른 불리언 필드와 똑같이 다루면 된다.

### 3-6. 화면 — `src/web/public/manage.js`
5단계 클립 입력에 체크박스 추가:

> ☐ **개인 확인용 (권리 입력 건너뛰기)**
> 내 PC에 있는 영상을 잘라서 어떻게 보이는지 확인만 합니다. 권리 3종을 입력하지 않아도 영상이 만들어집니다.
> **대신 이 영상은 실제 발행이 영구히 막히고, 공개 게시하면 안 됩니다.**

체크하면 아래 권리 3종 입력 영역을 **접거나 흐리게** 처리해, 입력하지 않아도 된다는 것이 보이게 하라.

운영 화면(`app.js`)의 권리 판정 칸에도 `권리 미확인 · 개인 확인용` 배지를 빨간 계열로 표시하라.

### 3-7. 내보내기 — `src/export/exportReel.js`
클립이 `personal_use_only` 이면 `읽어보기.txt` 맨 위에 다음 줄을 넣어라:
```
⚠ 이 영상은 권리를 확인하지 않은 개인 확인용입니다. 공개 게시하지 마세요.
```

---

## 4. 테스트 (필수)

`test/` 에 다음을 추가하라.

1. `personal_use_only` 클립은 **예행 연습에서 렌더링된다** (권리 0건이어도 공연 클립형이 나온다).
2. 같은 클립이 **live 모드에서는 반드시 거부된다.**
3. 캡션에 `used with permission` 이라는 문구가 **들어 있지 않다.**
4. 길이 제한을 넘기면 `personal_use_only` 여도 **거부된다.**
5. **기존 테스트 30개가 그대로 통과한다.** (예시 데이터는 이 플래그를 쓰지 않으므로 11-15 그래픽형 전환 시나리오 등이 바뀌면 안 된다.)

---

## 5. 보고

끝나면 변경 파일, 실행 명령, 테스트 결과를 보고하고, **실제로 화면에서 개인 확인용 클립을 하나 등록해 영상이 나오는 것까지 확인**한 뒤 결과를 알려라. 코드만 고치고 확인했다고 하지 마라.

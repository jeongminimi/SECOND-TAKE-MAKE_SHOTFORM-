# 4순위 — 영상 크기 조절과 글씨 겹치기

작성 2026-11-24 · `NEXT-TASKS.md` 1~3순위 완료 후 이어지는 작업입니다.

---

## 0. 왜 하는가

참고 계정(`off_playlist`)의 게시물을 보면 영상이 화면을 거의 꽉 채우고, 글씨가 그 위에 얹혀 있습니다.

지금 우리 결과물은 16:9 영상이 **1080×608**로 들어갑니다. 세로 1920 중 **32%**밖에 안 됩니다. 위아래 빈 띠가 화면의 3분의 2입니다. 참고 계정은 60~70%를 채웁니다.

운영자가 **영상에 따라** 크기와 글씨 위치를 고를 수 있어야 합니다. 무대 전체를 보여줘야 하는 영상도 있고, 얼굴을 크게 잡아야 하는 영상도 있습니다.

---

## 1. 지금 코드가 어떻게 돼 있는지

먼저 읽고 시작하세요. 이미 되어 있는 것을 다시 만들지 마세요.

### 1-1. 글씨는 이미 영상 위에 그려지고 있습니다

`src/render/renderReel.js:67-68`

```js
filter = `[0:v]scale=${W}:-2:force_original_aspect_ratio=decrease,setsar=1,fps=${FPS}[clip];\n` +
  `[1:v][clip]overlay=x=(W-w)/2:y=${tpl.video?.y ?? 650}:shortest=1,\n${fb.chain()},format=yuv420p[v]`;
```

순서가 `배경 → 영상 overlay → fb.chain()(모든 drawtext/drawbox)` 입니다. **글씨가 영상보다 나중에 그려집니다.** 지금 안 겹치는 건 템플릿이 글씨를 빈 띠 안에만 배치했기 때문입니다.

즉 **"글씨 겹치기"는 새 기능이 아니라 템플릿 좌표 문제**입니다.

### 1-2. 템플릿에 이미 `video` 키가 있습니다

`templates/reels/clip-standard.json`

```json
"video": { "y": 650 },
```

이 키를 확장하면 됩니다. 새로 만들지 마세요.

### 1-3. 템플릿 엔진이 이미 지원하는 것

`src/render/templateEngine.js`

- 88행 `text()` — drawtext 생성. **`box` 옵션 이미 지원** (89행: `box=1:boxcolor=...:boxborderw=...`)
- 95행 `drawBox()` — drawbox 생성. `enable` 조건부 표시도 지원
- 요소 타입: `text`, `box`, `pill`, `clipCues`

**없는 것: 글씨 그림자.** 이번에 추가합니다.

### 1-4. DB 컬럼은 추가하지 않습니다

`reels.template_id` 컬럼이 이미 있습니다. 템플릿 선택은 이 컬럼에 저장하세요.

---

## 2. 할 일

### 2-1. 템플릿 `video` 키 확장

```json
"video": {
  "y": 650,
  "height": 608,
  "fit": "contain",
  "cropX": 0.5
}
```

| 키 | 뜻 | 기본값 |
|---|---|---|
| `y` | 영상 위쪽 세로 위치(px) | 650 |
| `height` | 영상 높이(px) | 없으면 원본 비율대로 계산 |
| `fit` | `contain` = 비율 유지, 박스 안에 맞춤 / `cover` = 박스를 꽉 채우고 넘치는 좌우를 자름 | `contain` |
| `cropX` | `cover`일 때 좌우 어디를 남길지. 0.0=왼쪽 / 0.5=가운데 / 1.0=오른쪽 | 0.5 |

**`fullBleed: true`** 를 `video` 안에 주면 영상이 화면 전체(1080×1920)를 채웁니다. 이때 배경은 그리지 않고 영상이 바닥이 됩니다.

### 2-2. FFmpeg 필터 — 아래 문자열은 검증 완료본입니다

FFmpeg 4.4.2에서 실제로 돌려 확인했습니다. **그대로 쓰세요.**

**`fit: "cover"` (박스 꽉 채우고 좌우 자르기)**

```
scale=1080:{height}:force_original_aspect_ratio=increase,setsar=1,
crop=1080:{height}:x=(in_w-out_w)*{cropX}:y=(in_h-out_h)/2
```

**`fullBleed: true`**

```
scale=1080:1920:force_original_aspect_ratio=increase,setsar=1,
crop=1080:1920:x=(in_w-out_w)*{cropX}:y=(in_h-out_h)/2
```
→ 이 경우 배경 입력(`[1:v]`)과 `overlay` 없이 `[0:v]`를 바로 `fb.chain()`에 넣습니다.

**`fit: "contain"` (현재 방식, 높이 지정 가능)**

```
scale=1080:{height}:force_original_aspect_ratio=decrease,setsar=1
```
→ 기존처럼 `overlay=x=(W-w)/2:y={y}`

`cropX` 0.0 / 0.5 / 1.0 세 값이 각각 다른 결과를 내는 것까지 확인했습니다.

### 2-3. 새 요소 타입 `scrim`

영상 위에 글씨를 얹으면 밝은 장면에서 안 읽힙니다. 반투명 띠를 깔아야 합니다.

```json
{ "type": "scrim", "y": 1400, "h": 520, "color": "black", "opacity": 0.45, "from": "bottom" }
```

- `drawbox=x=0:y={y}:w=1080:h={h}:color={color}@{opacity}:t=fill` 로 생성
- `from: "bottom"` 또는 `"top"` 이면 단색 대신 **계단식 그라데이션**: 같은 영역을 3~4겹으로 나눠 투명도를 0.15 → 0.55 식으로 겹쳐 그립니다. (FFmpeg `drawbox` 여러 번. `gradients` 필터도 4.4에 있지만 겹치기가 더 단순합니다.)
- `elements` 배열 안에서 **글씨보다 먼저** 와야 글씨가 위에 옵니다.

### 2-4. `text` 요소에 `shadow` 추가

```json
{ "type": "text", "bind": "headline", "size": 72, "y": 360, "shadow": true }
```

`shadow: true`면 drawtext에 아래를 덧붙입니다. (4.4.2 지원 확인 완료)

```
:shadowcolor=black@0.85:shadowx=3:shadowy=3
```

`shadow: { color, x, y }` 형태로 세부 지정도 받으세요. 기본은 위 값.

### 2-5. 템플릿 3종 추가

`clip-standard.json`은 **건드리지 마세요.** 기존 릴스가 깨집니다. 아래 3개를 새로 만듭니다.

| 파일 | 영상 | 글씨 |
|---|---|---|
| `clip-large.json` | `y:360, height:1200, fit:"cover", cropX:0.5` | 위아래 남은 띠에 배치, 아래쪽은 일부 겹침 |
| `clip-full.json` | `fullBleed:true, cropX:0.5` | **영상 위에 겹침.** 상단 scrim + 하단 scrim, 글씨 전부 `shadow:true` |
| `clip-minimal.json` | `fullBleed:true, cropX:0.5` | 하단에만 최소한으로 (브랜드 · 공연자 · 출처 · 안내). 제목·why 없음 |

각 템플릿의 `name`·`description`은 **한글로** 쓰세요. 운영자가 화면에서 고를 때 보이는 글입니다.

- `clip-standard` → "원본 비율 (여백 있음)"
- `clip-large` → "크게 (좌우 약간 잘림)"
- `clip-full` → "꽉 채우기 (글씨가 영상 위에)"
- `clip-minimal` → "꽉 채우기 · 글씨 최소"

### 2-6. 화면 — 영상 아래에 템플릿 선택

미리보기 카드(`previewCard`) **바로 아래**, 내보내기 버튼 옆에 놓으세요.

- 템플릿 4개를 **가로 버튼**으로. 현재 선택된 것 표시.
- `clip-full` / `clip-minimal` / `clip-large` 를 고르면 그 아래에 **좌우 위치 슬라이더**가 나옵니다 (왼쪽 ↔ 가운데 ↔ 오른쪽, 5단계면 충분).
- `clip-standard`는 안 잘리므로 슬라이더를 숨깁니다.
- 고르면 **"이 모양으로 다시 만들기"** 버튼. 누르면 재렌더.
- 재렌더 중에는 버튼을 잠그고 진행 표시. 렌더는 수십 초 걸립니다.

**중요: 자동으로 재렌더하지 마세요.** 슬라이더를 움직일 때마다 렌더하면 못 씁니다. 반드시 버튼을 눌러야 시작합니다.

### 2-7. API

```
POST /api/reel/:id/template
body: { template_id: "clip-full", cropX: 0.5 }
```

동작:
1. `template_id`가 `templates/reels/`에 실제로 있는 파일인지 확인. 없으면 400.
2. 그 릴스의 `output_format`과 템플릿의 `format`이 맞는지 확인. 클립 릴스에 그래픽 템플릿을 넣으면 400.
3. `reels.template_id` 갱신, `cropX`는 릴스 행에 저장 (컬럼 없으면 `COLUMN_MIGRATIONS`에 `crop_x REAL DEFAULT 0.5` 추가)
4. **같은 릴스 행을** 다시 렌더. 새 행을 만들지 마세요. 구간 승인(`/api/suggestions/:id/approve`)이 하는 것과 같은 방식입니다.
5. 선곡은 다시 하지 않습니다.

---

## 3. 절대 지킬 것

1. **권리 확인 표시는 어느 템플릿에서도 사라지면 안 됩니다.** `footer`·`credit` (출처, `personal_use_only`일 때 "권리 미확인" 문구)는 `clip-minimal`에도 반드시 들어갑니다. 꽉 채운 영상 위에서도 읽히도록 scrim을 깔아야 합니다.
2. **가사를 넣지 마세요.** 가사는 별도 저작물입니다. 참고 계정에 가사가 있어도 우리는 안 합니다.
3. **"NO COPYRIGHT OWNED" 같은 문구를 넣지 마세요.** 법적 효력이 없고, 오히려 권리를 확인 안 했다는 기록이 됩니다.
4. `clip-standard.json`과 그래픽형 템플릿 2개는 **그대로 둡니다.** 기본값도 그대로 `clip-standard`입니다.
5. 기존 렌더 경로(`fit`·`fullBleed` 없는 템플릿)가 **지금과 똑같은 결과**를 내야 합니다.
6. **push 금지.** 로컬 커밋만.

---

## 4. 테스트

`test/templates-video.test.js` 새로 만드세요.

1. `clip-standard`로 렌더 → 영상이 1080×608로 y=650에 들어가는지 (기존 동작 보존)
2. `clip-full`로 렌더 → 출력이 1080×1920이고, 생성된 필터 문자열에 `crop=1080:1920`이 들어가는지
3. `cropX` 0.0 / 0.5 / 1.0 → 필터 문자열의 `x=` 식이 각각 다른지
4. `shadow: true`인 text → drawtext에 `shadowcolor`가 붙는지
5. `scrim` 요소 → `drawbox`가 글씨보다 **앞** 순서에 생성되는지
6. `POST /api/reel/:id/template` 에 없는 템플릿 id → 400
7. 클립 릴스에 그래픽 템플릿 id → 400
8. 템플릿 변경 후 → **같은 릴스 id**가 유지되고 `render_status`가 다시 `done`이 되는지
9. 모든 템플릿에서 `credit` 요소가 렌더되는지 (권리 표시 보존)

**기존 테스트 53개가 전부 통과해야 합니다.** 깨지면 그건 회귀입니다 — 이번엔 의도된 변경이 없습니다.

---

## 5. 하지 말 것

- 영상 다운로드 기능 (yt-dlp 등) — 넣지 않기로 했습니다
- 인스타그램 자동 업로드
- `DEMAND-ANALYSIS.md` 차트 수집 — 접었습니다
- 선곡 규칙 손대기 — v2.0 그대로 둡니다
- 과거 선곡 기록 다시 돌리기 — v1.0 기록은 그대로 둡니다

---

## 6. 끝나면 보고할 것

- 바뀐 파일 목록
- 테스트 결과 (기존 53 + 신규 N)
- `clip-full`로 실제 렌더한 결과물 경로 하나
- 예상 못 한 변경이 있었다면 그 내용

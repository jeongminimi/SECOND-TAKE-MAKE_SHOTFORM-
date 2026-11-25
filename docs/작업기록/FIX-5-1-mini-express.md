# 5-1 수정 — Express 없는 환경에서 미리보기가 깨집니다

## 증상

`GET /api/reel/:id/crop-preview` 가 **Express가 설치되지 않은 환경에서 400**을 돌려줍니다.

```
{"ok":false,"error":"res.type(...).set is not a function"}
```

안티그라비티 환경에는 Express가 깔려 있어 68/68로 통과하지만, **`src/web/mini-express.js` 대체 구현으로 돌아가면 미리보기가 전혀 안 됩니다.**

이 프로그램은 npm 설치 없이도 돌아가도록 `mini-express.js`를 일부러 유지하고 있습니다. 초기 구축 때 실제로 이걸로 돌렸습니다. 이 경로가 깨지면 안 됩니다.

## 원인 2가지

`src/web/server.js:133`

```js
res.type('jpeg').set('Cache-Control', 'no-store').send(...)
```

1. `mini-express.js`에 **`res.set`이 없습니다.** (`status`·`type`·`json`·`send`만 있음)
2. `res.type('jpeg')` 가 `MIME['.jpeg']` 를 찾는데 **MIME 표에 `.jpeg`·`.jpg`가 없어** 헤더가 `image/jpeg`가 아니라 문자열 `jpeg`로 나갑니다.

## 고칠 곳 — `src/web/mini-express.js` 2줄

**11행 MIME 표에 jpg/jpeg 추가**

```js
// 전
'.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4',
// 후
'.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4',
```

**42행 `res.type` 바로 아래에 `res.set` 추가**

```js
res.set = (k, v) => { if (k && typeof k === 'object') for (const [n, val] of Object.entries(k)) res.setHeader(n, val); else res.setHeader(k, v); return res; };
```

`server.js`는 고치지 마세요. Express 쪽 코드가 맞고, 대체 구현이 따라가야 합니다.

## 검증 완료

이 2줄을 적용하고 Express 없는 환경에서 **68개 전부 통과**하는 것을 확인했습니다.

## 재발 방지

`mini-express.js`에 새 메서드를 쓸 때마다 같은 일이 생깁니다. 5-2 이후 라우트에서 `res.`로 시작하는 Express 기능을 쓰기 전에 `mini-express.js`에 그게 있는지 먼저 확인하세요.

가능하면 `test/web.test.js`에 **대체 구현을 강제로 쓰게 하는 테스트**를 하나 넣으세요. 그러면 다음부터는 테스트가 잡아 줍니다.

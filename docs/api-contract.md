# API 연결 규약 v1

현재 구현된 경로입니다. 로컬 주소는 `http://127.0.0.1:8000`, 대화형 문서는 `/docs`입니다.
배포 구성에서는 Nginx의 `/api/`가 FastAPI로 연결됩니다.

## 현재 구현: GET /health

- 로컬 주소: `http://127.0.0.1:8000/health`
- 성공 응답: HTTP 200
- 목적: API 프로세스의 응답 여부 확인. DB나 모델 상태는 포함하지 않음.

```json
{
  "status": "ok",
  "service": "hwagae-jangnal-api",
  "version": "0.2.0",
  "release": "local"
}
```

- 대화형 문서: `http://127.0.0.1:8000/docs`
- OpenAPI 스키마: `http://127.0.0.1:8000/openapi.json`

## 계정과 매장

`POST /auth/login`에 `email`, `password`를 보내면 `token`, `user`, `expires_at`이 반환됩니다.
이후 `Authorization: Bearer <token>`을 보냅니다. 세션은 12시간이고 서버에는 토큰 해시만 저장합니다.
`GET /auth/me`, `POST /auth/logout`을 지원합니다. 브라우저는 sessionStorage에 보관합니다.
점주·직원 모두 소속 매장만 조회할 수 있습니다. 점주는 매장의 모든 작업을 하고,
직원은 점주가 허용한 작업(판매 입력·재고 입력·발주안 저장·발주 확정·상품 관리)만 합니다.
`GET /stores`의 각 매장에 `permissions`가 포함됩니다. 직원 초대·권한 API: [직원 관리](staff-management.md).

CORS는 설정된 웹 주소의 GET·POST·PUT·PATCH와 인증 헤더를 허용합니다.

## 구현 경로

| 메서드 | 경로 | 내용 |
| --- | --- | --- |
| GET | `/model-demo` | 로그인 후 고정 Walmart 샘플 설명과 모델 프로세스 준비 상태 |
| POST | `/model-demo/forecast` | 고정 과거 샘플의 실제 TFT 추론 및 같은 입력의 요일 기준선 비교; DB 저장 없음 |
| GET / POST | `/stores` | 소속 매장과 오늘 날짜 / 새 매장 생성 |
| GET / POST | `/stores/{store}/products` | 상품·재고 / 상품 등록, 매장당 최대 50개 |
| PATCH | `/stores/{store}/products/{product}` | 가격·원가·납기·판매 기간·발주 주기 |
| GET | `/stores/{store}/sales?limit=50` | 최근 판매 기록과 전체 기록 수·기간 |
| POST | `/stores/{store}/sales/preview` | multipart `file`로 CSV·XLSX 미리보기 |
| POST | `/stores/{store}/sales` | 확인한 기록을 한 거래로 저장 |
| PUT | `/stores/{store}/inventory/{product}` | 오늘 마감 기준 재고·입고 예정 확인 |
| GET | `/stores/{store}/weather?as_of=YYYY-MM-DD` | 기준일 다음 날부터 7일 날씨 |
| POST | `/stores/{store}/forecasts?as_of=YYYY-MM-DD` | 7일 예측·스냅샷 저장 |
| POST | `/stores/{store}/recommendations` | forecast_id로 재고 기반 발주 계산 |
| GET / POST | `/stores/{store}/orders` | 발주안 목록 / 수정한 수량으로 초안 저장 |
| POST | `/stores/{store}/orders/{order}/confirm` | 점주 최종 확정 |
| GET | `/stores/{store}/orders/{order}/export?format=csv` | 확정 당시 값으로 CSV·XLSX 내보내기 |

## TFT 과거 시연

모델 체험은 별도 인증 경로입니다. `GET /model-demo`는 `runtime: {status, message}`와 `sample: {title, as_of, dates, history_start, history_end, history_days, product_count, products, source, weather_strategy, note}`를 반환합니다. 상태는 `disabled/starting/ready/unavailable`입니다.

`POST /model-demo/forecast`는 본문 없이 고정 샘플을 실제 실행합니다. `model`, `products`, `as_of`, `dates`, `created_at`, `elapsed_ms`, `baseline: {model, products}`, `provenance`, `weather_strategy`, `note`를 반환합니다. 상품별 포인트는 기존 P10/P50/P90 형식이며 `actual=null`입니다. 오류는 503, 인증 실패는 401이며 DB 예측 ID는 생성하지 않습니다.

## 판매 입력

파일은 5MB·10,000행 이내, CSV는 UTF-8/BOM·CP949, Excel은 XLSX 첫 시트입니다.
필수 열은 `date`, `product_id`, `units_sold`입니다. 일부 한국어 열도 지원합니다.
미리보기의 `rows`, `errors: [{row, message}]`, `can_save`를 확인한 뒤 저장합니다.
미리보기는 DB에 쓰지 않습니다. 음수·소수·미래 날짜·미등록 상품·중복을 검사합니다.
중복은 자동 교체·합산하지 않으며, 누락 날짜를 0개로 채우지 않습니다.
저장 요청에 오류가 있으면 전체 요청을 롤백합니다.

```json
{"rows":[{"date":"2026-10-24","product_id":"P001","units_sold":20}]}
```

## 재고 입력

```json
{
  "batches": [{"quantity":10,"expires_on":"2026-10-26"}],
  "incoming": [{"quantity":5,"arrives_on":"2026-10-25","expires_on":"2026-10-27"}],
  "incoming_confirmed": true
}
```

0개 확인은 `batches: []`, 입고 예정 없음은 `incoming: []`와 명시적인 확인으로 표현합니다.
저장한 적이 없는 상품은 미확인이며 0개와 다릅니다. 오늘이 아닌 재고는 재확인합니다.
만료일 당일 마감까지 판매하고, 예정 입고는 내일부터 가능합니다.

## 예측·발주·저장

예측 응답: `id`, `as_of`, `dates`, `created_at`, `model`, `weather`, `products`.
상품별 상태는 `ready` 또는 `insufficient_history`. 정상 상품은 7일 P10·P50·P90입니다.
과거의 `actual`은 비교용이며 모델 입력에서 제외합니다. [모델 연결 규약](model-contract.md)을 참조하세요.

발주 계산 요청은 `{"forecast_id":"..."}`입니다.
응답의 상품별 `quantity: null`과 `reason`은 계산 불가이며, 0개 추천과 구분합니다.
재고가 없거나 오래됨·예측 부족·설정 오류·7일 범위 초과이면 보류합니다.
초기 계산은 고정 수요 3경로의 비용 비교용 근사 계획입니다. 정확한 기간 분위수·이익 최적화가 아닙니다.

저장 요청:

```json
{"recommendation_id":"계산 결과 ID","lines":[{"product_id":"P001","quantity":17}]}
```

계산 불가 상품은 저장 대상에서 제외하며, 원래 추천과 수정량은 함께 저장합니다.
판매·재고·상품 변경 후 이전 계산으로 저장·확정할 수 없습니다.
저장·확정은 실제 입고·공급사 주문으로 자동 반영되지 않습니다.
확정 파일은 당시 값을 내보내고 이후 자료 변경 여부는 목록에서 표시합니다.

## 오류

401 로그인·만료, 403 권한, 404 없는 자료, 409 중복·계산 기준 변경,
400 파일 읽기 실패, 422 입력 오류, 503 모델 실패·출력 오류입니다.
일반 오류는 `{"detail":"설명"}`, Pydantic 입력 오류는 `detail` 배열입니다.
날씨 실패는 `status: unavailable`, 오래된 캐시는 `stale`로 구분합니다.

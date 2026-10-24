# Colab 담당자 모델 연결 규약

웹·API 담당은 `apps/`, 모델 담당은 `ml/` 중심으로 작업합니다.
현재 기본 예측은 `apps/api/app/forecasting.py`의 **날씨를 사용하지 않는 요일 기준선**입니다.
일반 매장의 예측은 이 기준선을 유지합니다. PR #5로 받은 TFT는 별도 과거 시연 경로로 연결하며 아래 일반 매장 provider와 구분합니다.

## TFT 과거 시연 연결

- `GET /model-demo?sample_id=...`와 `POST /model-demo/forecast?sample_id=...`는 로그인 후 사용합니다. `sample_id`는 `walmart-demo-4`, `walmart-demo-24`, `walmart-demo-17`만 허용하며 기본값은 `walmart-demo-4`입니다. `ml/examples/demo-manifest.json`의 고정 파일만 읽고, 사용자 요청 본문으로 날짜·학습 ID·파일 경로를 교체하지 않습니다. 다른 샘플 ID는 422입니다.
- GET은 기존 `runtime`, `sample`에 선택한 `sample_id`, 선택지 `samples: [{id, label, product_count}]`, `total_products: 10`을 추가합니다. POST 결과에도 `sample_id`를 반환합니다. 별도 매장 생성이나 판매·재고·예측·발주 DB 변경은 없습니다.
- API Python 3.14는 `ops/tft_worker.py`를 별도 Python 3.11 프로세스로 실행합니다. 시작할 때 모델과 고정 샘플을 미리 불러오며, 준비 전·장애·동시 실행·제한시간 초과는 503으로 표시합니다. 저장된 예상 출력이나 기준선을 TFT 결과로 대체하지 않습니다.
- `TFT_PYTHON`, `TFT_CHECKPOINT_PATH`를 설정할 수 있습니다. 기본 모델 Python은 저장소의 `.model-venv`이며, 서버 기본 체크포인트는 `/srv/hwagae/shared/models/best-epoch=02-val_loss=3.9847.ckpt`입니다. 없는 경우 시연만 비활성화됩니다.
- 현재 샘플은 기준일 2014-09-12의 Walmart 매장 4·24·17, 각각 6·3·1상품입니다. 연속 56일 실제 판매 560행으로 다음 7일을 예측합니다. 미래 날씨는 마지막 관측값을 7일 유지하는 `persistence`이며 실제 예보 입력 기능이 아닙니다. 기존 `input.json`, `expected-api.json`, `expected-quantiles.json`의 2상품 파일은 모델 시작 시 준비·기존 ML 입력 파일 호환용으로 보존합니다.
- 출력은 실제 TFT의 P10/P50/P90과 같은 56일 입력으로 계산한 API 요일 기준선을 함께 표시합니다. `actuals.json`의 이후 실제 판매 70행은 추론과 두 출력 검사가 끝난 뒤 `points[].actual`로 연결합니다. 모델 입력에 정답을 넣지 않으며 상품·날짜 중복/누락과 잘못된 판매 수량을 거부하고 0개는 유지합니다.
- `GET /model-demo/evaluation`은 인증 후 저장된 오프라인 평가표를 반환합니다. 파일 누락·잘못된 지표는 내부 경로를 노출하지 않는 503으로 처리합니다. 전체 테스트 재추론이나 학습을 요청하는 경로가 아닙니다.
- 이 체험을 한국 매장·발주 흐름에 연결하지 않으며, 기존 live provider의 실시간 날씨 검사도 완화하지 않습니다. CI는 ML 전처리·샘플·평가 계산을 검사합니다. 체크포인트가 있는 Ubuntu 배포에서는 기본 10상품 smoke와 전체 ML 테스트를 실행하고, 스킵·실패 시 새 버전을 활성화하지 않습니다.

### 평가 화면의 해석

[오프라인 평가표](../ml/evaluation/api-comparison/metrics.csv)는 같은 평가 행에서 TFT·평가 당시 API 요일 기준선·날씨 제거 TFT를 비교합니다. 원본 테스트 전체는 7,973개 상품·일 행(1,139개 예측 창), 최근 56일 모두 관측된 집합은 1,701행(243개 창)입니다. TFT의 API 기준선 대비 MAE 감소는 각각 **6.98%**, **10.71%**입니다.

TFT 입력은 56일, 평가 당시 API 기준선 입력은 최대 84일입니다. 직접 예측 화면의 기준선이 같은 56일 표본을 사용하는 것과 구분합니다. seed 42 한 번의 실험이며 날씨 포함·제거 TFT의 학습 장치·Python 환경 차이가 있어 날씨의 순수한 인과 효과를 증명하지 않습니다. 한국 실제 점포·당시 발급 예보·품절로 놓친 수요·폐기와 이익 개선은 미검증입니다.

PR #7은 평가표·날씨 제거 실험 기록·재현 코드를 전달했습니다. 검산용 `ml/evaluation/tft-evaluation-data.zip`도 추가됐습니다. 이번 통합에서의 ZIP 입력 해시 대조·평가표 재계산 결과는 실행 후 별도 확인하며, 파일 전달만으로 재현 완료로 간주하지 않습니다.

### 로컬 모델 시연 준비

일반 매장의 `FORECAST_PROVIDER`는 비워 둡니다. 현재 TFT는 아래의 별도 실행 환경으로 연결합니다.
Windows에서 저장소 루트 기준:

```powershell
uv venv --no-project --python 3.11 .model-venv
uv pip install --python .model-venv/Scripts/python.exe --index-strategy unsafe-best-match -r ml/requirements-inference.txt
```

`apps/api/.env`의 `TFT_CHECKPOINT_PATH`에 전달받은 체크포인트의 절대 경로를 로컬에서 지정합니다.
Python을 다른 위치에 설치했다면 `TFT_PYTHON`에도 실행 파일의 절대 경로를 지정합니다.
개인 경로나 비밀값을 문서·Git에 복사하지 않습니다. 설정 후 API를 다시 시작하고,
로그인 → **TFT 모델 체험** → **상태 다시 확인**에서 `ready`인지 확인합니다.
모델 파일의 체크섬은 인수 manifest와 일치해야 합니다. 자세한 재현 검사는 [ML 안내](../ml/README.md),
Ubuntu 설치·재시작은 [배포 안내](deployment.md), 발표 흐름은 [시연 안내](demo-runbook.md)를 따릅니다.

## 확정한 학습 방향과 인수 상태 — 2026-10-24

- 모델은 TFT로 확정. 팀원은 Colab A100 환경에서 학습 완료했다고 전달했습니다.
- 입력은 최근 56일, 예측은 다음 7일, Quantile Loss의 분위수는 0.10/0.25/0.50/0.75/0.90입니다.
- 사용 자료는 Walmart Stormy Weather의 train.csv, weather.csv, key.csv입니다.
- `best-epoch=02-val_loss=3.9847.ckpt`와 PR #5의 서버 추론 코드·노트북·평가 결과를 인수했습니다. 팀원의 CPU 재현 기록은 `ml/README.md`, 평가 범위는 `ml/evaluation.md`를 따릅니다. 아래 표는 최초 체크포인트 정적 검사 기록입니다.
- API가 제공하는 최대 84일 기록 중 상품별 기준일까지의 56일을 추론 어댑터가 선택합니다. 날짜 누락·마감 전 데이터는 학습과 동일한 규칙으로 처리하며, 빠진 날짜를 임의로 0으로 만들지 않습니다.
- 현재 API 응답과 화면은 P10/P50/P90만 지원합니다. 모델 인수 파일에는 P25/P75도 보존하되, 추론 어댑터의 API 반환 points에는 date/p10/p50/p90만 넣습니다. Point 스키마는 추가 필드를 거부하므로 P25/P75를 그대로 반환하면 503이 됩니다. 5개 분위수 전체의 저장·표시는 후속 스키마/UI 변경이 필요합니다.
- 팀원의 발주 코드는 비교 자료로 인수합니다. 재고·만료·입고 예정·납기·비용을 반영하는 기존 API 계산과 비교하기 전에는 운영 계산을 교체하지 않습니다.

### 최초 인수 때 정적으로 확인한 내용

아래 표는 최초 검사 시점의 기록입니다. 이후 Python 3.11 CPU 추론 검증은 [ML 안내](../ml/README.md), 운영 환경 검증은 [배포 기록](deployment.md)에서 별도로 확인합니다.

| 항목 | 정적 확인 결과 |
| --- | --- |
| 입력·출력 | encoder 최소/최대 56, prediction 최소/최대 7, target `units`, `output_size=5` |
| 손실 | QuantileLoss, 분위수 0.10/0.25/0.50/0.75/0.90 |
| 전처리 객체 | 학습된 categorical encoder·scaler·매장/상품별 GroupNormalizer·dataset_parameters가 내장됨 |
| 저장된 점수 | epoch 2, best `val_loss=3.9847028255462646`; 재평가한 점수나 정확도 비율이 아님 |
| 기록된 버전 | Lightning 2.5.5, scikit-learn 1.6.1; Python·PyTorch·PyTorch Forecasting 등 전체 버전은 미확인 |
| 장치 | `cuda:0`로 저장됨. CPU 매핑과 실제 추론은 별도 확인 필요 |

파일 SHA-256: `e64b570d22cc03b29bfa2fda37e11878e40ee9c37195cf35e78ae854bfa65909`.
정적 메타데이터는 실행 성공·전처리 재현·예측 품질을 증명하지 않습니다.

체크포인트의 과거·미래 특징은 `tavg`, `tmax`, `tmin`, `preciptotal`, `avgspeed`, 각 열의 `_missing` 지표와 `precip_trace`입니다.
인수한 어댑터는 과거 관측을 처리하고 마지막 날의 특징을 미래 7일에 반복합니다. 일반 매장 context에는 이 과거 날씨가 없으므로 현재는 별도 고정 시연 입력만 사용합니다. `time_idx` 기준일·달력 특징·단위 변환은 인수 코드에 정의되어 있습니다.
`allow_missing_timesteps=False`이며 서버 어댑터는 최근 56일 판매가 모두 관측된 경우만 추론합니다. 누락을 0으로 바꾸지 않습니다.
원본 노트북은 예측 정답 7일이 모두 관측된 창을 선택합니다. `sales_observed` 특징이 있다는 사실만으로 손실에서 자동 마스킹된다고 해석하지 않습니다.
내부 그룹 encoder의 `add_nan=False` 정책을 유지하며 등록된 Walmart 매장·상품 조합만 허용합니다. 한국 가상 상품을 임의 ID에 매핑하지 않으며, 신규 조합은 별도 학습·검증이 필요합니다.

### 최초 인수 요청과 남은 검증

아래 1~5는 PR #5로 전달받았으며, 6의 날씨 제거 TFT·API 기준선과 같은 테스트 행의 평가표·실험 기록은 PR #7로 추가 전달됐습니다. 웹의 직접 예측 표본과 모델 평가 탭은 별도 자료입니다. 새 시연 자료도 현재와 같은 입력 계약으로 전달합니다. ZIP 재계산 검증과 한국 점포·실제 예보·여러 seed 평가는 각각 확인 범위를 구분합니다.

1. 실제 사용한 노트북과 서버 추론 코드, 모델 복원 방법 및 사용자 정의 클래스가 있다면 그 정의.
2. 내장 인코더·스케일러·normalizer·데이터셋 설정을 재사용하는 코드. 별도 직렬화 파일을 중복으로 요구하지 않으며 추론 때 다시 fit하지 않습니다.
3. Python 버전과 실제 설치 패키지 버전 기록. Colab 전체 freeze는 환경 증거이며 서버에 그대로 일괄 설치하는 요구사항이 아닙니다.
4. 입력 열·순서·단위·time_idx 기준일·매장/상품/기상 관측소 연결 규칙·결측값 및 trace 처리·미등록 상품 처리. 판매 누락일의 target 처리와 평가 제외 여부도 포함합니다.
5. 작은 재현 입력과 동일 입력의 7일×5분위수 예상 출력, 실행 방법, 예측 소요 시간.
6. 시간순 학습/검증/최종 테스트 기간과 요일 기준선·날씨 제외 모델 대비 평가 결과. 미래 실제 날씨를 사용한 실험은 당시 예보를 사용한 평가와 구분합니다.

받은 체크포인트의 max_encoder_length=56, max_prediction_length=7 및 단일 판매량 target의 output_size=5는 합의한 설정과 일치합니다.
이미 학습한 모델의 구조를 추론 단계에서 바꾸지 않습니다. 해당 라이브러리의 TimeSeriesDataSet.get_parameters()/from_parameters()는 학습된 인코더·스케일러를 재사용하는 경로입니다.
내장 객체를 정적 조사용 JSON으로 대체하지 않고, 원래 체크포인트와 호환되는 코드·라이브러리로 복원합니다.
서버 API는 Ubuntu ARM64·Python 3.14, 모델은 별도 Python 3.11 CPU 환경을 사용합니다.
대상 환경에서의 설치·실행 확인은 배포 기록에 남깁니다. 로컬 성공이나 정적 검사만으로 다른 운영 환경의 성공을 주장하지 않습니다.

학습에 과거 날씨가 필요하면 현재 context에는 과거 날씨가 없으므로 입력 확장부터 협의합니다.
미국 매장/관측소/상품 식별자를 현재 한국 가상 매장에 근거 없이 대응시키지 않습니다. 데이터에 맞는 별도 데모 또는 미등록 매장 처리 방식을 정합니다.

참조: [TFT 출력 크기](https://pytorch-forecasting.readthedocs.io/en/latest/api/pytorch_forecasting.models.temporal_fusion_transformer.TemporalFusionTransformer.html),
[데이터셋 변환 설정](https://pytorch-forecasting.readthedocs.io/en/latest/api/pytorch_forecasting.data.timeseries.TimeSeriesDataSet.html),
[Lightning 체크포인트](https://lightning.ai/docs/pytorch/stable/common/checkpointing_basic.html).

## 일반 매장 provider 계약 — 향후 모델 교체용

이하 내용은 일반 매장 예측을 교체할 때의 계약입니다. 현재 Walmart TFT는 추가 `model_input`과 별도 실행 환경이 필요하므로 `FORECAST_PROVIDER=ml.predict:predict`로 직접 연결하지 않습니다.
현재 기본 설정은 다음과 같습니다.

```dotenv
FORECAST_PROVIDER=
```

향후 일반 매장 데이터로 검증한 동기 함수 `predict(context: dict) -> dict`를 `모듈:함수` 형식으로 지정할 수 있습니다.
API와 같은 프로세스에서 실행되므로 입력·런타임 호환성을 먼저 검증합니다. 함수 호출 중 학습·Colab 접속·대용량 다운로드는 하지 않습니다.
모델·전처리는 서버의 외부 파일에서 읽습니다. 파일 경로는 환경변수 등으로 전달하세요.
입력이나 공유 전역 객체를 요청마다 변경하지 않습니다.
실패하면 API는 503을 반환하며 기본 예측으로 조용히 대체하지 않습니다.

## 입력 context

| 키 | 내용 |
| --- | --- |
| `schema_version` | 문자열 `1` |
| `store_id` | 매장 ID |
| `as_of` | 한국 시간의 판단 기준일, YYYY-MM-DD |
| `dates` | D+1~D+7 날짜 문자열 7개, 순서 고정 |
| `products` | id·name·category·supplier·price·cost·lead_days·shelf_days·review_days 등 |
| `sales` | 기준일 이하 최근 84일의 product_id·date·units_sold |
| `weather` | status·mode·source·fetched_at·days 등 출처가 있는 자료 |

없는 판매일은 0으로 채우지 않습니다. 기준일 이후 실제 판매량도 포함하지 않습니다.
날씨 일별 열은 date·temp_max·temp_min·rain_mm·rain_probability·code이며 누락은 null입니다.
이 일반 매장 경로의 날씨 사용 모델은 현재 `status=ok`, `mode=live_forecast`에서만 결과를 제공합니다.
과거 재분석을 당시 발급 예보로 대체하는 평가 경로는 지원하지 않습니다.
일반 매장의 과거 재생은 기준선과 실제 판매 비교를 제공합니다. 위의 고정 TFT 시연 경로와 구분합니다.

## 반환값

```python
{
    "model": {"name": "모델 이름", "version": "버전", "uses_weather": True},
    "products": [
        {
            "product_id": "P001",
            "status": "ready",
            "reason": None,
            "points": [
                {"date": "2026-10-25", "p10": 10.0, "p50": 15.0, "p90": 20.0},
                # 실제 반환에는 요청한 dates의 7개 날짜가 모두 필요합니다.
            ],
        },
    ],
}
```

요청한 모든 상품을 중복 없이 반환합니다. 정상 상품은 요청한 날짜 순서 그대로 7개를 반환합니다.
예측값은 유한한 0 이상의 수이고 p10 ≤ p50 ≤ p90이어야 합니다. 소수 수량도 허용합니다.
이력 부족은 `status: insufficient_history`, `reason: 사유`, `points: []`로 표현합니다.
실제 판매 `actual`은 반환하지 않습니다. API가 결과 비교용으로 연결합니다.
발주 개수의 정수 변환·재고·납기·만료·비용 계산은 API 담당 영역입니다.

## 전달물

- 노트북 없이 서버에서 실행되는 추론 코드와 작은 입출력 예제.
- 모델·전처리·인코더·특징 순서·결측 처리 규칙.
- Python·패키지 버전. API는 Python 3.14이므로 추론 호환성을 확인합니다.
- 시간순 학습·검증·최종 테스트 기간, 기준선 비교, 분위수 손실·구간 포함률.
- 원본 자료 출처·지역·기간·단위·라이선스, 날씨 정보의 기준 시각.

가중치·비밀값은 Git에 넣지 않습니다. 코드·규약·평가 요약과 검산용 `ml/evaluation/tft-evaluation-data.zip`을 공유하며, 추가 대용량 원본 자료는 별도로 전달합니다.
이 규약이 맞지 않으면 API 코드를 바로 고치기 전에 입력·출력 변경을 합의합니다.

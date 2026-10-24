# Colab 담당자 모델 연결 규약

웹·API 담당은 `apps/`, 모델 담당은 `ml/` 중심으로 작업합니다.
현재 기본 예측은 `apps/api/app/forecasting.py`의 **날씨를 사용하지 않는 요일 기준선**입니다.
운영 서비스에는 아직 학습 모델이 연결되지 않았습니다. 팀원 결과를 다음 규약으로 연결합니다.

## 확정한 학습 방향과 인수 상태 — 2026-10-24

- 모델은 TFT로 확정. 팀원은 Colab A100 환경에서 학습 완료했다고 전달했습니다.
- 입력은 최근 56일, 예측은 다음 7일, Quantile Loss의 분위수는 0.10/0.25/0.50/0.75/0.90입니다.
- 사용 자료는 Walmart Stormy Weather의 train.csv, weather.csv, key.csv입니다.
- `best-epoch=02-val_loss=3.9847.ckpt`를 인수해 메타데이터를 정적으로 확인했습니다. 서버 추론 코드·노트북·평가 결과는 아직 인수하지 않았으며, 실제 모델 복원·추론·서버 호환성은 검증 전입니다.
- API가 제공하는 최대 84일 기록 중 상품별 기준일까지의 56일을 추론 어댑터가 선택합니다. 날짜 누락·마감 전 데이터는 학습과 동일한 규칙으로 처리하며, 빠진 날짜를 임의로 0으로 만들지 않습니다.
- 현재 API 응답과 화면은 P10/P50/P90만 지원합니다. 모델 인수 파일에는 P25/P75도 보존하되, 추론 어댑터의 API 반환 points에는 date/p10/p50/p90만 넣습니다. Point 스키마는 추가 필드를 거부하므로 P25/P75를 그대로 반환하면 503이 됩니다. 5개 분위수 전체의 저장·표시는 후속 스키마/UI 변경이 필요합니다.
- 팀원의 발주 코드는 비교 자료로 인수합니다. 재고·만료·입고 예정·납기·비용을 반영하는 기존 API 계산과 비교하기 전에는 운영 계산을 교체하지 않습니다.

### 받은 체크포인트에서 확인한 내용

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

과거 입력과 미래 입력 모두 `tavg`, `tmax`, `tmin`, `preciptotal`, `avgspeed`, 각 열의 `_missing` 지표와 `precip_trace`를 요구합니다.
현재 API에는 과거 날씨가 없고 미래 평균기온·평균풍속도 없으므로, 원래 단위·특징 생성 규칙을 확인한 뒤 입력을 확장해야 합니다. `time_idx` 기준일과 달력 특징 계산도 원래 코드를 따릅니다.
`allow_missing_timesteps=False`이므로 연속 날짜 구성과 누락 처리 규칙이 필요합니다. `sales_observed`는 입력 특징이고 dataset `weight`는 null이므로, 이 지표만으로 누락 판매가 손실 계산에서 제외됐다고 판단하지 않습니다.
일반 categorical encoder에는 unknown 처리가 있지만 내부 `__group_id__store_nbr`·`__group_id__item_nbr` encoder는 `add_nan=False`입니다. 팀원은 날씨 입력·식별자·평가 관련 사항을 해결했거나 인지하고 있다고 전달했습니다. 실제 대응 코드와 재현 결과를 인수한 뒤 한국 가상 매장·상품과 학습 ID의 대응 및 신규 그룹 처리를 확인합니다.

### Colab에서 추가로 준비할 인수 묶음

1. 실제 사용한 노트북과 서버 추론 코드, 모델 복원 방법 및 사용자 정의 클래스가 있다면 그 정의.
2. 내장 인코더·스케일러·normalizer·데이터셋 설정을 재사용하는 코드. 별도 직렬화 파일을 중복으로 요구하지 않으며 추론 때 다시 fit하지 않습니다.
3. Python 버전과 실제 설치 패키지 버전 기록. Colab 전체 freeze는 환경 증거이며 서버에 그대로 일괄 설치하는 요구사항이 아닙니다.
4. 입력 열·순서·단위·time_idx 기준일·매장/상품/기상 관측소 연결 규칙·결측값 및 trace 처리·미등록 상품 처리. 판매 누락일의 target 처리와 평가 제외 여부도 포함합니다.
5. 작은 재현 입력과 동일 입력의 7일×5분위수 예상 출력, 실행 방법, 예측 소요 시간.
6. 시간순 학습/검증/최종 테스트 기간과 요일 기준선·날씨 제외 모델 대비 평가 결과. 미래 실제 날씨를 사용한 실험은 당시 예보를 사용한 평가와 구분합니다.

받은 체크포인트의 max_encoder_length=56, max_prediction_length=7 및 단일 판매량 target의 output_size=5는 합의한 설정과 일치합니다.
이미 학습한 모델의 구조를 추론 단계에서 바꾸지 않습니다. 해당 라이브러리의 TimeSeriesDataSet.get_parameters()/from_parameters()는 학습된 인코더·스케일러를 재사용하는 경로입니다.
내장 객체를 정적 조사용 JSON으로 대체하지 않고, 원래 체크포인트와 호환되는 코드·라이브러리로 복원합니다.
서버는 Ubuntu ARM64 CPU·Python 3.14이며, CUDA 강제 호출·Colab 경로·학습용 mixed precision 의존성을 분리한 CPU 추론을 검증해야 합니다.
필요하면 모델 전용 실행 환경을 분리하되 기존 API 환경을 먼저 변경하지 않습니다.

학습에 과거 날씨가 필요하면 현재 context에는 과거 날씨가 없으므로 입력 확장부터 협의합니다.
미국 매장/관측소/상품 식별자를 현재 한국 가상 매장에 근거 없이 대응시키지 않습니다. 데이터에 맞는 별도 데모 또는 미등록 매장 처리 방식을 정합니다.

참조: [TFT 출력 크기](https://pytorch-forecasting.readthedocs.io/en/latest/api/pytorch_forecasting.models.temporal_fusion_transformer.TemporalFusionTransformer.html),
[데이터셋 변환 설정](https://pytorch-forecasting.readthedocs.io/en/latest/api/pytorch_forecasting.data.timeseries.TimeSeriesDataSet.html),
[Lightning 체크포인트](https://lightning.ai/docs/pytorch/stable/common/checkpointing_basic.html).

## 연결

`ml/predict.py`에 동기 함수 `predict(context: dict) -> dict`를 작성하고,
API의 로컬 `.env`에 다음을 설정한 뒤 서버를 다시 시작합니다.

```dotenv
FORECAST_PROVIDER=ml.predict:predict
```

다른 모듈도 `모듈:함수`로 지정할 수 있습니다. 함수 호출 중 학습·Colab 접속·대용량 다운로드는 하지 않습니다.
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
날씨 사용 모델은 현재 `status=ok`, `mode=live_forecast`에서만 결과를 제공합니다.
과거 재분석을 당시 발급 예보로 대체하는 평가 경로는 지원하지 않습니다.
과거 재생은 현재 기준선과 실제 판매 비교까지 가능합니다.

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

큰 데이터·가중치·비밀값은 Git에 넣지 않습니다. 작은 코드·규약·평가 요약을 Git에서 공유합니다.
이 규약이 맞지 않으면 API 코드를 바로 고치기 전에 입력·출력 변경을 합의합니다.

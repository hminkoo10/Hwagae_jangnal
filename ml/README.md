# TFT CPU 추론 인수 묶음

기존 `best-epoch=02-val_loss=3.9847.ckpt`로 **재학습 없이 56일 → 7일 판매 수요**를 추론한다. `predict(context: dict) -> dict`는 요청 상품별 `date/p10/p50/p90`만 반환한다. 체크포인트는 다시 배포하지 않는다.

**API 담당자가 먼저 볼 파일:** [추가 입력 필드·단위·예시 JSON](examples/input-fields.json), [실행 가능한 전체 입력](examples/input.json), [API 예상 반환](examples/expected-api.json). 현 API에는 과거 날씨와 학습 ID 대응이 없어 이 입력 확장이 필요하다. 웹·FastAPI·DB·배포 설정은 변경하지 않는다.

## 검증 환경과 설치

검증일 2026-10-24. **CPython 3.11.0, Windows x86_64, PyTorch 2.11.0+cpu**, CUDA 사용 불가 환경에서 설치와 추론을 확인했다. 전이 의존성까지 [requirements-inference.txt](requirements-inference.txt)에 고정했다. 원래 학습은 Python 3.13.16 / A100 / BF16이며 [실행 환경 증거](metadata/training_environment.json)를 보존했다.

저장소 루트에서 실행한다. uv와 Python 3.11을 준비하고 **모델 전용 환경**을 만든다. 루트 프로젝트의 Python 3.14용 API 환경과 잠금 파일은 변경하지 않는다.

Windows PowerShell:

```powershell
uv venv --no-project --python 3.11 ml/.venv
uv pip install --python ml/.venv/Scripts/python.exe --index-strategy unsafe-best-match -r ml/requirements-inference.txt
$env:TFT_CHECKPOINT_PATH = "C:\models\best-epoch=02-val_loss=3.9847.ckpt"
ml/.venv/Scripts/python.exe -m ml.smoke_test
ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests -v
```

POSIX 명령은 다음과 같다. **Ubuntu ARM64 및 Python 3.14 조합은 미검증**이며 아래 명령이 해당 서버의 설치 성공을 뜻하지 않는다. 고정된 기존 NumPy/pandas/scikit-learn과 CPU wheel 조합은 대상 서버에서 별도 검증이 필요하다.

```sh
uv venv --no-project --python 3.11 ml/.venv
uv pip install --python ml/.venv/bin/python --index-strategy unsafe-best-match -r ml/requirements-inference.txt
export TFT_CHECKPOINT_PATH=/models/best-epoch=02-val_loss=3.9847.ckpt
ml/.venv/bin/python -m ml.smoke_test
ml/.venv/bin/python -m unittest discover -s ml/tests -v
```

`--index-strategy unsafe-best-match`는 고정 패키지를 PyPI와 공식 PyTorch CPU 인덱스에서 함께 찾게 하는 uv 옵션이다. 생략하면 PyTorch 인덱스의 다른 패키지 버전 때문에 설치가 실패할 수 있다. 설치 이후 추론에는 인터넷·Colab·학습 데이터 ZIP이 필요 없다. 체크포인트 경로만 실제 파일 위치로 바꾼다. `--checkpoint <path>`를 smoke test에 전달해도 된다.

## 파일과 저장된 상태

| 파일 | 역할 |
| --- | --- |
| `predict.py` | CPU 복원, 프로세스 내 캐시, 동기 predict 함수 |
| `preprocess.py` | 원본 특징, 단위 변환, 결측, ID/날짜 검사 |
| `metadata/` | 저장된 날씨 중앙값, 200개 학습 시계열 대응, 체크섬 |
| `examples/` | 실제 입력, 7일×5분위수 예상 출력, API 출력, 이력 부족 사례 |
| `smoke_test.py` | 예상 출력 비교, API 필드·순서·유한값 검사, 시간 측정 |
| `tests/` | 원본 일치, 무학습, 동시 요청, 입력 불변, 오류 검사 |
| `notebooks/startup_thon_1.ipynb` | 지정한 원본 학습 코드; 출력·실행 메타데이터만 제거 |
| `notebooks/environment-freeze-training.txt` | Colab 환경 증거; 서버 설치 목록이 아님 |
| `evaluation.md` | 시간 분할, 기준선 비교, 날씨 조건, 미검증 항목 |

체크포인트 SHA-256: `e64b570d22cc03b29bfa2fda37e11878e40ee9c37195cf35e78ae854bfa65909`. 불일치하면 오류를 낸다. 내장된 **학습된 dataset_parameters·categorical encoders·scalers·GroupNormalizer**를 재사용하므로 별도 `dataset_parameters.pkl`을 다시 전달할 필요가 없다.

`map_location="cpu"`만으로는 원본의 `__special_save__` TorchMetrics에 `cuda:0` 상태가 남는다. 같은 TFT 설정에 CPU loss/평가 객체를 만들고 `state_dict` 전체를 `strict=True`로 복원한다. 가중치·전처리 통계는 바꾸지 않으며 optimizer/trainer는 생성하지 않는다.

PyTorch Forecasting 1.5의 `from_parameters()`는 학습된 내부 group encoder에도 `fit(overwrite=False)` 훅을 호출한다. `FrozenGroupEncoder`는 이 훅을 **저장된 범주 확인만 하는 처리**로 바꾸며 원래 fit이나 범주 확장을 실행하지 않는다. 나머지 스케일러·normalizer는 fitted 상태를 확인하고 복사하여 재사용한다. 원래 fit·Trainer.fit·CUDA 호출을 실패하도록 막은 실제 테스트도 통과했다.

| 환경변수 | 기본/설명 |
| --- | --- |
| `TFT_CHECKPOINT_PATH` | 필수, 이미 받은 체크포인트 경로 |
| `TFT_METADATA_DIR` | 기본 ml/metadata, 해당 모델의 저장 중앙값·대응표·manifest |
| `TFT_NUM_THREADS` | 기본 1, 허용 1~64. 최초 로드 시 프로세스 전체 PyTorch CPU 스레드 수 설정 |

모델은 프로세스마다 한 번 로드하고 동시 요청은 모델별 lock으로 직렬 처리한다. 요청·학습 상태를 변경하지 않는다. 같은 경로의 파일을 교체하면 프로세스를 재시작해야 한다. 신뢰하는 학습 산출물만 사용한다(체크포인트는 Python 객체 직렬화 파일).

## 필요한 입력과 처리 규칙

기존 context에 `model_input`과 상품별 `model_item_nbr`를 추가한다. 아래는 추가 필드만 보여주는 부분 JSON이며 전체 실행 입력은 [input.json](examples/input.json)에 있다.

```json
{
  "products": [{"id": "walmart-9", "model_item_nbr": "9"}],
  "model_input": {
    "dataset": "walmart-stormy-weather",
    "store_nbr": "4",
    "station_nbr": "9",
    "weather_strategy": "persistence",
    "weather_units": "walmart",
    "history_weather": [
      {"date": "2014-09-12", "tavg": 49.0, "tmax": 55.0, "tmin": 42.0, "preciptotal": 0.0, "avgspeed": 6.6}
    ]
  }
}
```

`as_of`는 판매와 과거 날씨가 확정되어 이용 가능한 마지막 날짜다. 원본에는 실제 공개 시각이 없어 시각 단위의 당시 이용 가능성은 검증하지 못했다.

- 판매는 상품별 마지막 연속 56일의 일별 정수 개수다. 관측된 0은 유효하고 누락·null·미확정 판매는 0으로 만들지 않는다. 미래 실제 판매/과거 날씨, 중복 행·음수·NaN 판매는 거절한다.
- dates는 D+1~D+7을 각각 한 번 포함하며 반환은 요청 상품·날짜 순서를 보존한다. time_idx는 **2012-01-01부터 지난 일수**, 요일은 월요일 0, 월은 1~12 문자열이다. 주말 지표와 sin/cos(2π×dayofyear/365.25)도 원본대로 만든다.
- weather_units=walmart: 기온 °F, 강수 inch/day, 평균풍속 mph. si: °C, mm/day, m/s → 각각 ×9/5+32, /25.4, /0.44704로 변환한다. 열 이름은 동일하다. tavg를 최고·최저의 평균으로 임의 대체하지 않는다.
- 기상 M/비수치/±Inf/날짜 누락은 결측이다. T는 0으로 해석하고 강수 T는 precip_trace=1을 보존한다. 다섯 _missing 지표를 먼저 만들고 동일 관측소에서 ffill한 뒤 남은 값에 **저장된 학습기간 중앙값**을 적용한다. 요청에서 새 통계를 fit하지 않는다. history_weather=[]는 전부 결측 표시+저장 중앙값을 쓰는 명시적 입력이다.
- 56일 첫날 결측을 정확히 복원하려면 그 이전 마지막 관측까지 보내야 한다. 이전 값이 없으면 저장 중앙값을 사용하며 원본의 전체 이력과 같다고 보장하지 않는다.
- 원본 학습은 희소 판매 패널에 ffill/초기 0 placeholder와 sales_observed를 사용했다. **서버는 인수 규약에 따라 56일 관측이 부족하면 insufficient_history**를 반환하는 더 엄격한 정책이다. 미래 7행 target 0은 데이터셋 형식용 placeholder이며 미확인 과거 판매나 반환 예측을 채우는 숫자가 아니다.
- 학습한 매장·상품 조합과 관측소를 저장 대응표로 검사한다. 신규 매장/상품·미등록 조합·상품 매핑 누락은 insufficient_history와 사유/빈 points다. 관측소 오대응은 오류다. 한국 매장·상품을 임의 Walmart ID에 연결하지 않는다. 새 그룹은 별도 오프라인 학습·평가 후 새 아티팩트로 등록해야 한다.

## 날씨와 웹 연결의 경계

이 체크포인트는 **과거 관측 + 마지막 값을 7일 유지하는 persistence**로 학습·평가했다. 원본 WeatherCollator대로 decoder 날씨·결측·trace 지표를 encoder 마지막 값으로 덮는다. 미래 weather.days의 예보·실제 관측은 사용하지 않는다. 실제 예보 입력이나 날씨 시나리오 효과를 검증했다고 표시하면 안 된다.

현재 API는 날씨 모델에 status=ok, mode=live_forecast를 요구하지만 샘플은 사실대로 historical_observations다. **현재 API에 그대로 연결하면 기존 gate에서 거절된다.** API 담당자가 과거 재현 경로와 출처 표시를 명시적으로 확장해야 한다. 과거 관측을 live_forecast로 이름만 바꾸지 않는다.

입력·실행 환경 경계가 준비되면 지정값은 `FORECAST_PROVIDER=ml.predict:predict`다. 이 설정만으로 연결이 완료되는 것은 아니다. Python 3.14 API 프로세스는 별도 Python 3.11 환경을 직접 불러올 수 없으므로 모델 프로세스 연결 또는 대상 환경 호환 검증은 API 담당 범위다. 예측에 재고·가격·원가·납기·발주 계산은 필요하지 않다.

## 출력, 허용 오차와 실행 시간

[expected-quantiles.json](examples/expected-quantiles.json)은 2상품×7일×5분위수 CPU float32 출력이다. 원본과 동일하게 **음수를 0으로 제한한 뒤 다섯 분위수를 정렬**하고 인덱스 0/2/4를 p10/p50/p90으로 선택한다. NaN/Inf는 오류다. 정렬은 원시 P50을 바꿀 수 있으며 통계적 재보정을 의미하지 않는다. 발주 단위 반올림은 하지 않는다.

비교식은 `abs(actual-expected) <= max(1e-4, 1e-5*max(abs(actual),abs(expected)))`다. 이는 **같은 CPU 경로**의 재현 기준이다. 기존 GPU 테스트 CSV와 샘플 70개 값의 최대 차이는 약 0.0235169로, GPU CSV를 이 허용 오차의 golden output으로 사용하지 않는다.

빈 환경에 고정 requirements를 설치하고 smoke test를 통과했다. [측정 기록](examples/cpu-verification.json): Ryzen 7 260, CPU 스레드 1, 2상품, import **24.63초**, 첫 모델 로드+추론 **0.72초**, 로드 후 요청 **0.12초**. 기존 환경에서는 각각 약 7.03/0.35/0.06초였다. 디스크 캐시와 초기 로딩 영향이 있으며 목표 서버의 응답시간 보장은 아니다.

[이력 부족 입력](examples/insufficient-history.json)과 [예상 결과](examples/expected-insufficient-history.json): walmart-9는 55/56일로 부족, walmart-27은 정상, new-product는 미등록이다. 정상 상품은 계속 예측한다.

unittest는 원본 특징 일치, SI/결측/trace, 학습·CUDA 차단, 상태 불변, 동시 요청, 상품·날짜 대응, 비정상 출력 거절을 검사한다. 전체 재학습·전체 테스트셋 CPU 재평가는 수행하지 않았다. 시간순 평가·기준선 수치·미검증 항목은 [evaluation.md](evaluation.md)를 따른다.

# TFT 평가 기록

이 문서는 기존 학습 실행 `walmart_20261024T020058Z`의 저장된 TFT 예측을 검산하고, 같은 관측 행에 현재 API 요일 기준선을 다시 계산한 기록이다. 전체 TFT 테스트를 재학습하거나 다시 추론한 결과는 아니다. CPU 샘플 재현 결과와 설치 환경은 `README.md`를 따른다.

## 근거와 평가 범위

- 원본 위치: 전달받은 `weather_order_tft/runs/walmart_20261024T020058Z/`.
- 실행 설정: [run_config.json](evaluation/run_config.json).
- 평가 수치: [test_metrics.csv](evaluation/test_metrics.csv), [metrics_by_horizon.csv](evaluation/metrics_by_horizon.csv).
- 개별 예측 검산: `validation_predictions.csv`, `test_predictions.csv`.
- 기준선 보정값: [baseline_validation_residual_quantiles.csv](evaluation/baseline_validation_residual_quantiles.csv).
- 학습 환경 기록: `environment_freeze.txt`.
- 모델 구조와 학습 기록: `tft_weather/logs/version_0/hparams.yaml`, `metrics.csv`.
- 원본 학습/전처리 코드: 사용자가 지정한 `startup_thon_1.ipynb`를 `ml/notebooks/startup_thon_1.ipynb`로 전달했다. cell 7, 8, 10, 13, 17, 21(0부터 세는 cell 번호)을 근거로 확인했다. 실행 출력이 남은 `Colab Notebooks/startup_thon.ipynb`와 학습 관련 코드가 같으며, 전달본은 source를 유지하고 출력과 실행 메타데이터만 제거했다.
- 최적 체크포인트: `best-epoch=02-val_loss=3.9847.ckpt`. 학습 로그에서 epoch 2의 `val_loss=3.9847028255462646`이 기록된 epoch 0~7 중 최솟값임을 확인했다. 최대 epoch 설정은 20이지만 실제 저장된 로그는 epoch 7까지다.

저장된 CSV로 MAE, RMSE, WAPE, 평균 pinball loss, 구간 포함률 및 구간 폭을 다시 계산했다. 원본 표와의 차이는 부동소수점 직렬화/집계 정밀도 수준이다(구간 폭까지 포함한 최대 절대 차이 약 `1.6e-6`). 저장된 예측의 수치적 일관성을 확인한 것이며, 전체 평가 데이터에 대해 체크포인트를 다시 실행한 검증은 아니다.

초기 CPU 인수 샘플인 매장 `4`, 상품 `9`와 `27`, 기준일 `2014-09-12`의 원본 테스트 CSV 70개 분위수와 CPU 예상 출력을 비교했을 때 최대 절대 차이는 `0.02351691894531882`였다. 이후 전달 샘플은 [demo-manifest.json](examples/demo-manifest.json)의 세 매장·10개 상품으로 확장했다. CPU smoke test의 작은 허용 오차는 CPU 기준값에 적용하며, 원본 GPU 평가 CSV와의 동일 오차 일치를 주장하지 않는다. 장치·연산 정밀도·배치 구성별 차이의 원인 분해는 미검증이다.

## 시간순 분할

`run_config.json`의 날짜는 다음과 같다. 무작위 분할이 아닌 시간순 경계이며, 평가 CSV의 실제 날짜 범위도 검증/테스트 경계와 일치한다.

| 구간 | 날짜(양 끝 포함) | 확인된 규모 |
| --- | --- | --- |
| 학습 | 2012-01-01 ~ 2014-07-11 | 설정상 143,620개 학습 window |
| 검증 | 2014-07-12 ~ 2014-09-05 | 56일, 990개 window, 6,930개 상품·일 예측 |
| 최종 테스트 | 2014-09-06 ~ 2014-10-31 | 56일, 1,139개 window, 7,973개 상품·일 예측 |

각 window는 최근 56일을 입력받고 다음 7일을 예측한다. 선택된 매장·상품 조합은 200개이며, 검증/테스트 CSV에 모두 200개 조합이 나타난다. 설정은 `MIN_NONZERO_DAYS=14`, `MAX_SERIES=200`, `SEED=42`이다. 노트북 cell 7은 학습 종료일 이하의 통계만으로 양수 판매일 14일 이상·판매 기록 63개 이상인 시계열을 남기고, 총 판매량 내림차순 상위 200개 조합을 고른다. 저판매량 상품과 이력이 짧은 상품 전체를 대표하는 평가가 아니다.

검증 예측 기준일은 2014-07-11부터 2014-08-29까지, 테스트 예측 기준일은 2014-09-05부터 2014-10-24까지 각각 7일 간격의 8개 날짜다. 노트북 cell 10의 `valid_windows`는 예측 대상 7일이 모두 실제 판매 관측(`sales_observed`)인 window만 남긴다. 모든 조합이 모든 기준일에 나타나지는 않으므로 각각 `200 × 8`개 window를 평가했다고 기재하면 안 된다.

평가는 기준일을 매주 옮기는 rolling-origin 방식이다. 뒤쪽 테스트 주차의 encoder에는 그 기준일까지 관측된 앞쪽 테스트 주차 판매량도 들어간다. 같은 체크포인트를 사용하며 테스트 구간에서 재학습하지 않는다. 테스트 시작일 한 번에 56일을 예측하는 평가와는 다르다.

두 예측 CSV에서 `time_idx = (date - 2012-01-01).days`가 모든 행에 일치함을 확인했다. 학습 구간의 시작일은 데이터 범위의 시작이며, 56일 문맥 확보 전부터 예측 window가 존재한다는 의미는 아니다.

## 현재 API 기준선과 동일 행 비교

[재계산 표](evaluation/api-comparison/metrics.csv)와 [입력/행 집합 manifest](evaluation/api-comparison/manifest.json)는 원본 테스트의 매장·상품·기준일·예측일을 그대로 맞춰 계산했다. API 기준선은 `apps/api/app/forecasting.py`의 실제 `percentile` 및 `baseline` 함수 본문을 실행한다. 함수를 다시 구현해 근사하지 않는다. 기준일까지의 최근 84일만 전달하며, 요일별 최소 4개 관측·선형 보간·소수 둘째 자리 반올림을 현재 API와 같게 적용한다. 미래 실제 판매량은 점수 계산에만 사용하고 기준선의 이력에는 들어가지 않는다.

두 모델에서 공통으로 제공하는 **P10/P50/P90 세 분위수**만 사용한다. 따라서 아래 `mean_pinball_3`는 뒤의 원본 5분위수 pinball 수치와 직접 비교하면 안 된다. MAE/WAPE는 P50 기준, 구간 포함률은 양 끝을 포함한 P10~P90 구간 기준이다.

| 평가 행 집합 | 모델 | 상품·일 행 / window | MAE | WAPE | 평균 pinball(3개) | 구간 포함률 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 원본 테스트 전체 | TFT persistence 후처리 | 7,973 / 1,139 | 5.522091 | 30.9444% | 1.792181 | 84.5855% |
| 원본 테스트 전체 | 현재 API 요일 기준선 | 7,973 / 1,139 | 5.936348 | 33.2657% | 1.959073 | 81.4374% |
| 최근 56일 전부 실제 관측 | TFT persistence 후처리 | 1,701 / 243 | 5.248639 | 32.6540% | 1.738628 | 85.0676% |
| 최근 56일 전부 실제 관측 | 현재 API 요일 기준선 | 1,701 / 243 | 5.878013 | 36.5696% | 1.892789 | 83.9506% |

전체 행에서 TFT의 MAE/WAPE는 현재 API 대비 **6.98%**, 공통 3분위수 pinball은 **8.52%** 작다. 최근 56일 전부 관측된 부분집합에서는 각각 **10.71%**, **8.14%** 작다. 원본 전체 지표와 현재 서버 추론의 입력 정책을 구분하기 위해 두 집합을 모두 제시했다. 현재 어댑터는 56일 중 하루라도 판매 관측이 없으면 `insufficient_history`를 반환하므로 원본 1,139개 window를 모두 현재 어댑터로 제공할 수 있다는 뜻은 아니다.

현재 API 기준선은 원본 테스트의 1,139개 window에서 모두 `ready`였다. 누락 판매일을 0으로 채우지 않았으며 원본 CSV의 모든 정답을 `train.csv.zip`의 실제 판매량과 대조했다. 날짜/상품이 달라지거나 추가적인 제외 조건을 적용한 지표를 같은 표에 섞지 않았다.

저장소 루트에서 다음 한 명령으로 작은 표와 manifest를 다시 만든다. Python 표준 라이브러리만 사용하며 큰 원본 CSV/ZIP은 Git 밖에 둔다.

```powershell
python -m ml.evaluate --predictions 'G:\내 드라이브\weather_order_tft\runs\walmart_20261024T020058Z\test_predictions.csv' --sales 'G:\내 드라이브\weather_order_tft\train.csv.zip'
```

다른 환경에서는 두 외부 파일 경로만 바꾼다. manifest에는 실제 입력 경로·SHA-256, 실행한 API 함수의 해시 및 전체/56일 집합의 행 키 해시를 기록한다. 같은 입력과 코드로 재생성한 결과 파일은 바이트 단위로 같아야 한다. 소스 경로가 달라지면 manifest의 경로 표기만 달라질 수 있다.

날씨 제거 모델의 예측 CSV가 준비되면 같은 명령에 `--no-weather-predictions PATH`를 추가한다. CSV는 `store_nbr,item_nbr,origin_date,date,actual,q10,q50,q90` 열을 포함하고 **원본 테스트와 모든 키 및 정답이 정확히 일치**해야 한다. 하나라도 다르면 비교를 중단한다. 현재는 파일이 전달되지 않아 manifest에 `not_supplied`로 표시했다. 이 옵션의 존재나 CSV 행 정렬 성공만으로 동일한 학습 조건의 날씨 제거 실험을 검증했다고 주장하지 않는다.

## 원본 seasonal naive 기준선 비교

아래 수치는 원본 `test_metrics.csv` 기준이다. MAE/RMSE는 중앙값(P50)과 실제 판매량을 비교한다. WAPE는 `sum(abs(actual - p50)) / sum(actual)`이며 아래 표에서는 백분율로 표시했다. 평균 pinball loss는 5개 분위수 `[0.10, 0.25, 0.50, 0.75, 0.90]`의 손실 평균이다. 구간 포함률은 `P10 <= actual <= P90`의 비율이고 구간 폭은 `P90 - P10`의 평균이다.

| 모델/처리 | MAE | RMSE | WAPE | 평균 pinball | P10~P90 포함률 | 평균 구간 폭 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TFT 원시 출력 | 5.5935 | 12.3737 | 31.3447% | 2.0072 | 78.3519% | 16.5639 |
| TFT 후처리 출력 | 5.5221 | 12.3701 | 30.9444% | 1.9733 | 84.5855% | 16.4480 |
| 주간 seasonal naive + 검증 잔차 보정 | 7.5637 | 16.8382 | 42.3847% | 3.2705 | 80.5218% | 16.0035 |

후처리 TFT의 상대 오차 감소율은 기준선 대비 MAE/WAPE 26.99%, RMSE 26.54%, 평균 pinball loss 39.66%다. 검증/테스트에 선택된 미국 Walmart 상품 집합에서의 결과이며 한국 매장·상품 성능을 입증하지 않는다.

비교 기준선은 CSV에 저장된 `seasonal_naive` 예측에 검증 잔차의 horizon별 분위수를 더하고 0 미만을 자른 방식이다. 저장된 보정값과 테스트 예측으로 위 기준선 지표를 재현했다. **26.99% 개선은 이 seasonal naive 기준선 대비 수치**다. 현재 API 대비 개선율은 앞의 동일 행 비교에 제시한 6.98% 또는 56일 부분집합의 10.71%이며 두 기준선을 혼용하지 않는다.

| 예측일 | 후처리 TFT MAE | WAPE | 평균 pinball | P10~P90 포함률 |
| --- | ---: | ---: | ---: | ---: |
| D+1 | 5.2532 | 25.7098% | 1.8917 | 84.8990% |
| D+2 | 6.4688 | 26.5387% | 2.3369 | 84.1089% |
| D+3 | 5.4888 | 30.3689% | 1.9782 | 83.4943% |
| D+4 | 5.1748 | 34.3679% | 1.8353 | 84.1967% |
| D+5 | 5.6061 | 35.5034% | 2.0174 | 85.2502% |
| D+6 | 4.8445 | 32.9723% | 1.7247 | 86.7428% |
| D+7 | 5.8184 | 35.2736% | 2.0289 | 83.4065% |

각 horizon의 표본 수는 1,139개다. 분위수별 `actual <= prediction` 비율은 후처리 기준 P10 52.49%, P25 59.24%, P50 70.94%, P75 82.93%, P90 91.58%다. 테스트 실제 판매량의 47.15%가 0이므로 이산값/동률의 영향이 크다. 80% 구간 포함률이 84.59%라는 결과만으로 각 분위수의 보정이 좋다고 결론내리지 않는다. 비영(非零) 수요 및 상품별 보정 분석은 미검증이다.

## 원시 분위수와 후처리

원본 분위수 순서는 `[q10, q25, q50, q75, q90]`다. 검증/테스트 CSV 모두 각 행의 후처리가 정확히 아래 연산과 일치했다.

```python
postprocessed = sorted(max(0.0, value) for value in raw_five_quantiles)
```

- 테스트 원시 분위수 역전: 2,906 / 7,973행, **36.4480%**.
- 테스트 원시 출력에 음수가 있는 행: 4,103 / 7,973행. 음수 개별 값은 15,009개.
- 검증 원시 분위수 역전: 2,103 / 6,930행, 30.3463%.
- 검증/테스트 원시 출력에는 NaN/무한대가 없었다.
- 정렬은 분위수 역전을 제거하고, 0 하한 처리는 판매량의 비음수 조건을 맞춘다. 이 과정은 원시 P50을 바꿀 수 있으므로 원시 성능과 후처리 성능을 구분한다. 정렬 후의 분위수를 이론적으로 다시 보정했다는 뜻은 아니다.

웹에는 후처리된 5개 값 중 인덱스 `0, 2, 4`를 `p10, p50, p90`으로 반환한다. `date` 외에 P25/P75나 `actual`을 point에 넣지 않는다. API의 실제 `Point` 스키마는 유한한 `[0, 1_000_000]` 범위 및 순서 조건을 검사하고 추가 필드를 거부한다. 이력 부족은 숫자를 만들지 않고 `status="insufficient_history", points=[]`로 전달한다.

## 미래 날씨: 확인된 근거와 미검증 항목

`run_config.json`에 `weather_training_mode="persistence"`, `future_weather_mode="persistence"`가 저장되어 있다. 노트북 cell 10의 `WeatherCollator`는 decoder의 모든 `WEATHER_FEATURES`를 해당 window encoder의 마지막 시점 값으로 교체한다. cell 13의 `batch_forecasts`도 이 persistence 경로를 사용한다. 미래 날짜의 관측값이 원본 panel에 있어도 이 경로에서는 모델에 전달되는 decoder 날씨가 기준일까지의 마지막 날씨값으로 덮어써진다. 결측 날씨는 cell 8에서 학습 구간 중앙값과 관측소별 과거 방향의 forward-fill을 사용하며, 결측 표시 특징도 포함한다.

따라서 이 평가의 날씨 조건은 **과거 관측 날씨 + 기준일 마지막 값의 지속 예측(persistence)**이다. 미래 실제 관측값을 decoder에 그대로 공급한 oracle 실험도, 당시 발급된 실제 예보를 공급한 평가도 아니다. 전달 자료에는 예보 발급시각별 아카이브가 없으며 실제 예보 입력의 성능은 **미검증**이다. 위 내용은 저장된 노트북 코드/실행 설정을 확인한 결과이며, 전체 학습·테스트의 재실행이나 모든 특징의 시간 누출을 별도로 감사한 결과는 아니다.

`RUN_NO_WEATHER_ABLATION=false`이므로 같은 TFT에서 날씨 특징만 제거한 대조 실험은 실행되지 않았다. 주간 기준선보다 성능이 좋다는 사실에서 날씨 특징의 기여도를 분리해 추정할 수 없다.

일반 API 경로는 `uses_weather=True` 모델에 대해 `weather.status="ok"` 및 `weather.mode="live_forecast"`를 요구한다. 별도의 허용된 Walmart 데모 경로는 고정된 과거 샘플을 `historical_persistence_demo`로 명시해 재생한다. 이 데모를 당시 발급 예보 또는 실제 한국 매장 성능으로 해석하지 않는다.

## 환경 및 일반화의 한계

10/50상품 성능 측정은 [benchmark-10.json](examples/benchmark-10.json)과 [benchmark-50.json](examples/benchmark-50.json)을 사용한다. 학습된 한 매장에 10/50개 상품이 없으므로 각각 **세 매장 3회 요청**, **열 매장 10회 요청**을 순차 처리하는 workload다. 단일 매장의 한 번 호출 성능으로 표현하지 않는다. 각 상품은 등록된 매장·상품 조합이고 직전 56일 관측이 모두 있다. 보고서에는 매장·상품 조합 수(`distinct_series`)와 매장 간 중복을 제외한 상품 번호 수(`distinct_skus`)를 구분한다.

`ops/verify-tft.sh`는 각각 새 Python 3.11 프로세스에서 import+최초 전체 요청의 cold 시간을 측정하고, 같은 프로세스의 모델을 재사용해 전체 요청을 3번 반복한 warm 시간/중앙값을 기록한다. 매번 예상 출력과 비교하며 프로세스 전체의 최고 RSS를 기록한다. Linux에서는 `getrusage(RUSAGE_SELF).ru_maxrss`를 바이트로 변환한다. 이 수치는 import와 모델 로드를 포함한 전체 프로세스의 최고 메모리이며 상품당 메모리나 추가 할당량이 아니다. 실제 서버 보고서 `benchmark-10.json`, `benchmark-50.json`이 나오기 전에는 로컬 Windows 수치를 ARM64 성능으로 표기하지 않는다.

로컬 Windows AMD64 / Python 3.11.0 / torch 2.11.0+cpu / CPU thread 1의 실제 측정은 다음과 같다. cold 시간은 Python 프로세스 생성 시간과 JSON 읽기를 제외한 모델 라이브러리 import부터 전체 요청 완료까지다. 각 warm 반복은 전체 workload를 한 번 처리하며, 3회 중앙값을 표시한다. 입력·예상 출력·체크포인트 SHA-256과 개별 반복값은 연결한 JSON에 기록했다. 하드웨어 간 속도나 동시 사용자 부하에 대한 보장은 아니다.

| 로컬 workload | 매장·상품 조합 / 서로 다른 SKU / 요청 | Cold(import 포함) | Warm 중앙값 | 최고 RSS(bytes) |
| --- | ---: | ---: | ---: | ---: |
| [10상품](evaluation/benchmarks/windows-10.json) | 10 / 10 / 3 | 8.338286초 | 0.211475초 | 415,375,360 |
| [50상품](evaluation/benchmarks/windows-50.json) | 50 / 29 / 10 | 10.243814초 | 0.955546초 | 411,811,840 |

최종 10상품 smoke와 Python 3.11 전체 `unittest discover -s ml/tests -v` 33개가 통과했다. 같은 환경에서 Python 3.14 API → Python 3.11 CPU worker의 기본 6상품 및 이력 부족 결과도 예상값과 일치했다. Ubuntu ARM64 실행 결과는 서버 검증 보고서가 생성되기 전까지 미검증이다.

모델 환경에서 개별 측정을 재현하는 명령은 다음과 같다(`TFT_CHECKPOINT_PATH` 설정 필요).

```bash
python -m ml.verify_runtime --benchmark-input ml/examples/benchmark-10.json --benchmark-expected ml/examples/benchmark-10-expected.json --report benchmark-10.json
python -m ml.verify_runtime --benchmark-input ml/examples/benchmark-50.json --benchmark-expected ml/examples/benchmark-50-expected.json --report benchmark-50.json
```

- 원본 설정상 학습 장치: NVIDIA A100-SXM4-80GB, `bf16-mixed`.
- 원본 패키지: torch `2.11.0+cu130`, pytorch-forecasting `1.5.0`, lightning/pytorch-lightning `2.5.5`, torchmetrics `1.7.4`, pandas `2.2.3`, numpy `2.1.3`, scikit-learn `1.6.1`.
- 원본 학습 Python은 **3.13.16**이다. 같은 실행 경로가 표시된 `Colab Notebooks/startup_thon.ipynb`의 cell 3 실행 출력에서 Python 버전과 torch/GPU/precision을 확인했다. 노트북 metadata의 `3.12` 및 마지막 안내의 synthetic 테스트 환경은 이 실제 학습 인터프리터 버전과 구분한다. 서버 CPU에서 검증한 Python 버전은 `README.md`를 따른다.
- 저장된 GPU 평가 숫자와 CPU float32 재현 숫자는 연산 정밀도에 따라 다를 수 있다. CPU 샘플 비교의 예상 출력과 허용 오차는 README 및 smoke test 기준을 따른다.
- 원본 노트북 끝부분에는 실제 A100 학습을 아직 수행하지 않았다는 초안 안내가 남아 있다. 저장된 실행 출력·체크포인트·실행 설정과 구분해야 하는 미갱신 안내이며, 이 평가표는 실제 저장된 결과 CSV와 실행 로그를 근거로 작성했다.
- 선택된 200개 미국 매장·상품 시계열 밖의 신규 매장/상품, 한국 날씨·상품 분포, 2026년 날짜 외삽, 실제 발급 예보 입력에 대한 성능은 미검증이다.
- 저장된 재고/발주 자료는 `inventory_source="DEMO_NOT_FOR_ORDERING"`이며 발주 정책 검증 근거로 사용하지 않는다. 본 전달 범위는 판매 수요 추론이다.

## 원본 결과 식별용 SHA-256

큰 원본 예측 CSV는 Git에 추가하지 않는다. 전달받은 원본 결과를 구분할 수 있도록 아래 해시를 기록한다.

| 파일 | SHA-256 |
| --- | --- |
| `run_config.json` | `3822e75ae049747177f09c8524ed2fb6558126ee3398a264ee1797d9a011bc7a` |
| `test_metrics.csv` | `d3e88328ce930f6d303a324bdfe866dbf8a9431ed524db35651360d1c5908993` |
| `test_predictions.csv` | `fcea87f0c38a7046d73f2b29091ae638b49d6e9f5cc2a1d35fbf415aadd534ef` |

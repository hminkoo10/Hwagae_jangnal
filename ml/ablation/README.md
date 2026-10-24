# 같은 조건의 날씨 제거 실험

`ml.train_ablation`은 원본 TFT와 **같은 선택 시계열 200개, 시간 분할, 56일 입력·7일 출력, 정답 누락 창 제거, 매주 평가 시점**을 사용해 날씨 없는 TFT를 새로 학습하는 오프라인 명령입니다. API나 요청 중에는 실행하지 않습니다. 기존 실행의 `RUN_NO_WEATHER_ABLATION=false`이므로 원본에는 날씨 없는 비교 모델이나 그 성능 수치가 없습니다.

비교 대상에서 제거하는 값은 기온 3개·강수·풍속과 각 결측 플래그 5개, `precip_trace`까지 11개입니다. 원본 노트북의 `build_datasets(False)`와 동일하게 매장·상품·관측소 식별자, 달력, 과거 판매량, 판매 관측 플래그는 유지합니다. 여기서의 비교는 **기상 값과 결측/미량강수 정보의 예측 기여**이며, 지역 정보까지 제거하거나 날씨의 인과효과를 추정하는 실험이 아닙니다.

전처리를 별도로 재작성하여 달라지는 일을 막기 위해 저장소의 원본 `notebooks/startup_thon_1.ipynb`에서 셀 7·8의 전처리와 셀 10·13의 지정 함수만 사용합니다. 패키지 설치·Drive 연결·원본 모델 학습·발주 셀은 실행하지 않습니다. 원본 노트북은 수정하지 않습니다.

## 입력과 실행

- `--data-dir`: 원본 `train.csv`, `weather.csv`, `key.csv` 또는 각각의 `.csv.zip`이 있는 폴더. 같은 이름의 압축/비압축 파일을 동시에 두지 않습니다.
- `--reference-run`: 기존 `walmart_20261024T020058Z` 결과 폴더. `run_config.json`, `selected_series.csv`, 검증·테스트 예측 CSV가 필요합니다.
- `--output-dir`: 저장소 **밖의 새 폴더**. 데이터셋 전처리 상태·체크포인트·로그·전체 예측은 Git에 넣지 않습니다.
- 기본 `--mode prepare`는 일치 검증과 전처리까지만 수행합니다. `benchmark`는 초기 3배치 후 지정 개수의 실제 학습 배치를 측정하고 가중치를 버립니다. `train`이 전체 학습입니다.

```sh
python -m ml.train_ablation --data-dir /data/weather_order_tft \
  --reference-run /data/weather_order_tft/runs/walmart_20261024T020058Z \
  --output-dir /data/ablation/prepare --mode prepare

python -m ml.train_ablation --data-dir /data/weather_order_tft \
  --reference-run /data/weather_order_tft/runs/walmart_20261024T020058Z \
  --output-dir /data/ablation/benchmark --mode benchmark --device cuda --batches 12

python -m ml.train_ablation --data-dir /data/weather_order_tft \
  --reference-run /data/weather_order_tft/runs/walmart_20261024T020058Z \
  --output-dir /data/ablation/no-weather --mode train --device cuda
```

모델 패키지는 기존 검증 버전과 같습니다. GPU 실행은 **별도 Python 3.11 환경**에 `requirements-inference.txt`의 CPU 인덱스를 공식 `https://download.pytorch.org/whl/cu130`, `torch==2.11.0+cpu`를 `torch==2.11.0+cu130`으로 바꾸어 설치합니다. 기존 CPU 추론 환경은 변경하지 않습니다. `--device cpu`도 가능하지만 원본 BF16과 다른 FP32 실행이므로 동일 정밀도 비교로 표시하지 않습니다.

`--variant weather`는 같은 새 환경에서 지속성 날씨 TFT를 다시 학습하는 선택적 비교 실험입니다. 기존 A100 모델과 새 하드웨어의 차이를 분리하려면 같은 환경의 날씨 포함/제외 쌍과 여러 seed가 더 유용합니다. 기본은 요청된 날씨 제거 모델입니다.

## 유지하는 학습 조건

| 항목 | 값 |
| --- | --- |
| seed | 42 |
| 학습 / 검증 / 테스트 종료 | 2014-07-11 / 2014-09-05 / 2014-10-31 |
| 학습 / 검증 / 테스트 창 | 143,620 / 990 / 1,139; 다르면 중단 |
| batch / 최대 epoch | 128 / 20 |
| hidden / continuous hidden / attention heads | 64 / 32 / 4 |
| dropout / LSTM layers | 0.15 / 1 |
| optimizer / learning rate | Adam / 0.001 |
| gradient clip / plateau patience | 0.5 / 3 |
| 체크포인트 / 조기 종료 | 검증 loss 최소 / patience 5 |
| 분위수 | 0.10 / 0.25 / 0.50 / 0.75 / 0.90 |
| 정밀도 | BF16 지원 CUDA에서 `bf16-mixed`; 평가는 FP32 |
| 후처리 | 0 미만 절단 후 5개 분위수 정렬 |

날씨 포함 비교 모델의 미래 기상 값은 예측 직전의 마지막 관측 특징을 반복합니다. 미래 실제 날씨나 당시 발급 예보를 새로 넣지 않습니다. 모델 선택에는 검증 구간만 사용하고 테스트 구간으로 학습하거나 조정하지 않습니다.

## 결과와 해석

완료 시 `completion.json`의 `trained_and_evaluated` 상태와 `matched_reference_rows=true`를 확인합니다. 준비 또는 벤치마크만 끝난 경우 성능 평가가 완료된 것으로 주장하지 않습니다.

- `protocol.json`: 원본 노트북·실행 스크립트 및 원본 CSV/ZIP·참조 설정·시계열·예측 CSV의 경로와 SHA-256, 패키지·하드웨어·정밀도·seed·창 개수와 비교 한계.
- `tft_no_weather/checkpoints/`: 해당 실행에서 검증 손실로 고른 체크포인트와 마지막 체크포인트.
- `tft_no_weather_validation_predictions.csv`, `tft_no_weather_test_predictions.csv`: 원본과 같은 키·정답·날짜·5개 raw/후처리 분위수.
- `metrics.csv`: 검증·테스트의 raw/후처리 MAE, RMSE, WAPE, 평균 pinball, 구간 포함률·너비, 분위수별 포함률.
- `*_metrics_by_horizon.csv`: 예측 일차별 동일 지표.

평가 전 매장·상품·예측 기준일·예측일·horizon 전체 키와 정답이 원본 CSV와 같은지 검사합니다. 일부 상품·날짜가 빠지거나 다른 정답을 비교하면 중단합니다. 기존 A100 결과와 로컬 RTX 5060 결과의 비교에는 하드웨어 및 Python 버전 차이가 남습니다. 단일 seed 결과만으로 일반적인 날씨 기여나 매출 증가를 단정하지 않습니다.

```sh
python -m unittest discover -s ml/tests -p test_train_ablation.py -v
```

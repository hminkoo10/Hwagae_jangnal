# 같은 환경의 3개 seed 쌍 비교

사전에 정한 학습 seed **42·43·44** 각각에서 날씨 포함 TFT와 날씨 제거 TFT를 비교한다. 시계열 선정은 원본 seed 42 설정과 저장된 200개 매장×상품 조합으로 고정한다. 학습 seed는 모델 초기화와 학습 난수에만 적용한다. 두 구조의 입력 차원과 난수 소비가 다르므로 같은 seed가 동일한 최적화 경로를 뜻하지는 않는다.

날씨 값·결측 표시·미량 강수 표시를 합친 11개 특징을 제거하면 입력 수와 모델 파라미터 수도 달라진다. 매장·상품·관측소 식별자와 달력 특징은 유지한다. 따라서 이 실험은 파라미터 수까지 맞춘 비교나 날씨의 인과 효과 검증이 아니다.

현재 실험의 계획은 [plan.json](plan.json)에 고정했다. 모든 실행은 Python 3.11.0 / RTX 5060 Laptop GPU / PyTorch 2.11.0+cu130 / BF16 환경을 사용하며, 원본 56일 입력·7일 출력, 시간 분할, batch 128, 최대 20 epoch, 검증 loss 기준 early stopping patience 5를 유지한다. 날씨는 **관측 이력과 decoder persistence**다. 실제 발급 예보의 효과를 평가하는 실험은 아니다.

기존 seed 42 날씨 제거 결과는 동일한 GPU·Python·패키지·정밀도·입력 해시·분할·학습 정책과 산출물 해시를 확인한 뒤 재사용한다. 이 결과는 이번 쌍 비교를 계획하기 전에 이미 알려져 있었다. 새 결과를 보고 seed를 골라 추가하거나 제외하지 않는다. 기존 A100 날씨 모델은 같은 환경의 3개 쌍에 포함하지 않는다.

재사용 근거의 한계도 남긴다. 과거 seed 42 실행 기록에 직접 저장된 패키지 버전은 torch·pytorch-forecasting·lightning·pandas·numpy·scikit-learn 6종이다. 그때 만든 CUDA 환경을 변경하지 않고 사용하며 현재 8종 검사는 원본 버전과 일치했지만, `pytorch-lightning`·`torchmetrics` 2종의 과거 실행 시점 버전은 해당 protocol에 따로 기록되지 않았다. 새 쌍 비교의 최초 실행은 시작 전 계획에, 이후 실행은 각 runtime 기록에 8종을 남긴다.

## 재실행

저장소 루트에서 CUDA 모델 전용 Python 환경으로 실행한다. `--output-dir`는 저장소 밖의 새 폴더여야 한다. GPU 작업은 한 번에 하나만 실행한다.

```sh
python -m ml.run_multiseed plan \
  --data-dir /data/weather_order_tft \
  --reference-run /data/weather_order_tft/runs/walmart_20261024T020058Z \
  --output-dir /data/tft-paired-seeds

python -m ml.run_multiseed run \
  --plan /data/tft-paired-seeds/experiment-plan.json

python -m ml.run_multiseed summarize \
  --plan /data/tft-paired-seeds/experiment-plan.json \
  --output-dir /data/tft-paired-seeds/summary
```

첫 명령에 `--reuse-no-weather-42 /data/matched-no-weather`를 추가하면 전달된 `completed-run.json`과 일치하는 기존 실행만 재사용한다. 자료가 없거나 환경/해시가 다르면 재사용 없이 6회를 새로 실행한다. 재사용 검사가 실패한 실행을 조용히 같은 조건으로 간주하지 않는다.

계획 단계에서 학습 코드와 원본 노트북을 외부 `frozen-source/`에 복사하고 해시를 기록한다. 학습은 이 고정본에서 실행한다. 각 작업 전 고정 코드와 입력 해시를 다시 검사하고, 완료된 실행은 seed·환경·정밀도·분할·입력·코드 검사를 거쳐 건너뛴다. 중간 실패로 남은 출력 폴더는 덮어쓰지 않는다. `status.json`과 실행별 로그에 활성 작업과 완료 상태를 남긴다.

2026-10-24 실제 실험은 `D:\tmp\codex-tft-ablation-20261024\multiseed-20261024`에서 실행한다. 최초 weather/seed42 실행도 고정 코드에서 시작했으며 이후 같은 계획의 순차 실행기가 완료 검증 후 이어간다. 기존 `matched-no-weather` 폴더와 원본 체크포인트를 변경하지 않는다. 큰 예측 CSV와 새 체크포인트는 외부 실험 폴더에 유지한다.

## 평가와 해석

6개 모델이 모두 학습·검증 선택·최종 예측을 마친 뒤 평가표를 집계한다. 새 날씨 포함/제거 예측 모두 원본 테스트의 상품·기준일·대상 날짜·실제 판매량이 같은지 검사한다. 원본 전체 **7,973행**과 최근 56일이 전부 실제 관측인 **1,701행**을 나눠 같은 행끼리 비교한다. 현재 API 요일 기준선도 같은 평가 코드와 행으로 계산한다.

작은 결과 파일은 다음 의미를 갖는다. 완료 전에는 결과를 만들어 넣지 않는다.

- `metrics.csv`: seed·모델·평가 집합별 MAE, WAPE, 공통 P10/P50/P90 pinball, 구간 포함률·폭.
- `api-baseline.csv`: 난수 seed가 없는 현재 API 기준선의 동일 행 지표.
- `paired-differences.csv`: seed별 **날씨 포함 − 제거** 차이. MAE/WAPE/pinball의 음수는 날씨 포함 모델의 오차가 더 작다는 뜻이다. 포함률 차이를 단독으로 개선이라고 부르지 않는다.
- `summary.csv`: 각 모델과 쌍별 차이의 평균·표본 표준편차(ddof=1)·최솟값·최댓값·seed 수. 일별 행 수로 seed 표본 수를 부풀리지 않는다.
- `manifest.json`: 계획·평가 코드·예측·체크포인트 해시, 동일 행 해시, 실행 환경과 비교 한계.

세 seed는 실행 변동을 살펴보는 작은 반복 실험이다. 평균 차이만으로 통계적 유의성이나 날씨의 인과 효과를 단정하지 않는다. 분위수 포함률의 명목 목표는 80%이지만 실제 0 판매·정수 동률·구간 폭도 함께 고려한다. 원본의 5분위수 평균 pinball과 이 표의 공통 3분위수 pinball을 혼용하지 않는다.

# 일반 매장용 실시간 예보 TFT — 디미고 매점 실데이터 학습

이 묶음은 **실제로 학습한 PyTorch Forecasting TemporalFusionTransformer**다. 디미고사회적협동조합 매점의 실제 POS 판매 중 앞 70% 기간(2025-10-01~2026-07-11, 판매일 223일)과 안산 와동 과거 재분석 날씨로 학습했다. 뒤 30% 기간(2026-07-12~2026-10-24)은 받지 않았고 학습·선택에 쓰지 않았다. 그 기간 평가는 웹/API 담당이 수행한다.

**원본 POS 자료는 비공개이며 저장소에 넣지 않는다.** `manifest.json`에는 입력 파일과 원본 xlsx의 SHA-256만 남긴다. 기존 Walmart 평가의 6.98%/10.71% 개선율은 이 모델에 적용되지 않는다.

## 입력과 출력

- `predict(context)` 호출은 기존 일반 매장 API context를 받는다. 예시는 `smoke.json`(합성 fixture, POS 자료 아님).
- 상품마다 `as_of`를 포함한 최근 연속 **56일**의 정수 판매 기록이 필요하다. 누락·null은 `insufficient_history`, 실제 기록된 0은 유효 관측이다.
- 예측 대상은 `as_of+1`부터 7일이며 날짜순 `weather.days`의 `temp_max`·`temp_min`·`rain_mm`를 사용한다. 단위는 °C/°C/mm.
- 응답은 상품별 `date,p10,p50,p90`, 모델 이름·버전·`uses_weather=true`·`training_data=dimigo_store`·설명이다. 이는 일별 **판매 개수 분위수**이며 발주량·품절 확률이 아니다.
- store/product ID, 상품 종류(category), 가격, 재고, `store_has_sales`, `est_stock_open`, 학사일정은 모델 입력에 들어가지 않는다. 처음 보는 매장·상품·종류도 같은 경로로 예측한다.

## 구현

TFT의 변수 선택망, LSTM encoder/decoder, gated residual network, multi-head attention을 그대로 사용한다. hidden 16, continuous hidden 8, attention head 1, LSTM 1층, dropout 0.1, float32 CPU이며 분위수는 `[0.1,0.25,0.5,0.75,0.9]`다.

- encoder: 판매(56일 평균, 최소 1로 나눔)·요일 sin/cos·기준일 상대 위치.
- decoder: 요일 sin/cos·상대 위치·**같은 7일 예보 평균 대비 최고/최저 기온 차이(÷10°C)**·강수(÷30mm).
- 정규화는 요청의 56일 판매와 7일 예보만으로 계산한다. 범주 인코더·매장 embedding·그룹 통계가 없고 추론 중 fit·재학습·다운로드는 하지 않는다.
- 출력은 0 미만 절단 후 5분위수를 정렬하고 같은 배율을 곱하며 API에는 0/2/4번째를 전달한다.

기온을 절대값이 아니라 주간 상대값으로 넣는 이유: 학습 자료가 한 학년도뿐이라 절대 기온이 계절·방학(추운 1~2월 = 휴무)을 대신 나타냈다. 절대 기온 모델은 검증에서 가장 나빴다. 따라서 7일 모두 같은 폭으로 따뜻하거나 추워지면 예측은 변하지 않는다. 연중 sin/cos도 학습 기간에 없던 7~9월을 외삽하므로 넣지 않았다.

## 학습 자료 해석

- 상품의 첫·마지막 판매일 사이에 판매 행이 없는 날은 0개, 그 밖의 날은 자료 없음으로 둔다.
- 학습 창: 상품별 연속 56+7일. 449개 상품 중 63일 이상 판매 기간이 있는 340개 상품에서 창을 만든다.
- 손실 가중치: 매장 휴무일(`store_has_sales=0`) 0.25, 추정 품절(`est_stock_open=0`이고 판매 0) 0, 나머지 1. 두 값은 가중치에만 쓰고 입력 특징으로 쓰지 않는다.
- decoder 날씨는 재분석 관측에 예보 오차 잡음을 더한다. 선행 1~7일: 기온 표준편차 1.0+0.2×선행일 °C, 강수 ×lognormal(0.5) + 표준편차 0.5+0.3×선행일 mm(0 이상). epoch마다 새로 뽑는다. 실제 발급 예보의 오차 분포를 학습한 것은 아니다.

## 검증 — 70% 기간 안에서만

시간순으로 나눴다. 학습 target은 2025-11-26~2026-05-29(48,251창), 검증 target은 2026-05-30~2026-07-11(9,416창, 65,912 상품·일)이다. 검증은 epoch와 설정 선택에만 사용했다. 같은 검증 행에서 API 요일 기준선(`apps/api/app/forecasting.py`의 `baseline`과 같은 백분위 계산)과 비교한다.

| 모델 | MAE(개) | 5분위 pinball | P10/P50/P90 pinball | P10~P90 포함률 | 구간 폭(개) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **TFT(제출)** | **1.195** | 0.426 | **0.386** | 0.894 | 4.25 |
| API 요일 기준선, 같은 56일 | 1.285 | – | 0.427 | 0.802 | 2.85 |
| API 요일 기준선, 최대 84일 | 1.265 | – | 0.417 | 0.807 | 3.04 |
| TFT 날씨 제거(같은 seed·코드) | 1.180 | 0.424 | 0.381 | 0.872 | 4.22 |

- TFT는 같은 56일 기준선 대비 MAE 7.0%, 84일 기준선 대비 5.5% 낮다. 휴무일·추정 품절 제외 부분집합에서도 순서는 같다(`manifest.json`의 `validation.metrics`).
- 구간은 명목 80%보다 넓다(포함률 0.894). 발주 계산에 P90을 쓰면 보수적으로 작동한다.
- **날씨 제거 모델이 이 검증 창에서 조금 더 좋았다.** 이 자료로는 날씨가 정확도를 높인다는 근거가 없다. 앱 계약상 날씨 사용 모델이 필요해 temp_max·temp_min·rain_mm를 모두 읽는 설정 중 최선을 골랐다. 강수만 쓰는 설정과의 차이는 0.13%로 잡음 범위다. 8개 설정의 결과는 `manifest.json`의 `setting_selection`에 있다.
- seed 한 번의 결과다. 학사일정을 넣지 않아 방학·휴무 시작은 예측하지 못한다. 다른 매장의 정확도는 검증하지 않았다.

## 재현과 신뢰 경계

저장된 `model.ckpt`는 tensor `state_dict`만 포함한다. 추론은 이 디렉터리의 고정 경로만 사용하고 SHA-256을 확인한 다음 `torch.load(weights_only=True)`로 읽는다. 구조·특징 순서·분위수도 manifest와 일치해야 한다.

제출 체크포인트는 Colab Pro A100에서 학습했다(torch 2.11.0+cu130, pytorch-forecasting 1.5.0, numpy 2.1.3, lightning 2.5.5). 검증 지표는 학습 후 CPU float32로 계산했다. 로컬 Windows Python 3.11 CPU(`ml/requirements-inference.txt`)에서 같은 체크포인트로 검증 지표를 다시 계산하면 상대 차이 1.1e-7 이내로 일치했다. 50개 상품 추론은 0.1초 미만이다.

레포 루트에서 실행한다. `--data-dir`는 받은 비공개 자료 폴더다. 출력 폴더는 새 폴더 또는 빈 폴더여야 한다.

```powershell
.model-venv\Scripts\python.exe -m ml.merchant_tft.train --data-dir <비공개 자료 폴더> --output-dir data/runtime/merchant-tft-reproduce --device cuda
.model-venv\Scripts\python.exe -m unittest ml.tests.test_merchant_tft -v
```

`--device cpu`(기본)로도 학습할 수 있다. 장비·스레드·CUDA 커널이 다르면 재학습 byte hash까지 같음을 보장하지 않는다. 추론 기준 출력 `expected-api.json`은 CPU에서 만들었고 `rtol=1e-5,atol=1e-4`로 비교한다.

`smoke.json`의 판매·예보는 학교 매점 모양(평일 많고 주말 적음)의 합성 fixture다. 워커 시작 검사에만 사용하며 실제 판매나 실제 예보로 표시하지 않는다.

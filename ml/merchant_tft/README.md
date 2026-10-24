# 일반 매장용 실시간 예보 TFT — 합성 학습 실험

이 묶음은 **실제로 학습한 PyTorch Forecasting TemporalFusionTransformer**다. Walmart 모델과 독립이며, 일반 매장 ID·상품 ID를 임의 Walmart 범주에 배정하지 않는다. 판매 기록과 현재 조회한 7일 예보를 넣어 웹·발주 흐름을 직접 시험하기 위한 모델이다.

**학습 자료는 전부 합성이다. 실매장 정확도·수요 증가·손실 절감을 검증한 모델이 아니다. 기존 Walmart 평가의 6.98%/10.71% 개선율은 이 모델에 적용되지 않는다.**

## 입력과 출력

- `predict(context)` 호출은 기존 일반 매장 API context를 받는다. 예시는 `smoke.json`.
- 상품마다 `as_of`를 포함한 최근 연속 **56일**의 정수 판매 기록이 필요하다. 누락·null은 `insufficient_history`, 실제 기록된 0은 유효 관측이다. 더 오래된 입력은 최근 56일 추론에 영향을 주지 않는다.
- 예측 대상은 `as_of+1`부터 7일이며, 날짜순 `weather.days`의 `temp_max`·`temp_min`·`rain_mm`를 사용한다. 단위는 °C/°C/mm. `live_forecast`와 `status=ok`만 허용한다. API가 예보 조회시각·캐시 신선도와 제공처를 검증하고 기록한다.
- 응답은 상품별 `date,p10,p50,p90`, 모델 이름·버전·`uses_weather=true`·`training_data=synthetic`·실험 안내다. 이는 일별 **판매 개수 분위수**이며 발주량·품절 확률이 아니다.
- 실제 판매 정답, 원가·재고·발주량, store/product ID는 학습 특징과 추론 tensor에 들어가지 않는다.

## 구현

TFT의 변수 선택망, LSTM encoder/decoder, gated residual network, multi-head attention을 그대로 사용한다. hidden 16, continuous hidden 8, attention head 1, LSTM 1층, float32 CPU이며 분위수는 `[0.1,0.25,0.5,0.75,0.9]`다.

입력 tensor를 명시적으로 구성하므로 범주 인코더·매장 embedding·그룹별 통계가 없다. 과거 판매는 그 56일 평균(최소 1)으로 나누고 출력에 같은 배율을 곱한다. 날짜는 요일·연중 sin/cos와 기준일 상대 위치만 사용한다. 기온·강수는 고정 물리 단위 배율로 변환한다. 추론 중 fit·재학습·다운로드는 하지 않는다.

encoder는 판매·달력만, decoder는 달력·미래 예보만 읽는다. 미래 target이나 미래 실측 날씨를 encoder에 넣지 않는다. 출력은 0 미만 절단 후 5분위수를 정렬하며 API에는 0/2/4번째를 전달한다. 전체 0 관측에도 TFT를 실행하며 별도 규칙을 모델 예측으로 가장하지 않는다.

## 합성 학습 가정과 한계

`train.py`는 독립된 56+7일 window를 생성한다. 판매 규모·요일·날씨·관측 잡음을 바꾸고 일부 0 판매 시계열도 포함한다. 합성 판매 생성에는 **20°C 대비 기온 1°C당 +0.022, 강수 1mm당 -0.012의 배율 효과**를 가정했다. 업종마다 같은 효과가 있다는 실증 근거가 아니다.

판매 target은 합성 실제 날씨로 만들고, decoder에는 기온 표준편차 1.5°C·강수 2mm의 별도 예보 오차를 추가한다. 실제 기상 제공처의 예보 오차 분포를 학습한 것은 아니다. 이 가정으로 학습했으므로 날씨를 바꾸면 예측이 반응하는 기술 시연은 가능하나 실세계의 인과 효과를 증명하지 않는다.

학습 seed와 검증 seed를 분리했다. 독립 합성 window 검증으로 epoch를 선택했으며, 실제 날짜에 따른 실매장 백테스트나 최종 untouched test는 없다. `manifest.json`의 `synthetic_validation`은 합성 검증 자료에만 해당한다. 팀원의 후속 실데이터 학습·발급 예보 보관·시간 분할 검증으로 교체해야 한다.

## 재현과 신뢰 경계

저장된 `model.ckpt`는 모델 클래스가 아니라 tensor `state_dict`만 포함한다. 추론은 고정된 이 디렉터리 경로만 사용하고 SHA-256을 확인한 다음 `torch.load(weights_only=True)`로 읽는다. 구조·특징 순서·분위수도 manifest와 일치해야 한다. 사용자 업로드 체크포인트는 받지 않는다.

레포 루트에서 기존 Python 3.11 모델 가상환경으로 실행한다. 출력 폴더는 새 폴더 또는 비어 있는 폴더여야 한다.

```powershell
.model-venv\Scripts\python.exe -m ml.merchant_tft.train --output-dir data/runtime/merchant-tft-reproduce --epochs 32 --train-windows 1536 --validation-windows 192 --batch-size 64 --threads 2
.model-venv\Scripts\python.exe -m unittest ml.tests.test_merchant_tft -v
```

학습 과정·seed·패키지 버전·정규화·아티팩트 해시는 `manifest.json`, epoch 로그는 `training-log.json`, CPU 기준 출력은 `expected-api.json`에 남긴다. 장비·패키지가 달라지면 재학습 byte hash까지 동일함을 보장하지 않는다. 추론 기준 출력은 `rtol=1e-5,atol=1e-4`로 비교한다.

`smoke.json`의 예보는 합성 fixture다. 워커 시작 검사에만 사용하며 현재 실제 예보로 표시하지 않는다. 웹 요청에서는 API가 받은 실제 예보가 이 입력을 대체한다.

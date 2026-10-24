# 발표 자료와 평가 근거

이 폴더는 발표자가 **기존 Walmart TFT**의 동작·검증 범위·한계를 같은 기준으로 설명하기 위한 자료다. **원본 A100 모델의 API 대비 평가**와 **완료된 로컬 동일 환경 3개 seed의 날씨 포함/제거 비교**를 구분한다. 두 평가 모두 Walmart 자료를 대상으로 한다. 웹/API 구현과 서버 재검증은 이 자료의 범위 밖이다.

main에 추가된 [일반 매장용 `merchant_tft`](../merchant_tft/README.md)는 합성 자료로 학습하고 실제 예보 입력을 받는 별도 모델이다. **6.98%·10.71%와 이번 Walmart 3개 seed 실험 결과는 이 모델의 성능 수치가 아니다.** 합성 모델의 실매장 정확도·실제 예보 효과는 미검증이며, 해당 모델의 구현·평가는 이번 PR 범위 밖이다.

| 자료 | 용도 |
| --- | --- |
| [모델 설명](model-explainer.md) | 60~90초 대본, 입력→추론→출력 흐름, TFT 선택 이유, 조건을 붙인 숫자 문구 |
| [심사 질문 답변](judge-qa.md) | 기준선·날씨 효과·분위수·누출·실패·신규 상품·CPU·발주 질문의 짧은 답과 코드 근거 |
| [대표 사례](cases.md) | 과거 56일 통계로 선정한 일반·변동·0판매 사례와 7일 예측 |
| [실패 사례](failure-cases.md) | 테스트 오차가 큰 창을 결과 기준으로 고른 진단 자료와 선정 한계 |
| 반복 실험 그래프: [PNG](figures/multiseed.png) · [SVG](figures/multiseed.svg) | 완료된 3개 seed의 날씨 포함/제거 비교를 발표에 사용할 이미지 |
| [전체 평가 설명](../evaluation.md) | 분할·행 집합·지표 정의·과거 GPU 평가와 CPU 재현의 차이 |

## 숫자를 가져올 때 붙일 조건

| 발표 숫자 | 반드시 붙일 조건 |
| --- | --- |
| 기존 Walmart TFT의 API 대비 MAE **6.98% 감소** | 미국 Walmart 2012~2014년 자료에서 학습 구간으로 선택한 200개 매장·상품 조합, 테스트 7,973행, 2014-09-06~10-31 |
| 기존 Walmart TFT의 API 대비 MAE **10.71% 감소** | 직전 56일 관측이 모두 있는 부분집합만: 55개 조합·243개 창·1,701행. 전체 결과와 함께 제시 |
| P10~P90 포함률 **84.59%** | 전체 테스트, 양 끝 포함, 실제 판매 0 비율 47.15%. 완전한 분위수 보정의 증거가 아님 |
| 기존 단일 실행의 날씨 제거 대비 MAE **2.91% 감소** | 환경이 다른 과거 참고값. 아래 동일 환경 3개 seed 결과와 구분. A100/Python 3.13.16과 RTX 5060/Python 3.11.0 차이가 있음 |
| 10상품 반복 추론 **0.21초** | 로컬 Windows CPU thread 1, 3매장 요청의 순차 합계·모델 재사용·3회 중앙값. 서버/네트워크/동시 사용자 부하 수치가 아님 |

기존 Walmart 평가의 공통 조건은 TFT 이력 56일, 실제 API 기준선 이력 84일, 매주 기준일을 옮기는 7일 예측, 과거 관측+미래 persistence다. 5개 분위수의 음수를 0으로 제한하고 정렬한 뒤 평가하며 API에는 인덱스 0·2·4를 반환한다. 6.98%와 10.71%는 **MAE 상대 감소율**이며 “정확도”나 “%p 개선”으로 바꾸지 않는다. 원본 seasonal naive 대비 26.99%도 현재 API 대비 수치와 혼용하지 않는다.

## 완료된 동일 환경 반복 실험

**6개 모델의 학습·평가와 동일 행 검증을 완료했다.** RTX 5060 Laptop / Python 3.11.0 / BF16 환경에서 Walmart 자료의 seed 42·43·44를 날씨 포함/제거 쌍으로 비교했다. 기존 날씨 제거 seed 42를 검증 후 재사용하고 나머지 5개를 새로 학습했다. 원본 A100 모델의 6.98%·10.71%를 이 결과로 바꾸거나 합치지 않는다.

| 평가 집합 | 날씨 포함 MAE, 평균 ± 표본 SD | 날씨 제거 MAE, 평균 ± 표본 SD | 날씨 포함 MAE가 낮은 seed |
| --- | ---: | ---: | --- |
| 전체 7,973행 | 5.564618 ± 0.098015 | 5.644910 ± 0.085865 | 3/3 |
| 56일 완전 관측 1,701행 | 5.308967 ± 0.108076 | 5.468168 ± 0.176456 | 2/3 |

평균의 상대 MAE 감소율은 날씨 제거 대비 전체 **1.42%**, 부분집합 **2.91%**다. 이는 seed별 상대 감소율의 평균이 아니라 `(제거 MAE 평균−포함 MAE 평균)/제거 MAE 평균`이다. **seed 44의 부분집합에서는 반대로 5.264554 → 5.409213으로 MAE가 2.75% 커졌다.** SD는 세 학습 seed 사이의 표본 표준편차이며 신뢰구간이 아니다. [개별 지표](../ablation/multiseed/metrics.csv), [쌍별 차이](../ablation/multiseed/paired-differences.csv), [평균·SD](../ablation/multiseed/summary.csv), [실행·정렬 근거](../ablation/multiseed/manifest.json)

세 seed로 유의성이나 날씨의 인과 효과를 확정하지 않는다. 11개 날씨 값·결측/trace 특징을 제거하면 입력과 파라미터 수도 달라지며 관측소·달력은 유지한다. 재사용한 seed 42 결과를 이미 알고 계획한 확장이고, 그 과거 protocol은 패키지 6종만 직접 기록했다. `pytorch-lightning`·`torchmetrics` 2종은 당시 별도 기록이 없고 변경하지 않은 현재 환경에서 확인했다. 상세 조건은 [반복 실험 안내](../ablation/multiseed/README.md)를 따른다.

기존 [평가 ZIP](../evaluation/tft-evaluation-data.zip)과 [기준표](../evaluation/api-comparison/metrics.csv)는 기존 Walmart 단일 실행 비교용이다. 완료된 3개 seed의 전체 예측 자료나 `merchant_tft`의 평가·CPU 검증을 포함한다고 설명하지 않는다.

## 근거를 확인하는 순서

1. [평가표](../evaluation/api-comparison/metrics.csv)와 [행 집합·입력 해시](../evaluation/api-comparison/manifest.json)에서 같은 대상을 비교했는지 확인한다.
2. [평가 코드](../evaluate.py)와 [실제 API 기준선](../../apps/api/app/forecasting.py)에서 기준일까지의 이력과 지표 계산을 확인한다.
3. [원본 노트북](../notebooks/startup_thon_1.ipynb), [실행 설정](../evaluation/run_config.json), [기존 날씨 제거 완료 기록](../ablation/completed-run.json)에서 모델과 학습 조건을 확인한다.
4. [추론](../predict.py), [전처리](../preprocess.py), [샘플 안내](../examples/README.md)에서 입력·0판매·이력 부족·신규 그룹 처리와 후처리를 확인한다.
5. [ML 실행 안내](../README.md)의 명령으로 CPU 샘플을 재현한다. 원본 단일 실행 비교와 새 반복 실험의 저장 평가표는 아래의 서로 다른 ZIP으로 재생성한다.

**기존 단일 실행 비교:** 저장소에 있는 `tft-evaluation-data.zip`은 원본 TFT·기존 날씨 제거 TFT·API 기준선의 세 모델×두 집합, 총 6행을 재현한다.

```bash
python -m zipfile -e ml/evaluation/tft-evaluation-data.zip data/runtime/tft-evaluation
python data/runtime/tft-evaluation/evaluation-data/reproduce.py
```

**완료된 3개 seed 비교:** 별도로 전달하는 `tft-multiseed-evaluation-data.zip`은 6개 모델 실행의 저장 예측과 4개 기준 CSV를 담는다. 이 추가 ZIP은 Git 밖에 있으며 [파일 크기·SHA-256·검증 기록](../ablation/multiseed/external-data.json)을 저장소에 남겼다. 전달 파일 경로를 실제 위치로 바꾸어 압축을 풀고, 두 번째 한 명령으로 재생성한다.

```bash
python -m zipfile -e /path/to/tft-multiseed-evaluation-data.zip data/runtime/tft-multiseed
python data/runtime/tft-multiseed/reproduce.py --repo data/runtime/tft-multiseed/source
```

모델·수치 패키지가 없는 새 Python 3.11 환경에서 입력 해시 검사, 3개 쌍의 전체 7,973행·부분집합 1,701행 비교를 통과했다. `metrics.csv`는 6개 실행×두 집합의 12행이며, `api-baseline.csv`·`paired-differences.csv`·`summary.csv`까지 4개 CSV가 저장 기준표와 바이트 단위로 같았다. 지표 비교 허용 오차는 절대·상대 각각 `1e-12`다. 두 ZIP 모두 체크포인트를 포함하지 않으며 저장 예측의 평가 재계산용이다. 재학습·새 모델 CPU 추론·`merchant_tft` 검증과 구분한다. [반복 실험 안내](../ablation/multiseed/README.md)

대표 사례 그래프는 기존 Walmart 모델의 개별 결과 설명용이다. 전체 성능은 전체 평가표로, 실패 가능성은 결과 기준으로 선정했다고 밝힌 실패 사례로 설명한다. 익명 Walmart 상품에 한국 상품명·실제 가격·재고 등을 임의로 대응시키지 않는다. 타깃은 관측 판매 개수이며 재고·품절·프로모션 기록이 없어 무제한 잠재 수요와 구분할 수 없다. 일별 P50 합계를 주간 중앙값이라고 부르지 않는다. Walmart 모델의 실제 예보 지원과 발주량 계산은 각각 별도 검증·구현 범위다.

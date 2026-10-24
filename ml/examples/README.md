# 실제 Walmart 판매 표본과 CPU 재현

이 묶음은 **서로 다른 상품 번호 10종, 매장·상품 시계열 10개**의 실제 관측 입력을 제공합니다. 학습 대상은 매장당 최대 6개 상품이므로 매장을 합치지 않고 세 요청으로 나눕니다. 한국 매장·상품에 Walmart 식별자를 부여하지 않습니다.

| 원본 매장 / 관측소 | 익명 원본 상품 번호 | 입력 / 5분위수 예상 / API 예상 |
| --- | --- | --- |
| 4 / 9 | 9, 27, 90, 93, 96, 97 | `input-store-4.json` / `expected-quantiles-store-4.json` / `expected-api-store-4.json` |
| 24 / 9 | 6, 43, 60 | `input-store-24.json` / `expected-quantiles-store-24.json` / `expected-api-store-24.json` |
| 17 / 20 | 37 | `input-store-17.json` / `expected-quantiles-store-17.json` / `expected-api-store-17.json` |

`demo-manifest.json`이 파일명·정확한 매장/관측소 번호·상품 수를 연결합니다. 정상 입력은 모두 `2014-09-12` 기준이며, `2014-07-19`~`2014-09-12`의 **연속 56일 실제 판매 관측**을 포함합니다. 합계 560행입니다. 예측 날짜는 `2014-09-13`~`2014-09-19`입니다.

기존 웹 체험이 읽는 `input.json`, `expected-api.json`, `expected-quantiles.json`은 main의 매장 4·상품 9와 27 두 상품 파일을 바이트 그대로 보존합니다. SHA-256은 `provenance.json`의 `legacy_sample`에 있습니다. 10상품 smoke는 이 레거시 파일 대신 위의 매장별 파일을 사용합니다.

`actuals.json`의 기준일 이후 실제 판매 70행은 비교 자료로만 별도 전달합니다. 모델 입력에 넣지 않습니다. 각 입력의 판매·날씨 날짜가 기준일 이하라는 검증을 수행합니다. 노트북의 예측 대상 시점 이후 관측을 재현 입력으로 전달하지 않습니다.

## 실행과 비교

설치·체크포인트 경로 설정은 [상위 README](../README.md)를 따릅니다. 저장된 체크포인트만 사용하고 재학습·fit하지 않습니다.

```console
python -m ml.smoke_test
```

기본 실행은 manifest의 세 요청을 모두 처리하여 **10상품 × 7일 × 5분위수**와 API용 3분위수를 비교합니다. 허용 오차는 `math.isclose(rel_tol=1e-5, abs_tol=1e-4)`입니다. 즉 `|실행값-기준값| <= max(1e-4, 1e-5 × max(|실행값|, |기준값|))`이어야 합니다.

검증용 5분위수 순서는 `[0.10, 0.25, 0.50, 0.75, 0.90]`입니다. 모델 출력을 0 이상으로 자른 뒤 다섯 값을 정렬하는 원본 후처리를 적용했습니다. API용 `predict()`의 일별 필드는 `date`, `p10`, `p50`, `p90`뿐입니다. 각 값은 다섯 값의 0·2·4번째입니다.

`cpu-verification.json`은 이 환경에서 세 요청 전체를 실행한 실제 측정 결과입니다. 서버 성능과 동일한 수치로 간주하지 않습니다.

## 입력과 날씨 출처

원본은 Walmart Recruiting II: Sales in Stormy Weather의 `train.csv`, `weather.csv`, `key.csv`이며 학습 실행은 `walmart_20261024T020058Z`입니다. 체크포인트의 `selected_series.csv`에 등록된 실제 매장·상품·관측소 조합만 사용합니다. 원본의 관측된 0은 유지하지만 없는 판매일을 임의로 0으로 채우지 않습니다. 상품명은 익명 번호를 설명하는 이름입니다.

날씨는 관측소별 과거 관측입니다. 56일 이전의 특징별 마지막 유효 관측 날짜를 prefix에 포함하여, 원본 전체 관측소 이력을 전처리한 결과와 56일 특징이 정확히 같은지 생성 시 검증합니다. 원문 `M`과 `T`는 보존합니다. `M`은 결측, `T`는 원본 강수 trace이며 수치는 0, `precip_trace=1`로 처리합니다. 결측 플래그를 먼저 만들고 과거 값으로 전방 채움한 뒤 저장된 학습 중앙값을 사용합니다.

미래 날씨는 학습 때와 동일한 `persistence`입니다. 처리된 기준일 날씨와 결측/trace 플래그를 7일 반복하며, 당시 발급된 일기예보나 기준일 이후 실제 관측을 사용하지 않습니다. 입력의 `weather.mode="historical_observations"`, `fetched_at=null`은 원본의 성격과 알 수 없는 수집 시각을 그대로 표시합니다.

현재 API에 필요한 필드 이름·단위·예시는 [input-fields.json](input-fields.json)에 있습니다. `model_input.store_nbr`, `station_nbr`, 상품별 `model_item_nbr`와 과거 날씨가 필요합니다. 파생 달력·`time_idx`·결측 플래그는 전처리가 계산합니다.

| 입력 특징 | `weather_units="walmart"` | `weather_units="si"` |
| --- | --- | --- |
| `tavg`, `tmax`, `tmin` | °F | °C |
| `preciptotal` | inch/day | mm/day |
| `avgspeed` | mph | m/s |
| `sales[].units_sold` | 일별 판매 개수, 정수 | 동일 |

SI에서도 열 이름은 같습니다. 변환은 `°F=°C×9/5+32`, `inch=mm/25.4`, `mph=(m/s)/0.44704`입니다. 평균 기온을 최고/최저의 평균으로 추측하거나 평균 풍속에 돌풍을 넣지 않습니다. 관측되지 않은 값은 null로 표시합니다.

## 이력 부족

`insufficient-history.json`은 매장 4의 정상 입력에서 `walmart-9`의 `2014-08-01` 판매일을 제거하고 매핑 없는 `new-product`를 추가했습니다. 두 상품은 `insufficient_history`와 빈 `points`를 반환하고, 나머지 다섯 등록 상품은 정상 예측합니다. 결과는 `expected-insufficient-history.json`으로 비교합니다.

새 매장·상품은 학습된 대응이 없으면 56일 이력이 있어도 임의 예측을 생성하지 않습니다. 실제 데이터로 새 모델·인코더를 별도로 학습·평가한 뒤 등록해야 합니다. 원본 노트북 평가의 희소 패널과 달리 서버는 최근 56일 판매 관측을 모두 요구합니다. 이 표본은 그 요건을 실제로 만족하는 시계열을 골랐습니다.

## 10개·50개 성능 벤치마크

`benchmark-10.json`은 위 10상품의 **세 매장 순차 요청**입니다. `benchmark-50.json`은 `2014-10-17` 기준 **10개 매장에 속한 서로 다른 학습된 매장·상품 시계열 50개**의 순차 요청입니다. 50개 입력도 각 시계열의 연속 56일을 원본에서 가져왔고 중복 시계열이나 복제 상품 ID는 없습니다. 같은 원본 상품 번호가 서로 다른 매장에 등장할 수 있으므로 50개의 서로 다른 상품 번호라는 뜻은 아닙니다.

두 파일 형식은 `{schema_version, description, contexts:[...]}`이며 `contexts`의 순서대로 독립 호출합니다. `benchmark-10-expected.json`, `benchmark-50-expected.json`의 `results`는 같은 순서의 CPU API 예상 결과입니다. 50개 표본은 처리량 측정 자료이며 새 정확도 평가 결과가 아닙니다. 한 매장 또는 한 배치의 50상품 성능으로 표시하면 안 됩니다.

## 원본에서 다시 만들기

원본 ZIP은 Git에 넣지 않았습니다. 로컬 경로·ZIP SHA-256·샘플 정책은 [provenance.json](provenance.json)에 기록했습니다. 정확히 같은 원본인지 확인한 뒤 다음 명령으로 입력과 예상 출력을 다시 만들 수 있습니다.

```console
python -m ml.build_samples --data-dir "G:\내 드라이브\weather_order_tft" --checkpoint "기존 체크포인트 경로" --write-expected
```

`--write-expected`를 생략하면 확장 표본의 원본 입력만 재생성합니다. 레거시 2상품 세 파일은 해시를 확인한 뒤 유지하며, 별도 `--output-dir`에도 그대로 복사합니다. `--write-expected`도 이 레거시 기준 출력을 변경하지 않습니다. 이 생성 명령은 학습하지 않으며, 일반 smoke test는 기준 출력을 덮어쓰지 않습니다. 모델 비교는 예측 결과를 생성한 코드와 독립적으로 커밋된 기준 출력에 대조합니다.

# Colab 담당자 모델 연결 규약

웹·API 담당은 `apps/`, 모델 담당은 `ml/` 중심으로 작업합니다.
현재 기본 예측은 `apps/api/app/forecasting.py`의 **날씨를 사용하지 않는 요일 기준선**입니다.
실제 ML·공개 자료 검증은 아직 없으며, 팀원 결과를 다음 규약으로 교체합니다.

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

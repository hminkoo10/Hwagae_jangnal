# 화개장날 · Hwagae Jangnal

날씨를 반영한 딥러닝(TFT)으로 소상공인 매장의 7일 판매를 예측하고, 재고와 발주까지 안내하는 서비스입니다.

- 웹: https://hwagae.milky.kr
- 점주·직원용 웹과 Android·iOS 앱, 서비스 운영자용 관리자 페이지(`/admin`)

## 주요 기능

- **판매 예측**: 상품별로 최근 56일 판매와 매장 위치의 7일 날씨 예보를 넣어 다음 7일 판매량을 P10·P50·P90 범위로 예측합니다. 과거 날짜를 고르면 실제 판매와 비교할 수 있습니다.
- **재고·발주**: 유통기한별 재고와 입고 예정을 입력하면 예측 범위, 납기, 발주 주기, 원가를 반영해 발주량을 계산합니다. 수량을 고쳐 저장하고, 확정한 발주서는 CSV·Excel로 내보냅니다.
- **자료 입력**: 상품·판매·재고를 담은 Excel로 시작하고, 이후 판매는 파일이나 직접 입력으로 추가합니다.
- **AI 도우미**: 예측과 날씨를 근거로 판매 흐름과 발주 이유를 설명하고, 메모로 판매 기록이나 상품 정보를 채웁니다. AI 연결은 서비스 운영자가 모든 매장에 공통으로 설정합니다.
- **계정과 권한**: 서비스 운영자가 점주와 계약하고 초대 링크를 보냅니다. 점주는 여러 매장을 운영하고, 직원을 초대해 메뉴별 권한을 줄 수 있습니다.

## 구조

```text
apps/
  api/      FastAPI · SQLite (Python 3.14)
  web/      Next.js 16 · React 19 · TypeScript
  mobile/   Capacitor Android · iOS 앱 (웹을 정적 빌드해 포함)
ml/
  merchant_tft/  일반 매장용 TFT (추론 코드, 체크포인트, 학습 스크립트)
  ...            Walmart 자료로 학습한 TFT와 평가 코드
ops/        Ubuntu 배포 스크립트, systemd·Nginx 설정, TFT 워커
scripts/    로컬 설정, 모바일 빌드·아이콘 생성, 시연 자료 생성
docs/       운영·모델·배포 문서
```

API는 Python 3.14 환경에서 실행하고, TFT는 별도 Python 3.11 프로세스(`ops/tft_worker.py`)에서 CPU로 추론합니다. 예측 모델은 [docs/model.md](docs/model.md)를 참고하세요.

## 로컬 실행

필요한 도구: Node.js 24, uv 0.10 이상. Python 3.14는 `uv`가 설치합니다.

```bash
npm ci
npm run setup:env
uv sync --locked
```

`setup:env`는 `apps/api/.env`와 `apps/web/.env.local`이 없을 때만 예시 파일에서 만듭니다.

TFT 예측을 쓰려면 모델 전용 Python 3.11 환경을 만듭니다.

```bash
uv venv --no-project --python 3.11 .model-venv
uv pip install --python .model-venv/bin/python --index-strategy unsafe-best-match -r ml/requirements-inference.txt
```

Windows에서는 `.model-venv/Scripts/python.exe`를 사용합니다.

두 터미널에서 실행합니다.

```bash
npm run dev       # 웹 http://127.0.0.1:3000
npm run dev:api   # API http://127.0.0.1:8000 (문서: /docs)
```

로컬에서는 **점주 체험**·**직원 체험** 버튼으로 시험 계정에 로그인할 수 있습니다.

## 검사

```bash
npm run check       # 웹 타입 검사
npm run build       # 웹 빌드
npm run test:api    # API 테스트
npm run mobile:check
.model-venv/bin/python -m unittest discover -s ml/tests -p test_merchant_tft.py
```

GitHub Actions가 PR마다 API·웹·ML 검사와 Android·iOS 빌드를 실행하고, `main`에 병합되면 서버에 배포합니다. 자세한 내용은 [docs/deployment.md](docs/deployment.md)를 참고하세요.

## 문서

- [운영 안내](docs/operations.md): 운영자·점주·직원 흐름, 권한, 자료 양식, AI 연결
- [예측 모델](docs/model.md): 입력과 출력, 학습 자료, 검증 결과, 재현 방법
- [배포](docs/deployment.md): 서버 구성, 자동 배포, 복구, 모바일 앱 빌드

## 자료와 라이선스

- 코드: [MIT License](LICENSE)
- 날씨: [Open-Meteo](https://open-meteo.com/) 예보·과거 재분석 (CC BY 4.0)
- 주소 검색: [Photon](https://photon.komoot.io/) · © OpenStreetMap contributors
- 글꼴: SUIT Variable, SIL Open Font License 1.1 ([apps/web/public/licenses/SUIT.txt](apps/web/public/licenses/SUIT.txt))
- 일반 매장용 TFT는 디미고사회적협동조합 매점의 POS 판매로 학습했습니다. 원본 판매 자료는 이 저장소에 포함하지 않습니다.
- Walmart 모델과 평가 자료는 Kaggle "Walmart Recruiting II: Sales in Stormy Weather" 대회 자료에서 만들었습니다.

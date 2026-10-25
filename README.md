# 화개장날 · Hwagae Jangnal

화개장터 팀의 소상공인 판매 예측·재고 확인·발주 안내 웹앱입니다.
웹·API와 Ubuntu 서버의 GitHub Actions 배포가 연결되어 있습니다.
점주·직원 로그인, 여러 매장, CSV·Excel·직접 판매 입력, SQLite 저장,
실시간 날씨, 7일 예측, 만료일별 재고 입력, 발주 계산·수정·저장·CSV/Excel 내보내기를 지원합니다.

- **일반 매장:** 모든 매장이 **실시간 예보 TFT**로 예측합니다. 요일 기준선은 비교·테스트용으로만 남아 있습니다. 새 TFT는 합성 자료로 학습한 실험 모델이고, 실제 7일 기온·강수 예보를 입력받습니다.
- **자료 가져오기:** 일반 매장을 만든 뒤 상품·판매·재고 XLSX를 직접 확인·저장합니다. 제공 자료는 기존 Walmart TFT와 실제 미국 날씨에 연결됩니다. [점주 시작 안내](docs/merchant-upload.md)를 따르세요.
- **TFT 모델 체험:** 모델 환경이 준비되면 Walmart의 고정 과거 표본으로 실제 TFT 추론을 실행합니다. 마지막 관측 날씨를 7일 유지하는 가정이며, 한국 매장 발주에 적용하지 않습니다.

실제 점포의 미충족 수요·폐기 감소·이익 개선과 실시간 예보의 추가 효과는 검증하지 않았습니다.
[현재 구현 현황](docs/implementation.md)과 [3분 시연 안내](docs/demo-runbook.md)를 먼저 확인하세요.

## 개발 환경

- Node.js **24 LTS 권장**, 22 이상 필요 (`.nvmrc`: 24)
- npm 11 계열
- Python **3.14** (`.python-version`, `pyproject.toml`에 명시)
- TFT 체험 선택 사항: 별도 **Python 3.11** CPU 추론 환경
- uv **0.10.6 이상**

API는 `.venv`의 Python 3.14를 사용합니다. TFT는 `.model-venv`의 Python 3.11에서
별도 프로세스로 실행하므로 API 잠금 파일에 학습 패키지를 추가하지 않습니다.
모델 설치와 연결은 [모델 규약](docs/model-contract.md), 학습 환경과 평가 자료는
[ML 인수 안내](ml/README.md)를 따릅니다.

## 처음 시작

저장소 루트에서 실행합니다. 두 개발자는 각자 PC에서 동일하게 실행하세요.

```bash
npm ci
npm run setup:env
uv sync --locked
```

`uv sync`는 필요한 Python 3.14가 없으면 다운로드할 수 있습니다.
`setup:env`는 아래 파일이 없을 때만 예제 파일에서 복사합니다.
기존 설정을 덮어쓰지 않습니다.

- `apps/web/.env.local`: 브라우저에서 접근할 API 주소
- `apps/api/.env`: 로컬 웹의 CORS 허용 주소

`.env` 파일은 커밋하지 않습니다. 설정 항목이 추가되면 `.env.example`에
이름과 비밀값이 없는 예시만 반영하세요.

## 로컬 실행

터미널을 두 개 열어 각각 실행합니다.

터미널 1 - 웹:

```bash
npm run dev
```

터미널 2 - API:

```bash
npm run dev:api
```

| 서비스 | 주소 |
| --- | --- |
| 웹 | http://127.0.0.1:3000 |
| API 상태 확인 | http://127.0.0.1:8000/health |
| API 문서 | http://127.0.0.1:8000/docs |

기본 로컬 샘플은 **점주 체험** 또는 **직원 체험** 버튼으로 로그인할 수 있습니다.
운영 환경에서는 배포 담당자가 관리하는 계정을 사용합니다. 운영 로그인 정보는 문서·Git에 기록하지 않습니다.
직원은 동명점에만 소속되어 있으며, 점주만 최종 확정·내보내기가 가능합니다.
`/health`는 API 상태를 확인합니다. TFT 준비 상태는 로그인 후 **TFT 모델 체험**에서 별도로 확인합니다.
재고 입력 전에는 예측만 표시하고 발주량은 비워 둡니다.
두 서버는 로컬 PC에서만 접근하도록 `127.0.0.1`에 바인딩합니다.
종료는 각 터미널에서 `Ctrl+C`를 누릅니다.

`npm run dev:web`도 웹 실행에 사용할 수 있습니다.

3000 또는 8000 포트를 사용 중이라면 기존 프로세스를 먼저 확인하세요.
포트를 바꾸면 실행 명령, API 주소, CORS 허용 주소도 함께 맞춰야 합니다.

## 검증

```bash
npm run check
npm run build
npm run test:api
```

- `check`: Next.js 라우트 타입 생성 및 TypeScript 검사
- `build`: 웹 빌드
- `test:api`: 인증·권한·파일·DB·예측·발주·내보내기·외부 실패 경계 테스트

CI에는 Python 3.11의 ML 전처리 검사도 있습니다. 체크포인트 없는 CI를 실제 TFT 추론 검증으로 간주하지 않습니다.
모델 파일이 준비된 배포에서는 실제 체크포인트의 smoke test와 전체 ML 테스트를 통과해야 새 코드를 활성화합니다.

`npm run build`는 웹 개발 서버를 종료한 뒤 실행하세요.
새 패키지를 추가하면 해당 잠금 파일도 함께 커밋합니다.

## 역할과 폴더

```text
apps/
  web/                 Next.js + TypeScript
  mobile/              Capacitor Android · iOS 앱
  api/
    app/               FastAPI
    tests/             API 통합 테스트
ml/                    Colab 전처리·학습·평가·추론 작업 공간
docs/api-contract.md   웹·API·모델 사이의 공통 규약
scripts/setup-env.mjs  로컬 환경 파일 초기화
```

| 담당 | 작업 경로 |
| --- | --- |
| API·웹 담당 | `apps/api/`, `apps/web/` |
| Colab·모델 담당 | `ml/` |
| 사전 합의 후 수정 | `docs/`, 루트 설정, 잠금 파일 |

브랜치는 `feat/작업명` 또는 `chore/작업명`으로 만들고, PR 리뷰 후 `main`에 합칩니다.
같은 파일을 수정할 때는 먼저 공유합니다.

## 의존성 관리

- 웹 패키지: `npm install <패키지> --workspace @hwagae/web`
- API 패키지: `uv add <패키지>`
- API 개발 도구: `uv add --dev <패키지>`
- 모델 추론 패키지: `ml/requirements-inference.txt`를 별도 모델 환경에 설치
- 학습 환경 기록: `ml/metadata/training_environment.json`, `ml/notebooks/environment-freeze-training.txt`

`package-lock.json`과 `uv.lock`은 커밋 대상입니다.
`node_modules/`, `.venv/`, `.model-venv/`, `.next/`, 로컬 `.env`, 큰 데이터와 모델 파일은 제외합니다.

## 기획 문서

- [현재 구현 현황](docs/implementation.md): 지금 제공하는 기능·수정 위치·한계
- [3분 시연 안내](docs/demo-runbook.md): 준비·시연 순서·실패 복구·리허설 기록
- [기능 명세서 v0.3](docs/functional-spec.md): 초기 요구와 설계 제안. 완료 여부는 현재 구현 현황을 따름
- [요구사항 인터뷰 기록](docs/requirements-interview.md): 답변 1~17과 남은 질문 18~34
- [API 연결 규약](docs/api-contract.md): 현재 구현된 API와 향후 합의 항목
- [모델 연결 규약](docs/model-contract.md): 실제 TFT 시연 설정·인수 상태·일반 매장 연결 계약
- [Ubuntu CI/CD](docs/deployment.md): Docker 없는 배포 구성·운영 확인 기록·복구
- [Android · iPhone 앱](docs/mobile-app.md): APK 설치·iOS 빌드·모바일 기능 확인

직접 자료 업로드: [점주 시작 안내](docs/merchant-upload.md). `uv run python scripts/make-merchant-data.py --output <폴더>`로 전달용 자료를 만들 수 있습니다.

서비스 운영자가 모든 매장이 함께 쓰는 AI 게이트웨이·모델·추론 강도와 자동 전환 순서를 설정합니다. [AI 연결 설정](docs/ai-settings.md)을 참고하세요.

서비스 운영자의 계약·점주 초대·계정 관리, 주소 검색과 반응형 화면은 [운영자 콘솔 안내](docs/operator-console.md)를 참고하세요.

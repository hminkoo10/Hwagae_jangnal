# 화개장날 · Hwagae Jangnal

화개장터 팀의 날씨 기반 소상공인 발주 안내 웹앱입니다.
현재는 **웹·API가 연결된 로컬 기능 뼈대**를 사용할 수 있습니다.
점주·직원 로그인, 여러 매장, CSV·Excel·직접 판매 입력, SQLite 저장,
실시간 날씨, 7일 예측, 만료일별 재고 입력, 발주 계산·수정·저장·CSV/Excel 내보내기를 지원합니다.
기본 예측은 **날씨를 사용하지 않는 요일 기준선**이며 실제 ML 모델은 팀원이 연결할 영역입니다.
처음 생성하는 매장·판매 자료는 가상 샘플입니다. 공개 자료의 실제 예측 성능을 검증한 상태는 아닙니다.

## 개발 환경

- Node.js **24 LTS 권장**, 22 이상 필요 (`.nvmrc`: 24)
- npm 11 계열
- Python **3.14** (`.python-version`, `pyproject.toml`에 명시)
- uv **0.10.6 이상**

uv는 이 프로젝트에 별도 Python 3.14 가상환경을 사용합니다.
전역 Python 패키지를 변경할 필요가 없습니다.
TFT를 비교할 경우 사용하는 PyTorch Forecasting의 현재 지원 범위가
`>=3.10,<3.15`이므로 3.15 대신 3.14를 선택했습니다.
Colab 학습 환경의 Python·GPU 패키지 버전은 별도로 기록합니다.

지원 범위 출처: https://pypi.org/project/pytorch-forecasting/

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

웹에서 **점주 체험** 또는 **직원 체험**으로 로그인할 수 있습니다.
기본 계정은 `owner@hwagae.local`, `staff@hwagae.local`, 비밀번호는 `hwagae-demo`입니다.
직원은 동명점에만 소속되어 있으며, 점주만 최종 확정·내보내기가 가능합니다.
`/health`는 서버 상태를 확인합니다. 재고 입력 전에는 예측만 표시하고 발주량은 비워 둡니다.
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

`npm run build`는 웹 개발 서버를 종료한 뒤 실행하세요.
새 패키지를 추가하면 해당 잠금 파일도 함께 커밋합니다.

## 역할과 폴더

```text
apps/
  web/                 Next.js + TypeScript
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
- Colab 학습 패키지: 학습 환경에서 검증 후 `ml/requirements.txt`로 별도 관리

`package-lock.json`과 `uv.lock`은 커밋 대상입니다.
`node_modules/`, `.venv/`, `.next/`, 로컬 `.env`, 큰 데이터와 모델 파일은 제외합니다.

## 기획 문서

- [기능 명세서 v0.3](docs/functional-spec.md): 확정 요구, 화면별 처리·완료 조건, 설계 제안
- [요구사항 인터뷰 기록](docs/requirements-interview.md): 답변 1~17과 남은 질문 18~34
- [API 연결 규약](docs/api-contract.md): 현재 구현된 API와 향후 합의 항목
- [모델 연결 규약](docs/model-contract.md): Colab 담당자가 제공할 입력·출력·전달물
- [구현 현황](docs/implementation.md): 수정할 파일과 초기 정책·한계
- [Ubuntu CI/CD](docs/deployment.md): Docker 없는 배포 구성, 실제 서버 연결은 대기
